---
name: shopee-weekly-import
description: Use when loading the weekly Shopee export into Coop ("load the weekly Shopee export", "import this week's Shopee files", "send the Monday Shopee files", "Shopee numbers are missing for last week", "which Shopee weeks are loaded", coverage questions). Plans, applies and checks the five Shopee shop-total files through the import API or the developer command, and reports in plain language.
---

# Weekly Shopee import (Coop)

Loads the five Shopee Seller Centre exports for one closed Monday to Sunday week into Supabase, so the Sales page shows exact daily sales, ad spend, ROAS and Shopee products. Runbook and reasons: `docs/shopee-import.md`. Code: `src/shopee-import/`.

## Golden rules (never break these)
1. **Shop-total exports only.** The five files are Sales Overview, Product Overview, Traffic Overview, Parent SKU detail and the Ads CSV. **Never open, read, upload or import a per-order export (`Order.all.*`)**: it holds buyer names, phones and addresses. If one is in the folder, leave it out and say so.
2. **The token is a secret.** Never print it, echo it, paste it into chat, write it to a file, log it or commit it. Read it from the environment (`$SHOPEE_IMPORT_TOKEN`) or ask the owner to put it there. The same goes for database keys.
3. **One environment per run.** Say the host (staging or PROD) out loud before you apply. **PROD needs the co-worker's OK**; without it, stop.
4. **Read the plan before you apply.** Never apply a plan you have not read file by file.
5. **A rejected file is never forced.** Report why; do not retry it unchanged; ask for a corrected export.
6. **`--restate` / `restate` only with the owner's written reason.** It rewrites days older than 28 days.
7. **Never delete or edit rows with SQL.** Undo is the only way back.

## 1. Confirm the inputs
- **Folder:** the five files for the closed week (last Monday to Sunday). Names Shopee gives them:
  - `sales_overview_YYYYMMDD-YYYYMMDD.xlsx`
  - `productoverviewYYYYMMDD-YYYYMMDD.xlsx`
  - `traffic_overview_YYYYMMDD_YYYYMMDD.xlsx`
  - `parentskudetail.YYYYMMDD_YYYYMMDD.xlsx` (keep the name: it carries the only dates)
  - `Shopee-Ads-Overall-Data-DD_MM_YYYY-DD_MM_YYYY.csv`
  The Mac's digest folder is `~/Zoomy/Shopee` (flat); a `_superseded/` folder inside it is not an import.
- **Target:** staging or PROD, and its host. Staging example: `coop-brand-os-staging.vercel.app` (a staging deploy).
- **Route:**
  - **HTTP API (preferred):** needs only `$SHOPEE_IMPORT_TOKEN` and the deploy host. Works from any machine.
  - **Developer command:** `npm run shopee:import -- ...`; needs `SUPABASE_URL_ARCHIVE` and `SUPABASE_SERVICE_ROLE_KEY_ARCHIVE` in the shell (it does not read `.env`); `apply` and `undo` on a non-local database need `--confirm-host <host>`.

## 2. Steps
**a. Coverage first** (what is loaded now):
```bash
curl -s -H "Authorization: Bearer $SHOPEE_IMPORT_TOKEN" https://<host>/api/shopee/import/coverage
# or: npm run shopee:import -- coverage
```
Per week: sales days loaded (`7/7`) and, under `reports`, ads, sku_detail, traffic, product_overview as `full`, `partial` or `missing`.

