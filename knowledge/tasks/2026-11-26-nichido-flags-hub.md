# Nichido Flags hub: every flag in one place (PLAN, not built)

Date: 2026-11-26 · Status: plan, decisions locked with the user · Artifact: see CHANGELOG entry when built

## Ask

"This Flags page only shows flags against BAs. We want a page to see all the flags Nichido-wide
(from review, from OCR, from BAs, etc.)." The UI should feel premium: aesthetic-usability effect,
Hick's law, Von Restorff, generous whitespace (no eye strain). Use the design skills when building.

## What exists today (origin/staging 28ca3c4e)

- `/flags` (`app/flags/page.tsx`, `components/analyst/goldline-flags.tsx`): the **BA scorecard**.
  Only Coop's four checks (`public.flags`: unreadable, row_math, zero_or_below, sales_gap), one tile
  per store, BA and month, points and tag. BAs never see it.
- `/flags/review` "Every flag, page and row" (NICH-43, `src/goldline-flag-lines*.ts`,
  `components/analyst/flag-lines.tsx`): checks + `review_marks` (reader and reviewer) as one line
  each, with filters and CSV. One click deep, behind a header button.
- Nowhere in a cross-store list: failed reads, unknown store or BA, pages still in Needs review,
  reader-unsure cells, duplicate uploads, set-aside pages, data gaps (waiting for POS sales, Watsons
  SKU not linked, first counts), Reco C, PO lines short.
- Staging volume (Nichido staging, Nov 26): 166 check flags (117 padding), 229 reader marks
  (159 note, 53 price, 11 added row, 4 damage, 1 columns), 1,474 pages in needs_review (mostly
  re-uploads), 586 rejected (set aside), 2 failed.

## Decisions (user, Nov 26)

