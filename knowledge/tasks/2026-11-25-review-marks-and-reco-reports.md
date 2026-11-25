# Review marks, manual flag, Add row, Reco A to D reports (Nichido only)

Plan, 2026-11-25. Source: Taska meeting "Nichido OCR edge cases and flagging rules with Syl"
(564af8f6), tasks NICH-36, NICH-42, NICH-43. Goldline/Nichido tenant only; Coop/Zoomy untouched.
Staging first (Nichido-Supabase-Staging `jcqlnrvplaapvcxyhcns`), prod only on a later ask.

## Decisions (2026-11-25, with the user)

| # | Question | Decision |
|---|---|---|
| D1 | Syl's Reco A to D vs the Reconcile states | **A** = Retire, sell through (`phasing_out`) · **B** = Send to accounting (`accounting`) · **C** = both Watsons-owned states: Watsons to audit (`no_sales`) + Report to Watsons (`watsons_audit`) · **D** = Add to form (`form_missing`). Check delivery / Flag to retire / Keep stay as extra states. |
| D2 | Do the new flags count against the BA? | **No.** New, separate **review marks**, keyed by file + page + row. Never add BA points. Existing BA flags (`flags` table, messy handwriting / incorrect total / padding) unchanged. |
| D3 | How are notes, relabelled columns, Damage detected? | **Reader detects + reviewer backup.** The existing read returns yes/no markers per row (no note text). Reviewer can add or clear a mark by hand. |
| D4 | Add product row on Review? | **Build it now.** |

Syl's rules from the chat (Nov 25):
- BA notes/revisions: flag that an annotation exists; do NOT capture the note text. Show file, page, row.
- BA changed/relabelled columns (e.g. Page 7 of 98, "Stockroom / Draw / Selling" written over "Beginning / Delivery / Beg+Del"): note which file; fixed manually.
- "Damage" written in Ending Inventory (e.g. Page 11 of 98, TCES17313 Gold Frost, TCES17317 Electric Pink): same, flag file/page/row.
- Illegible handwritten numbers (e.g. "3 | 22 | 25 ata"): flag, don't guess. "add manual flag".

## Today (staging, verified in code)

- Reader row schema already has per-cell `marks` (`overwritten | unclear | straddle`) + `confidence` + `alt` (`src/goldline-extract.ts`). Unclear marks already raise the BA `unreadable` flag (messy handwriting) in `src/goldline-checks.ts`. That stays as is.
- Each scanned page is one `uploads` row (`batch_id`, `batch_name`, `page_no`, `form_version`, `classification`), reader output in `extractions`, commit via `commit_batch` into `inventory` (unique store + item + period).
- Review drafts live in the browser (`src/review-draft.ts`, keyed by `readingId`), one values matrix per page.
- Reconcile (`/stock/audit`, `src/goldline-audit.ts` + `-data.ts`) has the 8 states, store/state/why/search filters and a streamed CSV (`/api/goldline/audit-export`).
- `/flags` is the BA flag queue (tile per store/BA/month).

## S0 · `review_marks` table (foundation for NICH-42, NICH-36, NICH-43 §3/§4)

Additive SQL on Nichido Staging (`supabase/nichido/p5_review_marks.sql`):

```
review_marks
  id uuid pk, company_id text fk,
  upload_id uuid        -- the page (uploads row) = file + page
  batch_id uuid,        -- the scan
  item_code text null,  -- the row; null = whole page (e.g. column relabelled)
  field text null,      -- stockroom | drawer | selling_area | delivery | ending_on_hand | null
  kind text check in ('note','column_changed','damage','illegible','added_row','manual'),
  source text check in ('reader','reviewer'),
  reason text null,     -- reviewer's short note (manual only); never the BA's note text
  store_code, period_start, period_end, consultant   -- snapshotted for reports
  status text check in ('open','cleared') default 'open',
  created_by, created_at, cleared_by, cleared_at
  unique (upload_id, coalesce(item_code,''), coalesce(field,''), kind, source)
RLS on, revoke anon/authenticated (service-role only, like flags).
```

- A re-read of a page replaces that page's `source='reader'` marks; reviewer marks survive.
- Shared label helper: **"File · Page N of M · Row"** = batch name or filename, page position in the scan, printed product + item code.
- Not in BA points, not in the scorecard.

## NICH-36 · Reader detects notes, relabelled columns, Damage (D3)

