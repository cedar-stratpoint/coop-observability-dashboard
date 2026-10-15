<!-- Thanks for contributing! Put the summary in the title (Conventional Commit). Replace the example rows. -->

## Type of Change

<!-- Put an x in all that apply -->

- [ ] ✨ New feature (non-breaking change which adds functionality)
- [ ] ✨ Change Request (non-breaking change to UI or app behaviour)
- [ ] 🛠️ Bug fix (non-breaking change which fixes an issue)
- [ ] ❌ Breaking change (would change existing functionality)
- [ ] 🧹 Code refactor
- [ ] ✅ Build / CI configuration change
- [ ] 📝 Documentation
- [ ] 🗑️ Chore

## Description

<!-- Describe your changes in detail. -->

## Scope

<!-- WHAT you are doing and WHY. -->

| Field | Value |
|---|---|
| Ticket / brief | [closes TICKET-###](https://link-to-your-ticket) or `knowledge/product_docs/domain-features/...` |
| Domain | e.g. offline-sales, inventory, customers, ask-coop |
| Target branch | `develop` (feature) · `staging` (promotion) · `main` (sign-off only) |
| Pair | With @pair (delete if solo) |

## Implementation

<!-- HOW: high-level flow, refactors, trade-offs, and where reviewers should look closely. -->

## Changes

| Area | File | What changed |
|---|---|---|
| Page | `app/sales/page.tsx` | Add custom range picker |
| Compute | `src/custom-range.ts` | Clamp range to 366 days |
| Tests | `test/custom-range.test.ts` | Cover clamp |

## Screenshots

<!-- UI changes only; delete this section otherwise. -->

|         | before | after |
| ------- | ------ | ----- |
| desktop |        |       |
| mobile  |        |       |

## How to Test

<!-- Steps for a reviewer who does not know this code, e.g.
1. `npm run dev` (mock mode) and open `/sales`
2. Pick a custom range over 1 year
3. Expect the range clamps to 366 days -->

Checks I ran (paste real output; mock mode is fine when archive env is unset):

| Check | Command / where | Result |
|---|---|---|
| Types | `npm run typecheck` | e.g. 0 errors |
| Unit tests | `npm test` | e.g. 88 passed |
| Browser | `npm run dev` → `/sales` | e.g. chart + table render, no console errors |

## Checklist

| Item | Done | N/A |
|---|:-:|:-:|
| Conventional Commit messages | ☐ | ☐ |
| No secrets, `.env`, lead CSVs, or PII committed (public repo) | ☐ | ☐ |
| `CHANGELOG.md` entry added (the decision, not just the change) | ☐ | ☐ |
| Follows `knowledge/design/style-guide.md` | ☐ | ☐ |
| `DigestDocument` change is additive-only; mirrored with backend; mocks updated | ☐ | ☐ |
| Hand-kept copies updated together (QRR, forecast, repricer labels) | ☐ | ☐ |
| No `pos_*` DDL added here (owned by `zoomy-pos`) | ☐ | ☐ |
| Data catalog updated (tables / APIs / pages) and `check.mjs` passes | ☐ | ☐ |

## Rollout / risk

| Need | Detail |
|---|---|
| Env vars | e.g. none |
| Manual SQL | e.g. apply `supabase/x.sql` |
| Redeploy | e.g. Vercel redeploy after env change |
| Rollback | e.g. revert commit |