1. **Scope:** all four sources: checks + review marks; scan and read issues; data gaps; Reconcile and PO.
2. **Placement:** one Flags hub at `/flags`: tabs **All flags** (default) and **BA scorecard**
   (today's tiles, unchanged). `/flags/review` folds in (redirect).
3. **Actions:** triage inline: clear a review mark, remark on a check, pick a band price, bulk clear,
   Open page, CSV. Check flags still can't be dismissed (always count against the BA).
4. **Default view:** "Needs you" first, then the rest grouped by kind with counts.
5. **Granularity:** grouped lines. Scan issues one line per page; data gaps one line per store and
   month; checks and marks one line per row. Expand to see rows.
6. **Needs you** = blocks a commit or value (failed read, unknown store or BA, unanswered band price,
   unreadable or unsure cells on uncommitted pages) + uncommitted pages + unlinked Watsons SKUs + new
   check flags since you last looked. One accented strip with four counts; only blocking gets crit.
7. **FYI tier:** Note or revision, Columns changed, Product written in, set-aside pages, first counts:
   collapsed under "For your information", still filterable and in the CSV.
8. **Duplicates:** latest upload of a scan only; "N older uploads hidden" toggle. Checks always show.

## Tiers

| Tier | What | Tone |
|---|---|---|
| Needs you | blocking (crit), uncommitted pages, unlinked SKUs, new checks | the one tinted strip |
| Open | checks, price kept at printed, reviewer marks (illegible, damage, other), waiting for POS sales, Reco C, PO short, duplicates | neutral |
| For your information | notes, columns changed, written-in products, set-aside pages, first counts | quiet, collapsed |
| Cleared | cleared marks, resolved checks (still count) | toggle |

## Architecture

- **`flag_hub_items`** (Nichido staging, additive): one row per hub line.
  `company_id, source (check|reader|reviewer|scan|gap|reco|po), kind, tier, store_code, month,
  upload_id, batch_id, item_code, group_key, count, detail jsonb, status, superseded bool,
  created_at, updated_at`. Unique on `(company_id, source, kind, group_key)`.
- **Checks and marks stay where they are**; the hub reads them live (already cheap, `flagLines`).
  Only the expensive or unstored sources are indexed: scan/read issues, data gaps, Reco C, PO short.
- **Refresh** with `refreshHub(companyId, {month?, uploadIds?})`, called from existing write points:
  read saved (pipeline + batch poller), commit, Run checks (persists `monthCoverage` result instead of
  recomputing on every `/flags` load), SKU link, POS sales commit, PO activate. Lazy refresh on hub
  load when the newest row is older than 15 min. Never computed per request.
- **Unsure cells:** count low-confidence rows per page at refresh (`flaggedRowIndexes` +
  `LOW_BELOW`); no change to the read.
- **Latest upload:** same `uploadSource(filename)` within the company, later `firstAt` wins;
  earlier ones get `superseded = true`.
- **Seen marker:** `flag_hub_seen (company_id, user_email, seen_at)` for "new check flags".
- **Scoping:** every hub read filters by `storeScope`, including upload-sourced lines (uploads are
  not store-scoped today; the hub must not inherit that). Lines with no store are hidden from
  scoped roles.
- **CSV:** extend `/api/goldline/flag-lines-export` with tier, source and group count.
- **Nav:** a single count badge on Flags (Needs you total). Consider moving Flags out of "More" for
  Nichido.
- Reuse: `components/ui/filter-select.tsx` (pills), `StickyBar`, `audit-shared` tone helpers (pick
  one tone helper, retire the duplicates as touched), `GL_PAGE`.

## Design rules (Impeccable Operate mode + Emil)

- Hick: 2 tabs; visible filters = month, store, search; source and status under "More filters".
  Kind chips: top 6 by count + "+N". Each line shows at most two actions (Open page + one
  contextual); the rest in a "…" menu.
- Von Restorff: only the Needs you strip is tinted; only its blocking count uses crit. Kinds carry
  monochrome icons, not colors. One primary (forest green) action per view.
- Whitespace: 8pt scale; 48px between sections, 32px between groups, 24px card padding, lines
  ≥ 72px tall with 16px vertical padding, line-height 1.6, hairlines only between groups. Content
  max ~1200px.
- Motion: expand via `grid-template-rows` 0fr→1fr 200ms `cubic-bezier(.23,1,.32,1)`; clear = fade +
  collapse 180ms with Sonner "Cleared · Undo" (5s); tabs switch content instantly (frequent),
  indicator slides 200ms; press `scale(.97)`; hover behind `(hover:hover)`; reduced motion = opacity
  only. No load stagger.
- Copy: no em or en dashes; "to" for ranges; `·` separators.

## Phases (each a PR to staging, behind `GOLDLINE_FLAGS_HUB=1` until P4)

- **P0 Hub shell:** tabs, tiers, kind index, inline clear/remark/price, FYI collapse, Cleared toggle,
  `/flags/review` redirect. Checks + marks only. No schema.
- **P1 Index + scan and read issues:** `flag_hub_items`, `refreshHub`, failed, unknown store/BA,
  uncommitted per scan, unsure cells, duplicates, set-aside (FYI), latest-upload toggle.
- **P2 Data gaps:** persist coverage at Run checks; waiting for POS sales, unlinked SKUs (Link SKUs
  CTA to `/stock/skus`), first counts (FYI). Removes the uncached `monthCoverage` from `/flags`.
- **P3 Reconcile and PO:** Reco C per store and month (link to Reconcile filtered), PO short lines.
- **P4 Seen + badge + polish:** `flag_hub_seen`, nav badge, CSV, design-motion audit, Impeccable
  critique, flag on by default on staging. Prod promotion only when asked.

## Risks

- "Needs you" has four groups; keep it one strip or it stops standing out.
- Staging's 1,474 needs_review pages are re-upload noise; latest-upload rule must land in P1.
- `triageBoard` re-segments the whole company; `refreshHub` must reuse its pure functions per batch,
  not call it per request.
- Review drafts live in localStorage; the hub cannot see unsaved picks.
