# Shopee weekly export import

Loads the Shopee Seller Centre exports into Supabase so every report reads the same exact daily figures. Plan and reasons: `knowledge/tasks/2026-10-22-shopee-import-data-engineering-plan.md`. Today it imports the **Sales Overview** file (daily rows); the other reports are recognised and skipped until their importers exist.

## Setup (once per database)
Apply `supabase/shopee_import.sql` by hand in the archive project's SQL editor (local Docker first, then staging; PROD with the co-worker's OK). It adds `import_runs`, `marketplace_daily_observations`, replaces the empty table `marketplace_daily_sales` with a view of the same name, and refuses to drop that table if it has rows.

## Every week (does not change the existing weekly run)
The weekly digest run on the Mac, its folder (`~/Zoomy/Shopee`), its five files and its Monday to Sunday window stay exactly as they are (backend `docs/shopee-manual-exports.md`). The importer is one more reader of the same files.
```bash
set -a; source <env with SUPABASE_URL_ARCHIVE and SUPABASE_SERVICE_ROLE_KEY_ARCHIVE>; set +a
npm run shopee:import -- plan ~/Zoomy/Shopee        # dry run: shows new, unchanged, changed, flags
npm run shopee:import -- apply --all-staged --confirm-host <your supabase host>
npm run shopee:import -- coverage                   # which weeks are loaded and which are missing
npm run shopee:import -- reconcile                  # each stored digest's Shopee revenue against the imported daily sales (changes nothing)
npm run shopee:import -- undo <importId> --reason "wrong export" --confirm-host <host>
```
- Catch-up: export the last four weeks each Monday and plan the folder. Overlapping days are refreshed (cancellations settle); days older than 28 days never change unless you pass `--restate "reason"`.
- `--only-new` writes only days that are not loaded. Today and later (an open day) are never loaded.
- A file that fails a check is rejected whole and recorded, with the reason. The same file twice does nothing.
- The folder may be flat (the Mac) or hold one sub-folder per week (the backfill zip). `_superseded/` is skipped unless `--include-superseded`.
- `plan` writes only staged rows the app never reads. `apply` is one status change; `undo` is one status change back.
- The command does not read `.env` files. Against a database that is not on this machine, `apply` and `undo` need `--confirm-host`.

## API (same code as the command)
`Authorization: Bearer $SHOPEE_IMPORT_TOKEN` on every call (set the token in the deployment's env, `openssl rand -hex 32`; unset means every call answers 503). Outside the page sign-in on purpose.
```bash
curl -s -H "Authorization: Bearer $T" -F "files=@sales_overview_20261012-20261018.xlsx" -F "files=@sales_overview_20261019-20261024.xlsx" https://<host>/api/shopee/import/plan
curl -s -H "Authorization: Bearer $T" -H 'content-type: application/json' -d '{"importIds":["<id from the plan>"]}' https://<host>/api/shopee/import/apply
curl -s -H "Authorization: Bearer $T" https://<host>/api/shopee/import/coverage
curl -s -H "Authorization: Bearer $T" -H 'content-type: application/json' -d '{"importId":"<id>","reason":"wrong export"}' https://<host>/api/shopee/import/undo
```
Plan optional fields: `only_new=true`, `restate=<reason>`. At most 30 files of 5 MB each per request. A plan stages inert rows; only `apply` changes what the app shows. Responses never contain file contents.

## Checks before anything is written
Continuous dates with one row per day; the file's period equals its name; daily placed and confirmed sales add up to the file's own totals; no negative or non-numeric figure. Confirmed can exceed placed on a day, so that is not a check.
