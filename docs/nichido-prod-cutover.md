# Nichido (Goldline) prod cutover

The one controlled pass that takes Goldline from Staging to prod. Prepared Oct 26, 2026, after P1, P2, the Oct 26 flag rework, the BA list and scorecard, the multi-store scan split and F2 landed on `staging`; updated Oct 27 (SKU links screen removed, BAs learned from forms, Q23 ending rule). Run it only after Justin's UAT sign-off (P5).

Who: **Rick** (Nichido database, copy), **the co-worker who owns prod Vercel** (env vars, deploy), **Lance** (code to `main`, data load, smoke test).

## 0 · Before the day

| Check | How |
|---|---|
| Justin and the owner signed off a full cycle on Staging | P5 UAT |
| Their Google sign-in emails (D4) | From Justin |
| A new `GOLDLINE_ANTHROPIC_API_KEY` for prod | Rotated key, never the one pasted in chat |
| Prod Nichido service-role key | Supabase dashboard, project `pfwrkqsjmetibslltmok` (the `Nichido-Supabase` MCP is read-only on purpose) |

## 1 · Database: Nichido prod (`pfwrkqsjmetibslltmok`)

Apply in this order, in the SQL editor, one file at a time, stopping on any error. Prod has no Goldline tables yet.

| # | File (`supabase/nichido/`) | Owner | What |
|---|---|---|---|
| 1 | `goldline_schema.sql` | Rick | Base tables, functions, bucket, `companies` mirror |
| 2 | `scripts/nichido/migrate-goldline.ts --apply`, then `--verify` | Rick | Copy rows and files from the prod archive's `gl_*` |
| 3 | `goldline_post_copy.sql` | Rick | Move id counters past the copied ids |
| 4 | `p1_watsons_data_in.sql` | Lance | Chain, scope and retire columns, `chain_skus`, `sales_by_sku` |
| 5 | `p2_checks.sql` | Lance | `check_settings`, `adjustments`, `flags` |
| 6 | `p2b_flag_causes.sql` | Lance | Oct 26 cause names, every flag counts, remark columns |
| 7 | `a1_ba_directory.sql` | Lance | `bas`, `store_bas` |
| 8 | `f2_store_scope.sql` | Lance | `store_scope()` |
| 9 | `f2b_sku_link_reviews.sql` | Lance | `sku_link_reviews` (latest SKU link decision and remark) |
| 10 | `p3_forecast.sql` | Rick | `forecast_settings` (seeded 3 + 1), `forecast_months()`, `forecast_history()` (F10) |

**Verified Oct 26:** files 1 and 4 to 8 ran clean on an empty PostgreSQL 17 database with Supabase's roles and `storage.buckets` stubbed, and clean again on a second run (safe to re-run). The result matches Nichido Staging's columns, functions, constraints and indexes exactly, except two auto-generated unique-constraint names on `inventory` and `sales` that Staging got from its old `gl_` rename (no code refers to them by name).

## 2 · Code: `main`

`main` and `staging` have diverged (release commits and cherry-picks on each side), so Goldline goes to prod by **cherry-pick onto a branch off `main`**, then a PR into `main`, the same way it reached `staging`. Do **not** merge `staging` into `main`: it would also carry other people's unreleased work (Ask Coop and Shopee import commits).

Cherry-pick with `-x`, in this order (hashes as on `staging`):

1. Rick's Nichido move: `e7a80a9`, `3bc44f6`, `6480545`, `ea2ff24`, `21e6842`, `11978ad`
2. P1 and P2: `6b819c5`, `4500ce8`, `7a371df`, `6b6214d`, `ef6b208`, `8357634`
3. Oct 26 rework and after: `1b80d80`, `f1ec392`, `ff406c9`, `78cfb73`, `9c15af9`, `df9c3f1`
4. Oct 27: `acfd64d` (SKU links screen removed), `858b85d` (BAs learned from forms, ending excludes delivery), `7a12d7c` (SKU matcher fix), `3be5a36` (full-width pages, Action feed table), `4cb06b0` (Stores: restock on or paused), `b21f16a` (SKU linking back with Approve / Reject and remarks)

Expect `CHANGELOG.md` conflicts on most picks: keep `main`'s file and add the Goldline entries in one commit at the end. Typecheck and tests on the branch before the PR. A release commit (`chore(release): v1.x.0 …`) follows the repo's usual pattern.

## 3 · Env vars: prod Vercel (co-worker)

| Variable | Value |
|---|---|
| `NICHIDO_URL` | `https://pfwrkqsjmetibslltmok.supabase.co` |
| `NICHIDO_SERVICE_ROLE_KEY` | Prod Nichido service-role key |
| `GOLDLINE_ANTHROPIC_API_KEY` | The new prod key |

The pairing check refuses a Staging Nichido URL on prod (and the reverse). Redeploy after setting them.

## 4 · Data on prod

| Step | How | Note |
|---|---|---|
| 10 months of POS Sales Data | Uploads, one Watsons `.xlsx` at a time (Oct 2025 to Sep 2026, plus Feb and Mar 2026 once Justin sends them) | High-confidence SKU links are made automatically on load |
| SKU links confirmed on Staging | Decisions are made in Coop's SKU linking page (Approve / Reject, remarks); export Staging's `products.sku_code` / `sku_linked_by`, `chain_skus` decisions and `sku_link_reviews` to a reviewed `.sql`, apply on prod | Prod's catalog comes from the archive copy and won't have Staging's links |
| BAs | Nothing to load: Coop learns each BA from the name on the uploaded forms | `/bas` only to correct a store's BA |
| Store scope overrides | `/stores` | Only if Justin wants any store forced in or out |
| Access | Main database: `company_users` rows giving Justin and the owner `company_admin` on `goldline` (D4) | |

## 5 · Lock the old copy (Rick)

`archive_lock_goldline.sql` on the **prod archive** (`qkxbwzdxhwcbwgriwipi`), after the deploy and a last `migrate-goldline.ts --apply`. It revokes writes on the old `gl_*` tables and closes the old bucket to new files.

## 6 · Smoke test (signed in as an admin, Nichido view)

1. Overview and Stores load with the 10 months; Stores shows "In scope N of M".
2. Uploads: one real form PDF reads, reviews and saves; a two-store PDF splits into two forms.
3. Flags: tiles per store per BA; a tile opens the digital form with boxed, numbered cells and notes.
4. BAs: a form saved with a BA name puts that BA on `/bas` for its store; the scorecard lists BAs; each store links to its form.
5. Zoomy's Ask Coop can't see Nichido data; Coop Admin stays data-blind.

## 7 · Rollback

Revert the merge on `main` and redeploy. The SQL is additive: leave it, nothing reads it once the code is reverted. The archive's `gl_*` copy stays intact until step 5, so step 5 waits until the smoke test passes.
