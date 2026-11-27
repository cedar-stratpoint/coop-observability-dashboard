# Reopen for review, Individual Flare template row, band price wording (plan, 2026-11-27)

Status: PLAN (not built). Owner decisions taken 2026-11-27 in one session of QA on the prod
Oct 30 scan. Branch: `plan/reopen-flare-band` (off `staging`).

## Decisions (every question raised in the session)

| # | Question | Decision |
|---|---|---|
| D0 | USMLLC band: whole band written at 180, is the math right? | Yes. 17+1+2+4+10+2 = 36 pcs; 36 × 180 = 6,480 (paper), 36 × 225 = 8,100 (Coop). No change. |
| D1 | Does "Use ₱180" apply to the cell or the band? | The whole band (every code in `band.codes`), this form only, catalog untouched. **Reword the buttons** (W2). |
| D2 | 24/7 Stylo: paper total fits ₱199 not ₱248. Is it retained and put on the BA? | **Retained as a review mark, no BA point.** The BA's arithmetic is right (57 × 199 = 11,343); 199 may be a real promo. Revisit only if Nichido says off-list prices are not allowed. No code change. |
| D3 | Individual Flare (`ELIF3125B`) flagged as "Product written in" | Bug. **Add the row to the V1 page 5 template** so the reader knows it (W1). |
| D4 | Do committed pages keep their flags, and do they show on Flags? | Yes, already. Marks stay (open or cleared, with who/when); checks stay (open or resolved) and resolved checks still count. No change, except the new `withdrawn` status in W3. |
| D5 | Can a committed page be uncommitted and re-reviewed? | Not today (read-only; only delete). **Build "Reopen for review"** (W3). |
| D6 | Who can reopen? | **Anyone who can commit** (`canEditData`; store-scoped roles only for their stores), **behind a confirmation modal**. |
| D7 | Checks closed by a reopen | New status **`withdrawn`**: shown in Cleared, **skipped by the BA scorecard**. Re-commit re-runs the checks, so a real problem comes back. |
| D8 | What a reopened page comes back with | **The same read with the committed edits restored** (cells, store, period, BA, price picks, marks). No new read. "Re-read this page" stays available. |
| D9 | Rollout | Staging, verify, then **prod the same day** (release branch off `main` + cherry-pick + bump). Prod SQL still needs the owner's OK at apply time. |
| D10 | Write-up | This repo doc only. |

## Facts behind the decisions

- **Print variant (D3).** The V1 page 5 reference (`public/form-versions/v1-5.jpg`) and
  `docs/form-templates/V1/INV_FORM_V1_PAGE5.xlsx` have no INDIVIDUAL FLARE band. Some V1 prints
  do: an `INDIVIDUAL FLARE` band (₱238) with one row `ELIF3125B · 3125 (black)`, O/S printed,
  between `ELF8058` and the `ELISE FEATHER LITE LASHES` band.
  - Printed on: Oct 30 p21, p32, p40 (store 5300); Part 1 p28 (store 296).
  - Not printed on: Oct 30 p50, p56, p62 (V1, other stores) and every V2 page 5 seen
    (Oct 30 p5, p76, p94; Part 2 p11, p29; Part 1 p17). Legacy page 5 already has it.
  - Only p21 surfaced the bug; on p32/p40/p28 the reader skipped the blank O/S row.
  - The `added_row` on p50, p56, p62 is genuine: the BA handwrote "Raspberry Float" under
    Pink Champagne. Those must stay flagged.
- **Commit (D8).** `commitInventory` writes the reviewed rows to `inventory`
  (`source_upload_id` = page) and only flips `extractions.status → confirmed` and
  `uploads.status → committed`. **Edits are not written back to the extraction**, so a reopen
  must restore them from `inventory`.
- **Checks (D7).** `runChecks` marks a flag that no longer fires `resolved`; the scorecard
  (`getBaScorecard`) counts every flag regardless of status. `flags_status_check` allows
  `('open','resolved')` (p2b).

## W1 · Individual Flare in the V1 page 5 template (optional row)

Three of six V1 page 5 copies don't print the row, so it goes in as an **optional** row. A
plain row would leave a blank "not read; kept blank for review" filler, flagged, on every
copy without it.

1. `docs/form-templates/V1/INV_FORM_V1_PAGE5.xlsx`: add the `INDIVIDUAL FLARE` band (₱238)
   and the `ELIF3125B | 3125 (black)` row after `ELF8058`, marked optional (marker the
   generator reads, e.g. "optional" in a notes column; documented in `docs/form-templates/README.md`).
2. `scripts/gen-form-templates.py`: emit `optional: true`; regenerate
   `src/goldline-form-templates.generated.ts` (`GeneratedTemplateItem.optional?: boolean`).
3. Anchored read (`src/goldline-anchored-extract.ts`):
   - prompt: list the row with "printed on some copies only; return it only if it is printed";
   - `mapAnchoredToExtractedPage`: an optional row with no entry is **dropped** (no filler, not
     counted in `filledBlanks`); returned → a normal template row, `off_manifest: false`;
   - an extra matching an optional row's code or name maps onto that row instead of becoming
     an `off_manifest` write-in;
   - row indexes: keep `i` stable for the model, re-index after dropping so `first_index` and
     band flags point at the right rows; `checkBands` ignores an absent optional band.