**b. Plan** (a dry run: writes only inert rows the app never reads; max 30 files, 5 MB each):
```bash
curl -s -H "Authorization: Bearer $SHOPEE_IMPORT_TOKEN" \
  -F "files=@sales_overview_20261012-20261018.xlsx" -F "files=@productoverview20261012-20261018.xlsx" \
  -F "files=@traffic_overview_20261012_20261018.xlsx" -F "files=@parentskudetail.20261012_20261018.xlsx" \
  -F "files=@Shopee-Ads-Overall-Data-12_10_2026-18_10_2026.csv" https://<host>/api/shopee/import/plan
# or: npm run shopee:import -- plan <folder>
```
**c. Read the plan** file by file. Each result has a `status`:
- Sales Overview `staged`: `newDays`, `unchanged`, `changed` (before, after, pct), `keptCurrent`, `frozenBlocked`, `flags`, `openSkipped`.
- Other four `staged_report`: `reportType`, `rows`, `summary` (ads: spend, adRevenue, roas; sku: products, confirmedSales; traffic: pageViews; funnel: salesConfirmed), `coveragePct` (SKU: `covers N%` of the shop's confirmed sales; below 100 is normal because the export lists only top products, but say it), `openSkipped`, `rawStored` (false: the original was not kept; the import is still fine).
- Sanity check one figure against Seller Centre when the owner can (ad spend, week's confirmed sales).

**d. Decide per status:**

| Status | Do |
|---|---|
| `staged` / `staged_report`, no flags, nothing frozen | continue |
| `already_loaded` | fine, nothing to do |
| `nothing_to_do` | fine, nothing new or changed |
| `unsupported` | say why (message), skip it. An unknown file name or a per-order export is expected here |
| `rejected` | report the gate code and message; do not retry unchanged; ask for a corrected export |
| any `flags` (`BIG_CHANGE`: over 5% and 100 pesos; `FROZEN_BLOCKED`) or `changed` days | **stop and ask the owner** before applying |

Gate codes: `FILENAME_MISMATCH` (file name dates differ from the file: wrong or renamed file), `PERIOD_MISMATCH` / `GAP` / `DUPLICATE_DAY` (days missing, doubled or outside the period: re-export), `SUM_PLACED` / `SUM_CONFIRMED` / `SUM_PAGE_VIEWS` (daily rows do not add to the file's own total: damaged export), `PERIOD_OPEN` (week not finished: export after Sunday), `ALL_DAYS_OPEN` (nothing closed to load), `NO_PERIOD` (SKU name lost its dates), `BAD_NUMBER`, `EMPTY`, `PARSE` (not the expected workbook).

**e. Apply** only the staged ones:
```bash
curl -s -H "Authorization: Bearer $SHOPEE_IMPORT_TOKEN" -H 'content-type: application/json' \
  -d '{"importIds":["<id from the plan>","<id>"]}' https://<host>/api/shopee/import/apply
# or: npm run shopee:import -- apply --all-staged --confirm-host <host>
```
**f. Verify.** Each result is `ok: true` with a receipt. For Sales Overview the receipt must say it matches the file total (`matchesFileTotal: true`, `reconciled: true`). Then run coverage again: the week shows 7/7 sales and `full` for each report that was sent.

**g. Report** (format below).

## 3. When something fails
- **401** wrong or missing token: ask the owner to fix the env; never ask for the value in chat.
- **503** `The import API is not configured on this deployment.`: no token is set there. **503** `The archive database is not configured on this deployment (mock mode).`: the deploy has no database. Say which one you got.
- **413** more than 30 files or a file over 5 MB: split the request.
- **400** no files or wrong body: re-check the field name `files` / the `importIds` body.
- **STALE_PLAN** (apply): the loaded figures moved since the plan. Plan the file again and read it again.
- **LOST_RACE** / `NOT_STAGED`: someone else applied or replanned it. Run coverage, then plan again if still missing.
- **Partial week** (a file for part of a week): daily reports load their closed days; ads and SKU are refused until the week ends (`PERIOD_OPEN`).
- **A late export that changes a day older than 28 days:** it shows as `FROZEN_BLOCKED`. Stop. Only the owner can approve a restate, with a written reason.

## 4. Undo
```bash
curl -s -H "Authorization: Bearer $SHOPEE_IMPORT_TOKEN" -H 'content-type: application/json' \
  -d '{"importId":"<id>","reason":"<why, in words>"}' https://<host>/api/shopee/import/undo
# or: npm run shopee:import -- undo <importId> --reason "<why>" --confirm-host <host>
```
It needs a written reason, flips that one import to superseded, and the app falls back to the previous figures by itself. Nothing is deleted. Only undo when the owner asks.

## 5. Report to the owner
One table, then two lines. Plain words, no gate codes unless a file was rejected.

| File | Period | Result | Key figure |
|---|---|---|---|
| Sales Overview | 12 to 18 Oct | loaded | confirmed sales and "matches the file total" |
| Ads | 12 to 18 Oct | loaded | spend and ROAS |
| Product (SKU) | 12 to 18 Oct | loaded | products, "covers N% of the week's sales" |
| Traffic / Product funnel | 12 to 18 Oct | loaded | page views / days |

- **Coverage:** which weeks are complete for each report, and which are missing.
- **Needs you:** anything rejected, flagged, frozen or skipped, and what you need to proceed.

## What this does not do
- It does not load Lazada, website or per-order data.
- Traffic and the product funnel are stored but not shown in the app yet.
- It does not run or change the weekly digest job; that is separate and keeps using the same files.