Behind `GOLDLINE_READ_MARKS=1` (process-wide, staging only first; off = byte-identical read).

1. Row schema adds `annotated: boolean` (handwritten note, arrow, circle or revision touching the row) and `damage: boolean` (a word such as "Damage" in a count cell; that cell returns `null`, never a guessed number). Prompt line: "Flag that a note exists; do not transcribe it."
2. Page level (classify or read): `columns_relabelled: boolean` + which printed headers were written over.
3. Page level: `added_lines: [{after_item_code}]` for product lines the BA hand-wrote between printed rows (feeds NICH-42 Add row).
4. Unclear/overwritten cell marks → also written as `illegible` review marks (BA messy-handwriting flag unchanged).
5. Write `review_marks` at read time.

Acceptance (98-page Sept scan, batch A/B vs flag off): Page 7 → `column_changed`; Page 11 TCES17313 + TCES17317 → `damage`, Ending null; the notes page (Nov 5 revision, "27pcs", "18pcs pa po") rows → `note`, no note text stored; Creamy Glow page → `added_row` after TSP01204; no new dropped rows; cost delta reported (extra output tokens are small booleans).

Does not replace the Friday missed-rows fix; it rides after it.

## NICH-42 · Manual flag + Add product row (Review page)

**Manual flag**
- Every row in the one-page review (Per file stepper) and batch review gets a **Flag** action: reason picker *Can't read number · Note or revision · Damage · Column changed · Other* + optional short note. Page-level flag for *Column changed*.
- Reader marks show as chips on the row with the same words; reviewer can clear one (kept as `cleared`, with who/when).
- A flag doesn't block commit. For an unreadable number, reviewer leaves the cell blank and flags it; the blank flows to Reconcile as "Blank on the form" (unknown, never a no).
- Writes `review_marks` immediately (server action), not into the browser draft, so it survives leaving the page.

**Add product row**
- "Add row" per category on the review page → SKU picker (catalog; that product line first, search all) → enter counts → row joins the page draft and an `added_row` mark (source reviewer) is written.
- Where the reader found an `added_lines` spot, the Add row prompt opens there pre-placed.
- Guards: SKU already on this page → jump to that row instead; SKU already counted for this store + period from another page → show the conflict before commit (inventory is unique per store/item/period).
- Draft format v2 adds `added` rows per page; `commit_batch` takes them like printed rows with `source_upload_id` (check the "exact upload set" rule accepts extra rows; extend if not).

## NICH-43 · Reports for Syl

1. **Reco A to D counts** on Reconcile: four tiles "A · Retire, sell through", "B · Send to accounting", "C · Watsons to audit", "D · Add to form" for the chosen month + store (or every store); tap = filter the table. C filter = `no_sales` + `watsons_audit` (new grouped state value `reco_c`). B counts only rows reading "Send to accounting" (sold-through rows read "Flag to retire").
2. **Reco C report**: every store, every SKU, chosen month, searchable. Two CSVs from the existing streamed export: by store line (store, SKU, product, legs, on hand) and by SKU (SKU, product, how many stores, store list, total on hand). No schema change.
3. **Flag drill-down**: each BA flag and review mark shows **File · Page N of M · Row · Why · Store · BA** and opens that page in the review stepper with the row boxed (existing row `box`). BA flags derive page/row from `source_upload_id` + `item_code`. New "Review marks" tab on `/flags` beside the BA tiles.
4. **Export flagged SKUs per store**: CSV, one line per flag or mark: Store code, Store, BA, Item code, Product, Why, Source (Coop check · Reader · Reviewer), File, Page, Row, Month, Status. Store filter or every store (sorted by store).

## Order

1. NICH-43 §1 + §2 (no schema, uses the matrix as is). Small.
2. S0 `review_marks` + NICH-42 manual flag (gives Syl a working flag fast).
3. NICH-36 reader marks (after the Friday missed-rows fix), A/B on the Sept scan.
4. NICH-42 Add product row.
5. NICH-43 §3 + §4 (need marks).

Each step: own worktree off `staging`, PR, green build, ask before merge. Dashboard `develop` and `staging` diverged, so promote by cherry-pick. CHANGELOG entry per PR. No dashes in UI copy.

## Assumptions to confirm with Syl (not blocking)

- Illegible numbers keep raising the existing messy-handwriting BA flag as today, and now also show as a review mark.
- One CSV with a store column (plus store filter) is fine for "export per store", vs one file per store.
