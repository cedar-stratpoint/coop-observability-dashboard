# QA Nov 26: store code misreads, p30 version flip, Legacy relabel flag

Status: BUILT on fix/qa-store-version-relabel (PR to staging). Prod waits for an explicit ask.

## Findings (verified on Nichido Staging + prod uploads)

1. **Store code misread, unflagged** (QA "B p01 V1", "B p05 LEGACY").
   Written 2414 = SM CENTER PULILAN (in registry). Reads: 2944, 2410 (QA uploads), 2494, 2140
   (full scans Scan2026-11-20_115129 p1/p5, staging + prod). Classifier `store_name` was right every
   time ("Watsons SM Center Pulilan"). `snapStoreCode` (goldline-segment.ts) only corrects a unique
   distance-1 neighbour: 2410 is distance 1 from 2413/2414/2415 → `ambiguous`; 2944 is distance 2 →
   no match. Snap status + candidates are persisted in `classification.store_snap` but
   `getPageSuggestion` (goldline-data.ts) drops them, so upload-review.tsx shows
   "Coop read Store 2944 on this page" with no warning, page conf 92%.
2. **p30 version flips V1/V2** (QA "A p30"). Full-scan copy (Scan2026-11-20_114605 p30) classified
   v1 @0.6 on staging; standalone QA copy v2 @0.6; prod v2 @0.5. Printed layout = Delivery first = V2.
   Read logs have no `anchored` detail → locator was inconclusive (not col 1/4) AND classifier
   < ANCHOR_MIN_CONFIDENCE 0.75 → free read with `cls.version` taken as is. Locator result isn't logged
   on the free path. Low version confidence never surfaces.
3. **Legacy relabel** (QA "open question", San Pablo p7). Stockroom/Drawer/Selling labels are intended
   (PR #685, arithmetic layout `legacyPageLayout`). Gap: `headers_written_over` (→ `column_changed`
   review mark) is only requested by the P1 anchored V1/V2 read. `MARKS_PROMPT_LEGACY` and the free
   V1/V2 read never ask, so "Columns changed" never fires on Legacy.

## Decisions (user, 2026-11-26)

- Flag scope: **relabelled headers** (BA writes own column names over printed headers). Not digits
  crossing column lines.
- Tone: **FYI** (existing `column_changed`, "Check the columns"), not Needs you.
- Store: **auto-correct and flag** when the name clearly matches a nearby registry store
  ("Corrected from 2944 using the store name"), reviewer can undo.

## Fixes

- **F1 Name-aware store snap** (pure, goldline-segment.ts + tests). Normalize name (strip
  "Watsons", punctuation, case; registry names are truncated to 20 chars so prefix/token match).
  Code not in registry + exactly one registry store within edit distance ≤2 whose name matches →
  status `corrected` with `by: 'name'`, `from`. Code exact but name strongly matches another store →
  keep code, status `name_mismatch` + candidate. Registry read needs `name` as well as `store_code`
  (knownStoreCodes → knownStores). Bundle pass: pages of one scan with the same name converge on one code.
- **F2 Surface store doubt**. getPageSuggestion returns snap status/from/candidates; Store field shows
  a flag for corrected / ambiguous / unknown / name_mismatch ("Coop read 2944, which isn't a known
  store. Did you mean 2414 · SM Center Pulilan?"); page confidence capped; a review mark so it lands in
  the Flags hub. No dashes in copy.
- **F3 Version check**. Log locator output on every read. Inconclusive → one retry. Still inconclusive
  and classifier < 0.75 → "Form version unsure" flag with the existing version preview + V1/V2 picker.
- **F4 Legacy relabel flag**. Add `headers_written_over` to the Legacy read prompt + schema, and to the
  free V1/V2 read. Deterministic backstop: Legacy page with `layout === 'locations'` →
  `column_changed` even if the reader misses the handwriting. Review table shows the printed header
  under each label (Stockroom, printed "Beginning Inventory"). Kind stays FYI.

## Rollout

Staging (GOLDLINE_READ_MARKS already ON there). Re-read QA pages B p01, B p05, A p30, San Pablo p7 to
verify. Prod: needs GOLDLINE_READ_MARKS ON + optional re-snap backfill of existing pages; on ask only.

## Built (2026-11-26) and what changed from the plan

- F3 root cause was not only "inconclusive": `locateDeliveryColumn` had max_tokens 500 and the
  model's thinking used all of it on p30 (stop_reason max_tokens, 499 to 500 thinking tokens, no
  text), so it returned null. With room it then misread faint headers ("Beginning Inventory,
  Delivery, Sales", Delivery 4 = V1). Fix: cap 4000 + a printed-numbering cue
  (`highest_column_number` 6 = V1, 5 = V2; `unnumbered_data_column` true = V2), which wins over the
  Delivery position. Probe on 8 staging pages: both p30 copies V2 by numbering, 3 V1 + 3 V2 known
  pages unchanged. The reviewer V1/V2 picker was NOT built (needs a forced-version re-read); the
  page gets a "Form version unsure" note + mark instead.
- F1 bundle convergence pass not needed: each page resolves to 2414 on its own by name.
- F2 review mark: kind 'other' (no new SQL), one per page, reason joins store + version doubts.
- Live re-check in getPageSuggestion and applyStoreRegistry means existing pages show the fix
  without a backfill; the stored store_snap on old pages is unchanged until re-read.
