# Shopee weekly export import

Loads the Shopee Seller Centre exports into Supabase so every report reads the same exact daily figures. Plan and reasons: `knowledge/tasks/2026-10-22-shopee-import-data-engineering-plan.md`. It imports all five weekly exports: **Sales Overview** (daily sales), **Ads** (per campaign, weekly), **Parent SKU detail** (per product, weekly), **Traffic Overview** and **Product Overview** (daily). Any other file name is skipped and named.

## Setup (once per database)
Apply two files by hand in the archive project's SQL editor, in this order (local Docker first, then staging; PROD with the co-worker's OK):
1. `supabase/shopee_import.sql`: adds `import_runs`, `marketplace_daily_observations`, replaces the empty table `marketplace_daily_sales` with a view of the same name, and refuses to drop that table if it has rows.
2. `supabase/shopee_weekly_reports.sql`: adds the four tables and four views for ads, SKU, traffic and product funnel, and the private storage bucket `shopee-imports` for the original files. Safe to run again. Where the storage schema does not exist (a bare local database) the bucket is skipped and imports still work, only without the stored original.

## Every week (does not change the existing weekly run)
The weekly digest run on the Mac, its folder (`~/Zoomy/Shopee`), its five files and its Monday to Sunday window stay exactly as they are (backend `docs/shopee-manual-exports.md`). The importer is one more reader of the same files.
```bash
set -a; source <env with SUPABASE_URL_ARCHIVE and SUPABASE_SERVICE_ROLE_KEY_ARCHIVE>; set +a
npm run shopee:import -- plan ~/Zoomy/Shopee        # dry run: one block per file (see below)
npm run shopee:import -- apply --all-staged --confirm-host <your supabase host>   # applies every staged file, whatever its type
npm run shopee:import -- coverage                   # per week: sales days loaded and whether ads, sku, traffic and funnel are there
npm run shopee:import -- reconcile                  # each stored digest's Shopee revenue against the imported daily sales (changes nothing)
npm run shopee:import -- undo <importId> --reason "wrong export" --confirm-host <host>
```
- Catch-up: export the last four weeks each Monday and plan the folder. Overlapping days are refreshed (cancellations settle); days older than 28 days never change unless you pass `--restate "reason"`.
- `--only-new` writes only days that are not loaded. Today and later (an open day) are never loaded.
- A file that fails a check is rejected whole and recorded, with the reason. The same file twice does nothing.
- The folder may be flat (the Mac) or hold one sub-folder per week (the backfill zip). `_superseded/` is skipped unless `--include-superseded`.
- `plan` writes only staged rows the app never reads. `apply` is one status change; `undo` is one status change back.
- The command does not read `.env` files. Against a database that is not on this machine, `apply` and `undo` need `--confirm-host`.

## What `plan` shows for each file
- **Sales Overview:** new, unchanged and changed days, flags, open days left out (as before).
- **Ads:** campaigns, spend, ad revenue and ROAS (ad revenue over spend, never an average of ratios).
- **SKU detail:** products and variations, the products' confirmed sales, and `covers N%` when the shop's sales for that week are loaded. The export lists only the top performing products, so N can be below 100: the product list is then a lower bound, not the whole week.
- **Traffic and Product Overview:** days, page views (checked against the file's own total) or placed and confirmed sales.
- A line `(original file NOT kept)` means the private bucket could not store the original. The import is still fine; re-run the SQL for the bucket if you want originals kept.
Each of these four reports is one snapshot of its period: a newer accepted import of the same week (or day) replaces the older one in what the app reads, and `undo` brings the older one back. They have no day-by-day plan to go stale, so `apply` is one status change.

## Coverage
`coverage` prints one row per week: the sales days loaded (`7/7`) and, for ads, sku, traffic and funnel, `yes` (all 7 days covered), `part` or `-` (none). The API `coverage` returns the same under `reports` for each week. SKU and ads exist for only some weeks; `-` is a missing export, not a zero.

## Original files
Every file that stages is also stored, as received, in the private bucket `shopee-imports` as `<report type>/<sha256>.<ext>` (service role only; `import_runs.raw_path` points at it). These are shop totals only. A per-order export (`Order.all.*`, with buyer names and addresses) is never imported or stored.

## Monday routine, in plain words
1. Export the five files for last Monday to Sunday from Seller Centre (Sales Overview, Product Overview, Traffic Overview, Parent SKU detail, Ads) into the usual folder. The weekly digest run keeps using them as before.
2. `plan` the folder (or send the files to the API). Read the blocks: nothing rejected, `covers N%` sensible, ad spend looks like the Seller Centre figure.
3. `apply --all-staged`. 
4. `coverage` to see the week is complete. A file that was rejected names the reason; fix the export and plan again.

## API (same code as the command)
`Authorization: Bearer $SHOPEE_IMPORT_TOKEN` on every call (set the token in the deployment's env, `openssl rand -hex 32`; unset means every call answers 503). Outside the page sign-in on purpose.
```bash
curl -s -H "Authorization: Bearer $T" -F "files=@sales_overview_20261012-20261018.xlsx" -F "files=@sales_overview_20261019-20261024.xlsx" https://<host>/api/shopee/import/plan
curl -s -H "Authorization: Bearer $T" -H 'content-type: application/json' -d '{"importIds":["<id from the plan>"]}' https://<host>/api/shopee/import/apply
curl -s -H "Authorization: Bearer $T" https://<host>/api/shopee/import/coverage
curl -s -H "Authorization: Bearer $T" -H 'content-type: application/json' -d '{"importId":"<id>","reason":"wrong export"}' https://<host>/api/shopee/import/undo
```
Send any of the five report types in the same request; each result carries its `reportType`, period, rows and summary figures. Plan optional fields: `only_new=true`, `restate=<reason>` (Sales Overview only). At most 30 files of 5 MB each per request. A plan stages inert rows; only `apply` changes what the app shows. Responses never contain file contents.

## Checks before anything is written
- **Sales Overview:** continuous dates with one row per day; the file's period equals its name; daily placed and confirmed sales add up to the file's own totals; no negative or non-numeric figure. Confirmed can exceed placed on a day, so that is not a check.
- **Traffic:** one row per day for each of All, PC and APP; daily page views add up to the file's own total per sheet. Visitors are not summed (they are unique per span).
- **Product Overview:** one row per day, no gap or duplicate, period equals the file name.
- **Ads and SKU:** the file has rows, no negative figure, and its period equals the file name (the SKU file carries no dates inside, so its name must keep Shopee's dates).
- Today and later are never loaded from a daily report.
