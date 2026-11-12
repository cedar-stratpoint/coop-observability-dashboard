# Template-anchored inventory extraction

**Status:** PLAN (not built) · **Date:** 2026-11-12 · **Area:** Goldline / Nichido scan reading (`src/goldline-extract*.ts`, `src/goldline-read-pipeline.ts`)

> One line: stop asking the AI to re-read and re-type every product row. Make the pre-printed form a fixed template, and have the reader **only fill in the handwritten numbers** for each known row. Fewer drops, no inventions, lower cost.

---

## 1. Why

A per-file QA pass on the 98-page October Watsons scan found two failure modes, plus number misreads:

| Failure | Example from QA | Count |
|---|---|---|
| **Dropped rows** (known printed rows skipped, several marked O-S) | SM San Pablo page (eye shadow / lip): 67 read vs 71 printed, 4 rows dropped (MUSE, NGFEP, MPMLSCB06, MPMLSCB07); SM Sta Rosa: ELIF3125B dropped | 6 rows across 3 forms |
| **Invented rows** (rows returned that are not on the paper) | Davao page 79: 67 rows vs 58 on scan; 9 TRUE COLORS rows invented at ~70% conf | 9 rows |
| **Misread numbers** (row present, value wrong) | Davao FBPP01/02: a computed sum overrode the written value; IPSLS05 handwritten drawer count left blank | several |
| **Version mis-tagged** (wrong column map picked) | A separate blind version-tag check of **12 of 98 pages**: 2 V2 pages tagged V1 (pages 5, 80), 1 V2 form left untagged (page 92). Only 12 checked → more likely wrong. | 3 of 12 |

