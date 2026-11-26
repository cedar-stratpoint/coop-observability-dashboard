# Nichido prod release v1.29.0 (PLAN, Nov 26)

Prod = `main` → coop-cedar.vercel.app (Vercel Git integration, v1.28.1, `5b10d245`).
Staging = `staging` → coop-cedar-staging (GitLab CI, `93ce8fae`).
Decisions (owner, Nov 26): ship all five Nichido groups below as **one release v1.29.0**;
Flags hub **on at release**; **re-read all 125** prod pages in review afterwards.

## What is on staging and not on prod (Nichido)

Checked three ways: files on staging vs main, Nichido Staging vs Prod DB, Vercel env per target.
Everything else Nichido on staging (#655 to #805) is already on prod via v1.25.0 to v1.27.0.

| # | Group | PRs | Needs on prod |
|---|---|---|---|
| 1 | Review QA fixes (San Pablo) | #808 band price flag + pick, #809 O/S read as 0, #812 printed O/S is a note, band tuning, one-click paper prices | SQL **p7** (`review_marks` kind `price`) |
| 2 | Flags hub | #822 hub, #826 tiles + paging, #827 Back to Flags + colors | env **`GOLDLINE_FLAGS_HUB=1`** on Production; needs group 1 (band price action) |
| 3 | Overview → Stores by month | #795 trend bars open /stores?month= | SQL **f2h** (`sales_by_store`, `sales_store_months`; uses s5 `sales_store_period`, already on prod) |
| 4 | Reconcile polish | #819 compact top, #821 Reco pills + hover card | none |
| 5 | Uploads filters | #814 FilterSelect pills, date-range pill, animated Filters | none |

**Not in this release (staging only on purpose):** GitLab CI deploys (#757, #765) + `vercel.json`
(`git.deploymentEnabled: false`) + health `DEPLOY_COMMIT_*`: these would switch prod off Vercel
Git deploys, a separate decision. Temporary L7 spike route (`/api/goldline/l7-spike`, staging only).
Zoomy/Coop items: #605 inventory header/filter menu, Sales "All time" default, Ask Coop
chat tweaks, Shopee missing reports, `product_channel_alias` / SKU alias CSV.

## DB state (checked Nov 26)

| | Nichido Staging | Nichido Prod |
|---|---|---|
| `review_marks_kind_check` has `price` | yes | **no** (p7 needed) |
| `sales_by_store`, `sales_store_months` | yes | **no** (f2h needed) |
| `sales_store_period` (s5) | yes | yes |
| pages in review / with saved bands | 1,474 / 75 | **125 / 0** |
| open check flags / review marks | 166 / 229 | 2 / 0 |

## Env (Vercel `coop-observability-dashboard`)

| Switch | Staging | Production |
|---|---|---|
| `GOLDLINE_FLAGS_HUB` | 1 | **set to 1 at release** |
| `GOLDLINE_READ_MARKS` (reader notes, Damage, ...) | 1 | off (kept off, Nov 25 decision) |
| `GOLDLINE_READ_BANDS/BOXES/TEMPLATE_READ/BATCH_READ/BATCH_LEGACY_COMPANIES`, `READ_P1`, `READ_UNSURE` | on | on (same) |

## Rehearsal (done Nov 26)

Cherry-picked onto `origin/main` in a scratch worktree, in this order:
`782e623b` #795 · `b755c65c` #808 · `266a82f3` #809 · `f36f5ac5` #812 · `91b46535` + `578d02e2` #814 ·
`287f276e` #819 · `d7a58c78` #821 · `e8d52928` #822 · `a7168819` #826 · `93ce8fae` #827.
Only CHANGELOG conflicts (keep main's, add one release entry). Result matches staging
file-for-file on every Nichido file; typecheck clean, 5,770 tests pass.

## Steps

1. **SQL on Nichido Prod** (additive, safe before the code): `supabase/nichido/p7_review_marks_price.sql`
   then `supabase/nichido/f2h_sales_by_store_month.sql`. The Nichido-Supabase MCP is read-only,
   so apply in the Supabase SQL editor (prod `pfwrkqsjmetibslltmok`); then verify the constraint
   and the two functions read-only.
2. **Release branch** `release/v1.29.0` off `main`: the picks above, `package.json` 1.29.0,
   one CHANGELOG release entry. PR to `main`, CI green, **owner OK to merge**.
3. **Env:** `GOLDLINE_FLAGS_HUB=1` on Production **before** the merge, so the deploy picks it up.
4. **Verify the deploy:** coop-cedar `/api/health` shows the merge commit. Owner smoke (sign-in):
   `/flags` tiles + a tile list + Open page → "Back to …"; a band page "Use ₱X / Keep ₱Y";
   Overview trend bar → Stores for that month; Reconcile top + Reco pills; Uploads filters.
5. **Re-read the 125 pages** (owner decision):
   - Pre-check on prod: list which of the 125 have saved reviewer edits or picks (a re-read replaces
     the page's read; those edits would need redoing). Report before re-reading.
   - Rehearse the bulk path on staging with 2 to 3 pages first: re-queue (`status = 'queued'`,
     clear the claim) so the pump reads them through the normal pipeline. A read is reused only
     for the same file and the same deployed commit, so after the release every re-read is fresh.
   - Prod: re-queue the 125 (owner runs the UPDATE; MCP is read-only). Reads go through the
     Batch API (`GOLDLINE_BATCH_READ_COMPANIES`), so they can take up to 24h; about $7 to $8 at
     the measured ~$0.06 a page (likely less, batch is 50% off).
   - Check: bands saved, price flags in Needs you, printed O/S rows noted, no pages stuck.
6. **Close out:** release notes in CHANGELOG (staging and main), memory, Nichido checklist only if asked.

## Risks

- Re-read replaces saved reads (step 5 pre-check covers it).
- Flags hub on prod is mostly empty until reads land (2 checks, 0 marks today); price flags appear
  as pages are re-read.
- CHANGELOG conflicts on every pick; keep main's file, write one release entry.
