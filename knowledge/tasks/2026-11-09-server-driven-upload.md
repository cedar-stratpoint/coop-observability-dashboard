# Server-driven scan upload — plan

**Status:** P0 + P1 + P2 built, flagged off (2026-11-09). **Owner decisions locked:** orchestration = Supabase `pg_cron` + `pg_net`; rollout = hybrid behind a **per-company** flag (pilot Nichido); throughput = **~8 min / 98 pages** (pump `K=6` every 30s); big-PDF upload = **re-PUT on drop for v1** (no resumable/tus yet).

**Progress:** P0 = flag + `queued` status + `/upload/sign` + `/ingest` (PR #561, on staging). P1 = `/api/goldline/read-page` + the `pg_cron`/`pg_net` pump (`goldline_pump_reads`, `claimed_at`, applied to Nichido Staging via `supabase/nichido/server_upload_p1_pump.sql`) + reaper clocks from `claimed_at`. P2 = `signAndIngestScan` (signed-URL PUT + ingest) + `serverBatchProgressAction` poll + a gated server mode in the upload-queue provider (a lone scan PDF uploads once, read server-side; rows synthesized from polling; client scheduler/split/beforeunload stand down; the client path is byte-identical when off), UX = stay on Uploads and poll in place (user's choice). All inert until the pump's two vault secrets and the per-company flag are set. **Next: P3** (cutover / widen the flag); P2 still needs an end-to-end browser pass once the flag + secrets are wired on staging.

## Problem

Scan upload is **client-driven**: the browser loads the whole PDF, splits it into one PDF per page with `pdf-lib` (`src/upload-transport.ts` `splitPdfPages`), and uploads + reads each page itself (`components/analyst/upload-queue.tsx`). The queue is React state in memory. A full browser **refresh or reload wipes it**, so any page not yet sent stops; only a `beforeunload` warning guards it. Pages already sent keep reading server-side, but the remainder needs a manual re-upload. The user wants to navigate away or refresh a slow page safely.

## Goal

Upload the PDF **once**; the **server** splits and reads every page; the browser only **watches progress** (polls DB state). Refresh, navigation, tab close, and a slow page can no longer interrupt the work, because it lives in the DB, not the tab.

## Architecture (target)

1. **Whole-PDF upload straight to storage.** Client requests a Supabase **signed upload URL** and PUTs the PDF (≈114 MB) directly to the `goldline-uploads` bucket — bypassing the Next.js request-body limit. Then it POSTs one small *ingest* request (storage path + batch/company + original filename).
2. **Server split + enqueue (ingest route).** Reads page count, splits into per-page PDFs in the bucket keeping the existing `"<name> (page N of M).pdf"` naming (`splitName`), inserts N `uploads` rows at a new status `queued`, attaches them to the batch, returns immediately.
3. **Server reads every page** by reusing `runInventoryRead` (`src/goldline-read-pipeline.ts`). Orchestrated by **`pg_cron` + `pg_net`** (below).
4. **Client polls DB state.** The scan-detail / uploads views already render server state; the live in-memory queue is replaced by polling for the server path. Identical whether the tab stayed open or came back fresh.
5. **Reaper is the safety net** (already shipped, PR #554): any read whose function dies mid-flight is reset from stale `processing` to `failed` (retryable), so nothing is ever stuck.

## Orchestration: `pg_cron` + `pg_net` (locked)

On the Nichido project (Staging first):

- Enable the `pg_cron` and `pg_net` extensions.
- A Postgres function `goldline_pump_reads()` runs on a `pg_cron` schedule (every ~30s). Each tick:
  - **Claims** up to `K` `queued` inventory pages atomically — `UPDATE uploads SET status='processing', claimed_at=now() WHERE id IN (SELECT id FROM uploads WHERE status='queued' AND kind='inventory_pdf' ORDER BY created_at LIMIT K FOR UPDATE SKIP LOCKED) RETURNING id`. `SKIP LOCKED` + the status flip guarantees **no double-read** across overlapping ticks.
  - For each claimed id, fires an async HTTP call via `pg_net` to a new **read-next route** (`POST /api/goldline/read-page`), one page per call → real fan-out parallelism.
- Parallelism is tuned by `K` (pages claimed per tick) and the cron interval, bounded by the Anthropic vision rate limit and Vercel function concurrency. **Chosen default: `K=6` every 30s ≈ 12/min ≈ ~8 min for 98 pages** (balanced; comfortable headroom under the vision rate limit). `K` and the interval are configurable so we can tune without a redeploy.
- **Auth:** the read route is public, so `pg_net` must send a secret header (`CRON_SECRET` / `GOLDLINE_PUMP_SECRET`) that the route checks; it does company-scoped writes, so it is never callable unauthenticated.
- **Durability:** a claimed page that never completes (function died) is caught by the existing reaper (stale `processing` → `failed`), then re-`queued` on retry; a tick that misses is retried next tick. No work is lost.

Alternatives considered: QStash (cleanest fan-out + retries, but a new vendor) and Vercel Cron (simplest, but serial/slow). `pg_cron`+`pg_net` was chosen as durable, parallel, and DB-native with no new vendor.

## Changes by area

**DB (Nichido Staging → PROD), additive only:**
- New upload status `queued` (and `claimed_at timestamptz`) — additive to the `uploads` status set; keep `processing`/`needs_review`/`rejected`/`failed`/`committed`.
- `pg_cron` + `pg_net` extensions; `goldline_pump_reads()` function + cron schedule; a secret for the pump.

**Server (Next.js):**
- `POST /api/goldline/upload/sign` — returns a Supabase signed upload URL + the storage path for the whole PDF.
- `POST /api/goldline/ingest` — given the stored PDF, split (pdf-lib, server) + enqueue rows `queued` + attach batch; returns `{batchId, pages}`.
- `POST /api/goldline/read-page` — secret-guarded; reads one `processing` page via `runInventoryRead`; idempotent (no-op if not `processing`). `maxDuration=300`.
- Reuse: `runInventoryRead`, `saveUpload`, `createSignedUrl`, `reconcileStaleReads`.

**Client:**
- `upload-transport.ts`: add signed-URL whole-PDF upload; keep `splitPdfPages` only for the legacy path.
- `upload-queue.tsx`: for the server path, after the PUT + ingest, drop the in-memory per-page queue and **poll** the batch/scan for progress; keep the legacy client path behind the flag.
- Progress UI: the uploader's live list polls DB status (the Type/Status/Version facets already read server state).

**Flag:** a **per-company** setting (not a global env flag), so we enable it for **Nichido only** first, prove it on real scans, then widen. On → that company's PDF scans go server-driven; off → current client path. CSV / single-file uploads stay on the direct path either way.

## Key risks / design notes

- **No double-read:** the atomic claim (`FOR UPDATE SKIP LOCKED` + status flip) is the crux; without it two ticks could read one page twice (double inventory). Must be covered by a test against the claim SQL.
- **Server-side split of a 114 MB PDF** within a 300s ingest function: `pdf-lib` split is fast, but watch memory. If a scan is too large, split in bounded chunks, or make splitting itself a queued job.
- **Rate limits / cost:** cap concurrent vision reads via `K`; a runaway fan-out could hit Anthropic limits or spend. Make `K` and the interval configurable.
- **Signed-upload size/time:** a 114 MB PUT on a slow line is itself long and is the one step still tied to the tab. **v1: show upload progress, and if the single PUT drops the user re-uploads the file** (no resumable/tus in v1). It is one transfer, not 98, and the server reads — the main win — are already refresh-safe. Resumable (tus) is a fast-follow if interruptions prove common.
- **Idempotency:** `page_key` dedup already prevents duplicate pages on re-ingest; re-running ingest is safe.
- **Staging-first, additive** (workspace rule): all schema + `pg_cron`/`pg_net` land on Nichido Staging (`jcqlnrvplaapvcxyhcns`) via reviewed migration before any PROD promotion; never alter existing columns destructively.

## Phases

- **P0 — foundation (flagged off):** `sign` + `ingest` routes; server-side split + enqueue `queued`; `claimed_at` column + status. No pump yet; verify rows land `queued`.
- **P1 — pump:** `read-page` route (secret-guarded) + `pg_cron`/`pg_net` pump on Staging; reads drain `queued` → `needs_review`/`rejected`/`failed`; reaper covers deaths. Tune `K`.
- **P2 — client:** signed-URL whole-PDF upload + ingest call + progress polling behind the flag; keep legacy path.
- **P3 — cutover:** flag on by default for PDFs on Staging, soak, then PROD promotion of the migration; later remove the client splitter.

## Acceptance criteria

- Upload a 98-page scan, then **refresh / navigate away / close and reopen** the tab: reading continues and completes; counts match a non-interrupted run.
- No page is ever read twice (inventory totals match a controlled run).
- A killed read is reset and retried automatically (reaper); the scan still finishes.
- CSV and single-file uploads unaffected.

## Decisions (finalized 2026-11-09)

1. **Throughput:** balanced, **~8 min / 98 pages** — pump `K=6` every 30s (~12/min), configurable.
2. **Big-PDF upload:** **re-PUT on drop for v1** — show progress; resumable/tus is a fast-follow, not v1.
3. **Flag:** **per-company** setting, **pilot Nichido** first, then widen.

Everything above is locked; P0 can start.