**Root cause.** Today the extractor free-generates one JSON object per row it *thinks* it sees, and the per-page item list (`MANIFESTS`) is handed to the model only as a **loose reference dictionary** (the V1/V2 prompt literally says: don't include an item just because it is in the reference list). So the model decides the row set itself → it skips rows it reads as empty/O-S, and sometimes adds rows pulled from the dictionary. It also re-transcribes every `code` + `product` on every page, which:
- costs output tokens (output is ~85% of the per-page bill), and
- is what truncated the densest page (page 23 hit the 32k-token output cap, since it emits one object per row).

**Key observation:** the **Legacy** path already does the right thing — it iterates the manifest and tells the model "read a value or null for each row, in printed order." The work is making **V1/V2** behave the same, and hardening the templates.

---

## 2. The core shift

Treat the per-page printed master as an **authoritative template**. The model never transcribes product names/codes (we already have them). It reads **only the handwritten number cells for each known row, in printed order**. Output is numbers aligned to the template.

Consequences, by construction:
- **No dropped rows** — every template row is always emitted (blank/O-S → null/0).
- **No invented rows** — the row set is fixed; the model cannot add to it.
- **Lower cost** — output drops the code+name per row (the bulk of the tokens).
- **No truncation** — numbers-only output is far under the token cap, so the page-23 class of failure disappears.

---

## 3. Design

### 3.1 Authoritative templates — Phase 0 (the foundation)

- **One template per page** (decision: the printed form is fixed and stable across stores). Each template is **version-dated**, so a deliberate Nichido catalog revision just creates a new dated template, selected by the form's period.
- Each template mirrors the form **exactly**, matching the review grid: ordered rows carrying `code`, `product`, the **group header + printed price** (e.g. `HD Serum Gel Concealer · ₱268`, `Ultra Stay Matte Liquid Lip Color · ₱225`), in printed order.
- **Structural fidelity (required).** The template is a faithful structural map of the printed page per version, not a flat word list:
  - **Column layout per version** with exact positions and which columns are handwritten-read vs derived (V1 three-location, V2 delivery-first, Legacy 7-column incl. the two deducted).
  - **Every row in printed order**, each typed as `group_header` or `item`. A `group_header` is the **shaded black band** on the form (e.g. "ULTRA STAY MATTE LIQUID LIP COLOR"): it carries the group name + printed price and has **no count cells**; `item` rows carry `code` + `product`.
  - Group bands and row skips are preserved as structure, so the reader fills the right cell at the right position and the digitized grid renders the same groups/order as the paper. A structural check (group headers land where expected; item-row count == template) guards alignment.
- **Seed + verify:** today's `MANIFESTS` (pages 1–5 = 43 / 71 / 60 / 68 / 26 rows; page 6 = out-of-scope sales report) is the seed and is already close — the QA'd San Pablo page matched the 71-row page-2 manifest exactly. Phase 0 **enriches** it (group headers + prices) and **human-verifies each page once** against the source-of-truth master.
- **Verify the per-version question** (decision: not sure, verify from masters). Compare the V1/V2/Legacy masters per page. If the product set is identical and only the column layout differs (the code's current assumption) → one template per page. If the set differs → split into per-`(version, page)` templates. Treat this as a checked step, not an assumption.
- **Storage:** lean toward an `inventory_templates` table (version-dated rows), so Coop can maintain it without a deploy, with the existing **source-of-truth viewer** as the editing/review UI. Code constants are the fallback.

### 3.2 Fill-the-template extraction — Phase 1

- Give the model the ordered rows + the **version's column layout**; instruct: *for each row in order, read only the handwritten cells (STK / DRW / SELL / DLV / END, or the Legacy columns); null if blank or illegible; never add, drop, reorder, or rename a row.*
- **Output schema aligned to the template:** per row, the index/code and just the column numbers + a per-row (ideally per-cell) confidence. No names/codes in the output.
- **Chunk dense pages** (e.g. rows 1–40 / 41–80) to bound output further and sharpen accuracy — optional, config-gated.
- **Column mapping per version** (already detected in Phase 0 classify): V1 three-location (delivery col 4), V2 delivery-first (col 1), Legacy 7-column (two deducted columns).

### 3.3 Deviations: keep all rows + capture extras (decision)

- Every template row is **always** emitted; blank / O-S → null/0, **never dropped**.
- A small separate field/pass captures any **handwritten row not on the template** (write-ins), flagged for review — so write-ins are not lost, but they don't pollute the anchored read.
- **Validation:** assert emitted row count == template length; any gap is a hard flag, not a silent loss.

### 3.4 Number accuracy

- Instruct: *read the **written** ending value; do not compute or override it with a sum* (fixes the Davao sum-over-written finding).
- Per-cell confidence; low-confidence cells flagged for review. With names off the table, the model's attention is fully on the digits.
- Optional cross-check: END vs STK + DRW + SELL — **flag** a mismatch, never auto-correct.

### 3.5 Handwritten price overrides & annotations (new requirement)

Discovered on page 1: the group **Ultra Stay Matte Liquid Lip Color** is pre-printed at **₱225.00**, and a BA handwrote **180** against that line — a price override the BA is asserting. Coop should recognize and flag this. This occurs elsewhere in the 98-page scan and will recur.

- The template already carries the **printed price** per group (from 3.1).
- The reader **also looks for a handwritten price** near a group/row and records it as a **candidate** with its location; it never overwrites the printed price.
- **Discrepancy flag:** a handwritten price that differs from the printed one (225 → 180) flags the group/row "price override, needs review," storing both `printed_price` and `written_price`.
- **Reflected in the digitized form:** the grid shows the printed price with the handwritten value **badged and flagged** (like per-cell review flags today), and **Coop can confirm or dismiss** it. Confirmed overrides can feed back as a correction signal.
- Generalizes into a small **handwritten-annotations** capture that also carries the write-in products (3.3) and O-S marks — any hand mark beyond the number cells is captured and flagged, not lost. It stays a **candidate** for human confirmation (a margin price note vs a misplaced quantity is ambiguous, which is why Coop confirms).

### 3.6 Cost impact

Output tokens are ~85% of the current per-page cost and scale with `rows × (item code + product name + numbers)`. ("name" here is the **product name** — Cashmere, Warm Oat — not the BA; the BA name and store header are read once per page, not per row.) Dropping item code + product name from the output should cut per-page output substantially and removes the truncation failure. Measured baseline (from the new `read_logs.detail.usage` token logging): a full form page averages ~11.6k output tokens today. A numbers-only schema should be a fraction of that. **Quantify precisely in Phase 1** once the output schema is fixed, with a before/after on the same pages.

### 3.7 Classification: version accuracy + decision log (critical)

Classification is **step one** of the read: it decides a page's **version** and **form page**, which selects the template. A wrong choice means the whole page is read against the wrong column map. **A second QA pass found this is already happening**: a blind version-tag check of 12 of 98 pages found **2 V2 pages tagged V1** (pages 5, 80) and **1 V2 form left untagged** (page 92). Only 12 were checked, so more are likely mis-tagged.

**Why it's the highest-risk error:** V1 and V2 are the same form except Delivery is **column 4** in V1 and **column 1** in V2. Tag a V2 page as V1 and every count is read from the wrong column. So classification correctness is a **prerequisite** for the template-anchored approach, not just an input.

**What the plan does:**
- **Harden the version cue.** The deciding signal is the Delivery column's position in the printed header; make the classifier read that position as an explicit V1-vs-V2 test (not a guess). Untag non-forms correctly (page 92 was a V2 form left untagged).
- **Confidence gate.** A low-confidence or self-disagreeing classification is flagged for human confirmation before the read commits — never a silent wrong template.
- **Set-aside safety net (retry read).** Today a page classified `sales` or `blank` is rejected (set aside) in `runInventoryRead` with **no retry** — so a real inventory page misread as sales/blank is silently lost. Add a second-chance read: a **low-confidence sales/blank reject triggers a blind re-read** (whole page + a zoomed, straightened header band, the QA's method) before it is set aside, and the review UI keeps a **"this is a form, re-read it" recovery action** on set-aside pages. (Distinct from the existing `goldline_reap_stalls` reaper, which only retries reads that *timed out*, not ones wrongly set aside.)
- **Version-tag accuracy eval.** Run the QA's method (blind re-read vs tag, exact match, `coop-ocr-eval/reference_forms/` as the yardstick) across **all 98 pages** as the Phase 1 baseline to beat.

**Decision log (debug the rest).** Each page records **how it was classified and why**, durably, to debug residual failures without re-running.

- **Decision:** version (V1 / V2 / Legacy), form page (1 to 6), page kind, orientation, store, each with a confidence.
- **Evidence:** the printed column headers read, the footer page number, and the version cue used (e.g. "Delivery in column 4, so V1"; "two Deducted columns, so Legacy").
- **Mismatches flagged:** footer page number vs detected page, unknown/rotated layout, low confidence — exactly where a misclassification hides.
- **Storage + surface:** extend the classifier output + `buildPageClassifyPrompt` / `PAGE_CLASSIFY_SCHEMA` to return its evidence; log per page (building on today's `read_logs.detail.classify`); show a per-page **classification debug panel** in the review UI.
- **Why it matters here:** a template-anchored read is only as good as the template it anchors to. If a V2 page is misread as V1, every cell is read from the wrong column. This log turns "the numbers look wrong" into "page 57 was classified V1 at 61% on a weak footer read," which is debuggable.

---

## 4. Rollout (staging-first, additive, measurable)

- **Phase 0 — Templates.** Digitize + human-verify authoritative templates per page (+ group headers / prices); decide the version split; land the `inventory_templates` store and wire the source-of-truth viewer to edit it.
- **Phase 1 — Fill-the-template extractor.** Template-anchored V1/V2 read (mirror Legacy), numbers-only schema, extras + annotation + price-override capture, validation, and the classification decision log (3.7). Behind a flag. Re-run the 98-page Nichido Staging scan and measure **drops / inventions / misreads / cost** before vs after (the QA findings are the baseline to beat).
- **Phase 2 — Accuracy + promote.** Chunking, written-value rule, confidence thresholds; then promote staging → prod (additive, reviewed `.sql` in one pass).

**Success = the QA findings go to zero:** 0 dropped rows, 0 invented rows, price overrides surfaced and flagged, and a measurable drop in per-page cost, on a re-run of the same scan.

---

## 5. Open decisions (to settle during build)

1. **Per-version templates?** Verify whether the printed product set differs by version or only the columns do (3.1).
2. **Template storage:** `inventory_templates` DB table (Coop-maintainable) vs code constants.
3. **Price scope:** is a handwritten price an override of the whole group or a single SKU? Capture location so review decides.
4. **Chunking:** whether dense pages read in one pass or in row-ranges.
5. **Output schema shape:** index-aligned array vs code-keyed map (affects validation + cost).

---

## 6. Current code touchpoints

- `src/goldline-extract.ts` — `MANIFESTS` (per-page row list), `ManifestItem`, `buildManifestPrompt` (V1/V2, dictionary-mode today), `EXTRACTION_SCHEMA`, `COLUMN_KEYS`.
- `src/goldline-legacy-extract.ts` — `buildLegacyManifestPrompt` ("value or null for each row") + `LEGACY_EXTRACTION_SCHEMA` — the reference pattern to generalize.
- `src/goldline-extract-run.ts` — `extractInventoryPage`, `createMessageWithFallback` (streaming), `max_tokens`, token-usage capture.
- `src/goldline-read-pipeline.ts` — `runInventoryRead` (classify → read → save), `read_logs` write (cost/accuracy telemetry).
- `src/goldline-segment.ts` — version/page classification (feeds column mapping); `buildPageClassifyPrompt` / `PAGE_CLASSIFY_SCHEMA` (in `goldline-extract.ts`) + `classifyPage` (in `goldline-extract-run.ts`) extended to return + log classification evidence (3.7).
- Source-of-truth viewer (per-version reference UI) + the per-file review grid — the surfaces that reflect the digitized form.

---

## 7. Regression safety (no regressions)

Additive and flag-gated, so with the flag off the current reader is byte-for-byte unchanged. Invariants we hold, and the gates that prove it:

**Invariants:**
- **Flag off = today's behavior.**
- **Legacy reads unchanged** — shared `MANIFESTS` / schema changes must not alter Legacy output.
- **Downstream shape preserved** — `saveExtraction`, the review grid, inventory commit, totals, and `goldline-ba-reconcile` still get the same `ExtractedPage` / row shape; new fields (extras, price notes, template id, classification evidence) are additive.
- **Set-aside stays correct** — the ~28 blanks/sales correctly set aside must still be; the new retry must not read a real blank/sales as a form.
- **Pump + status unchanged** — idempotent claim, status transitions, `read_logs`, `revalidateTag`, server-upload pump; retries bounded (no loops).
- **Isolation** — changes stay in Goldline modules (`test/goldline-nichido-guard.test.ts` green); archive/POS untouched.

**Gates (before promote):**
- `npm run typecheck` + `npm test` green, plus new unit tests (template fill, validation gate, price override, set-aside retry, version cue).
- **Golden regression set = the 98-page Nichido Staging scan.** Re-run and diff before vs after: 0 new drops, 0 new inventions, version-tag accuracy ≥ today, set-aside recovery works, cost not worse.
- **Value-level diff:** the ~94 previously-correct pages must read the **same numbers**, not just the same row counts. Any changed cell is reviewed.
- **Side-by-side:** run old and new extractor on the same sample behind the flag, diff the numbers, review differences before promote.
- Staging-first, additive SQL; promote only when every gate is green.