4. `src/printed-os.ts`: `v1: {4: [...], 5: ['ELIF3125B']}` so its printed O/S stays quiet.
5. Tests: optional row absent (no row, no flag) / present (normal row, printed O/S) / returned as
   an extra (mapped, not a write-in); a non-template extra (Raspberry Float) still flagged;
   generator test that V1 p5 lists `ELIF3125B` as optional and V2 p5 does not.
6. Verify on staging: re-read Oct 30 p21, p32, p40, p50 and Part 1 p28. Expect `ELIF3125B` as a
   printed row on 5300/296 copies with no "Product written in", nothing added on p50 except the
   Raspberry Float write-in.

## W2 · Band price wording

`components/analyst/band-price.tsx`:
- Buttons: **"Use ₱180 for all 10"** (N = `band.codes.length`; "for both" when 2, plain when 1)
  and **"Keep ₱225"**.
- Helper: **"Applies to the whole band, this form only."** (replaces "For this form only.")
- No em/en dashes. The page-level "all bands" control is unchanged.
- Test the label for N = 1, 2, 10.

## W3 · Reopen for review

**UI** (`components/analyst/upload-review.tsx`, the committed banner):
- A "Reopen for review" button on the "This upload is committed." banner for roles that can
  commit (`canEdit`).
- Confirmation modal (the shared `ModalShell`), real numbers in the body:
  "Reopen page 21 for review? Its 38 counts come out of Inventory for Store 5300, Sep 1 to 15,
  and the page goes back to review with your edits. Coop's checks from this page close and
  won't count against the BA. Commit again to put the counts back."
  When some counts now come from another page: "2 counts now come from another page and stay."
  Buttons: **Reopen page** / **Cancel**.
- After reopen: the page reloads in review with a one-line note "Reopened by <name>, Nov 27".

**Server action** `reopenUploadAction({company, uploadId})` in `app/uploads/actions.ts`:
- Guards: `canEditData(ctx.role)`, store scope (same refusal as delete), upload is `committed`,
  kind `inventory_pdf`.
- Steps:
  1. Read `inventory` rows with `source_upload_id = uploadId` (store, period, consultant, cells,
     `extra.unit_price`).
  2. Restore them into the extraction (pure `restoreCommitted(page, rows)`, unit-tested): cells
     per `item_code`, header store/period/BA, rows committed but not in the read appended;
     band `use_price` kept as is. Write `rows.reopened = {at, by, restored, kept_elsewhere: [codes]}`.
  3. One transaction (RPC `reopen_upload`, SQL below): delete those inventory rows; extraction
     `confirmed → ` its review status; upload `committed → needs_review`.
  4. `runChecks(companyId, [store], {withdrawFor: uploadId})`: a flag that stops firing and has
     `source_upload_id = uploadId` becomes `withdrawn` (closed_by = reviewer) instead of
     `resolved`. A withdrawn flag that fires again after re-commit reopens (treated like
     resolved in the update branch).
- Idempotent: a second call on a page already in review is refused with a plain message.

**Scorecard and Flags hub**
- `getBaScorecard`: skip `status = 'withdrawn'`.
- Flags hub: withdrawn checks sit in "Cleared and resolved" with "Withdrawn · page reopened
  by <name>". Not counted in open tiles.

**SQL** `supabase/nichido/p8_reopen.sql` (additive):
- `flags_status_check` → `('open','resolved','withdrawn')`.
- `reopen_upload(p_company text, p_upload uuid)` security definer, service role only: the
  delete + two status flips in one transaction; returns rows removed.
- Apply on Nichido Staging first; on Nichido prod with the owner's OK at release time.

**Tests**: `restoreCommitted` (edits restored, extra rows appended, overwritten codes listed),
withdraw logic (only this page's flags withdrawn, others resolved), scorecard skips withdrawn,
modal copy (counts, store, period range with "to").

**Verify on staging**: commit a page, check a check fires, reopen, see the counts gone from
Inventory, the page back in review with the edits, the check withdrawn and off the scorecard;
re-commit and see the check return.

## Rollout (D9)

1. Three PRs to `staging` (W1, W2, W3), each green (Vercel build), owner OK before each merge.
2. p8 SQL on Nichido Staging; staging verify (W1 re-reads, W3 round trip).
3. Same day: release branch off `main`, cherry-pick the three, version bump + CHANGELOG, PR to
   `main`. p8 SQL on Nichido prod with the owner's OK. Prod check: `/api/health` commit, a
   reopen round trip on a test page, the owner re-uploads a 5300 scan for W1.

## Out of scope

- BA points for prices off the list (D2). Revisit after Nichido answers whether ₱180 / ₱199
  style prices are allowed.
- A general "print variant" backstop for any extra row printed on another version's same page
  (offered, not chosen). The next variant row needs its own template entry.
