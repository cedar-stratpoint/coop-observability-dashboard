# Changelog — Coop Dashboard

Notable changes to the Coop / BrandOS dashboard (`zoomy-observability-dashboard`).
The POS app has its own changelog in `../zoomy-pos/CHANGELOG.md`.

Conventions: work flows `feature → develop → staging` (never `main` without
sign-off); Conventional Commits; commits carry `Co-Authored-By: Claude` +
a `Claude-Session` trailer. Reads the shared Coop Supabase (Staging on the
`*-staging` deploy; PROD is the co-worker's project).

Dates are local working dates (GMT+8). Newest first.

## 2026-10-26 - Cross-channel SKU comparison (alias table and pure compare module)
One product side by side across offline (POS), Shopee and the website, over whole Monday to Sunday weeks. Built as data plus a pure function; **no Ask Coop tool is registered yet** (the wiring step calls `compareSku`, contract in `knowledge/tasks/2026-10-26-sku-compare-contract.md`).
- **`product_channel_alias`** (`supabase/product_channel_alias.sql`, applied by hand, RLS on, no policies, nothing applied anywhere yet): channel identifier to the POS `product_id`, by value, no `pos_*` DDL. `npm run sku:aliases` has `propose` (review CSV), `apply` (auto rows and rows a person confirmed) and `coverage`.
- **`src/sku-compare.ts`** is pure and tested: unmapped rows go to a bucket with a share, never into a SKU; a channel states its basis; a total says "mixed basis", "at least" (Shopee lists top products only) and "partial" (a missing channel or week is named); an alias conflict leaves the key unmapped and is reported; other dates give each channel alone with no total.
- **Decision:** the website SKU is **unverified** as equal to the POS code until one stored order is read, so the website maps only through confirmed aliases and its label says so. The Shopee variant SKU equals the POS code (verified), but only counts once seeded as an auto alias. Shopee variation rows replace their product row so nothing is counted twice.
- Data catalog updated (`product_channel_alias`, the CRM `products/sales` row); it also names the unprefixed Nichido Goldline tables that the catalog check already flagged on `develop`. The alias table is documented without a table heading on purpose, so `catalog.json` and the Explore prompt (14,396 of 14,400) are unchanged.

## 2026-10-24 — Goldline tables in Nichido drop the gl_ prefix
In the Nichido project Goldline is the only tenant, so its tables, view and functions lose the `gl_` prefix the shared archive needed: `gl_sales` is now `sales`, `gl_inventory_snapshots` is `inventory_snapshots`, `gl_commit_batch` is `commit_batch`, and so on. The same goes for their indexes, constraints and sequences. Only database names change. TypeScript names such as `glTags` and `getGlCatalog`, the `goldline-uploads` bucket and storage paths stay as they are.
- **Decision:** the archive's old copy keeps its `gl_*` names. It is kept indefinitely, Ask Coop's explore blocklist still fences `gl_` there, and `archive_lock_goldline.sql` still targets those names. The copy script reads archive `gl_<name>` and writes Nichido `<name>`.
- **Schema:** `supabase/nichido/goldline_schema.sql` (source of truth) now uses the plain names. `supabase/nichido/rename_drop_gl_prefix.sql` converts a project built with the old names in one transaction. It renames constraints, indexes, sequences, the view and tables in place (keeping data, ids, RLS and grants), and drops and recreates the six functions, because their bodies name tables. Applied on Nichido Staging: no `gl_` object remains, row counts are unchanged, and the functions were re-tested in a rolled-back block.
- **Guard test** (`test/goldline-nichido-guard.test.ts`) now lists the Nichido table and function names. It also fails if any code still queries a `gl_` name.
- Checked locally as a Goldline admin: all six Goldline pages load, and Nichido's API logs show only the new names, all 200.
- *Not updated:* Ask Coop's `src/chat/catalog/catalog.json` still lists `gl_*` as the Goldline pages' data. It is generated from the knowledge base (`knowledge/data-catalog/`, not in this checkout), so the change belongs there. The text only describes the data sources (Goldline pages are fenced from Ask Coop), so nothing breaks.

## 2026-10-23 — Source line truth after a deploy, and why the CRM failed
Staging re-test of #254 found two things.
- **Per-channel source line still said "from digests"** for Shopee figures that come from the imported daily rows, although the header line was right. The tag that marks a synthetic per-day-rows digest (`source: 'daily_rows'`) is added by `dailyRowsToDigests`, but Ask Coop reads those digests through `unstable_cache`, and the data cache outlives a deploy: the first requests after the deploy were served the entry cached by the previous build, which has no tag. Fix at the cause: the cache key is now `chat-marketplace-daily-v2`, so an old-shape entry is never served. (A shape-based fallback was tried and dropped: it also matched old-format published digests in the existing tests.) Rule: when a cached value gains a field, change the cache key in the same change.
- **Staging CRM unreachable.** `/api/chat/health` (new in #254) showed `CRM_API_URL` with a trailing space or newline and both probes failing "answered with an error". The chat client already trims the env (`resolveCrmAccess`), so the whitespace was not what broke the chat; the pages reader (`src/crm-data.ts`) did not trim and now does. `describeCrmEnv` adds `trimmedByCode` so health still tells the owner to fix the value. The failure reason now carries the HTTP status: 401 or 403 says the token does not belong to this CRM worker, 404 says the URL is not the right worker, 5xx says the CRM has its own error. The health shows staging pointing at the `zoomy-crm-prod` worker host: check that on purpose and that `CRM_API_READ_TOKEN` is that worker's token. No prompt text and no tool schema changed.

## 2026-10-23 — Staging live test follow-ups: partial totals state their revenue, per-day sources are labelled truthfully, CRM failure reason
Found by asking Ask Coop six questions on staging after #250 and #252 (all passed; these were the small gaps):
- **A partial total now carries its revenue in the note.** The channel report's total said "Partial total of Shopee and Offline only" but the figure (₱76,866) only showed in a table, so the model answered with units and AOV and never stated it. `totalOf` now writes "Partial total of Shopee and Offline: ₱76,866 revenue from 135 orders. Left out: ..." (and the same revenue statement on a complete total), so the model quotes it.
- **Source labels say what is true.** Figures from the saved per-day rows (`marketplace_daily_sales`, the imported Shopee exports and Lazada API) were labelled "per-day sales from digests". Those digests are now flagged `source: 'daily_rows'` and the note says "saved daily rows (imported from the Shopee exports | the Lazada API)"; a published digest still says digests; a mix gets both lines. Rule: a label never claims a source that is not true for that row.
- **The Website row says why the CRM read failed**, as a safe class only (answered with an error, over the size cap, timed out, could not be reached, not JSON), never a URL, token or upstream text; an unknown error says "an unknown error". `/api/chat/health` (signed in) gains a `crm` section: URL host and token length only, plus one read of `/api/metrics` and one of `/api/orders` with `ok`, `ms`, `bytes` or the reason. The CRM env is still named only in `src/chat/crm/config.ts` (a security test pins that).
Decision: all of it is in code (tool-result notes, labels, health), none in the prompt. The explore prompt is 14,396 of a 14,400 token budget, so it was not touched; no tool input schema changed. Not yet re-verified on staging: re-ask the total and the share questions after deploy.

## 2026-10-23 — Ask Coop no longer says Shopee and Lazada come only from the digest
The staging live test of #250 found it: "What were Shopee sales from 21 Sep to 18 Oct 2026?" got "I can't give you Shopee sales ... Shopee figures only come from the stored digests" and a pointer to the Sales page, although `get_channel_report` returns ₱54,636 for those dates (checked by running the real tool path against the staging database with no model). Cause: three prompt texts still denied the tool: the guardrail line (`config.ts`: "Shopee and Lazada figures come only from the digest"), the per-turn preamble (`preamble.ts`: "Shopee/Lazada sales (stored digests only)" under "Not available:") and the coverage list (`coverage.ts`: "Only in the stored digests; not queryable yet"). `get_channel_report` has read the saved per-day Shopee and Lazada rows since v1.12.0, but the text was never updated. Fix: one shared sentence (`SHOPEE_LAZADA_SOURCE`): Shopee and Lazada come from `get_digest` (one window) or `get_channel_report` (any dates), and when dates are named the model calls it and never sends the owner to a page; the preamble drops its denial; the coverage list names both tools. Digest-only mode (no tools are sent) keeps the old wording, because there it is true. Prompt +37 tokens (explore 14,359 to 14,396; budget 14,400, only 4 tokens of headroom left). No tool schema changed. A test now fails if any static prompt variant, the preamble or describe_data says digest-only for Shopee or Lazada while the tool exists. Not yet verified with a live model: re-ask the staging question after deploy.

## 2026-10-22 — Goldline data moves to its own Nichido Supabase project
Goldline's `gl_*` tables and the `goldline-uploads` bucket move out of the shared Coop archive into the dedicated Nichido project. Every Goldline module now goes through one client, `src/nichido-client.ts` (`NICHIDO_URL`, `NICHIDO_SERVICE_ROLE_KEY`), in place of the nine copies that each read the archive env.
- **Decisions (owner):** sign-in, memberships and the company registry stay in the archive; Nichido only gets a one-row `companies` mirror (`goldline`) so the `gl_*` foreign keys and the overview's company name keep working. The archive's `gl_*` copy is kept indefinitely, made read-only after cutover. Staging first; prod only on an explicit go-ahead.
- **No fallback:** with the Nichido env unset, Goldline pages are empty and writes refuse. `nichidoPairOk` (`src/coop-env.ts`) also requires the Nichido project to match the archive's environment (Staging `jcql…hcns`, prod `pfwr…tmok`), so a Staging deploy can never write Goldline data into prod.
- **Schema:** `supabase/nichido/goldline_schema.sql` is now the source of truth for Nichido. It brings together the goldline SQL files plus the hand-added `gl_uploads.error_detail` column (live on the archive, in no file). `gl_sales.id` / `gl_inventory.id` are `generated by default` so the copy keeps ids. The bucket is created there too. Applied on Nichido Staging; columns, constraints, indexes, RLS and grants were compared against the archive and match.
- **Copy:** `scripts/nichido/migrate-goldline.ts` (plan by default, `--apply`, `--verify`) upserts rows on their primary keys in FK order and copies files to the same paths. Re-running it is safe, and it never deletes on either side. After `--apply`, run `supabase/nichido/goldline_post_copy.sql` to move the id sequences past the copied ids. Staging: 1,246 rows in 13 tables and 44 files (18.1 MB) copied, and `--verify` matches every table by row hash and every file by path and size.
- **Checked on Staging (local dev as a Goldline admin):** overview, stores, store health, action feed, stock and uploads render from Nichido (confirmed in its API logs). Shipment record and cancel, set price, sales rollup and count sources all ran on Nichido inside a rolled-back block. Zoomy pages and Ask Coop are untouched; chat already blocks `gl_` names.
- **Release steps (Staging):** set `NICHIDO_URL` / `NICHIDO_SERVICE_ROLE_KEY` in the Staging deployment *before* this ships (without them Goldline pages go empty). Then deploy, run the copy `--apply` once more, `--verify`, and apply `supabase/nichido/archive_lock_goldline.sql` on the archive. That file revokes writes on the old `gl_*` tables and functions and closes the old bucket to new files.
- Tests: `test/goldline-nichido-guard.test.ts` (no Goldline module may read the archive env or build its own client) and pairing cases in `src/coop-env.test.ts`.

## 2026-10-22 — Ask Coop can add and compare figures, honestly
A teammate asked "give me the total" after a September channel chart and Ask Coop refused ("I'm not allowed to add figures myself") because the old rule said never calculate and no tool returned a total. Three changes, cheapest first:
- **Totals in code.** `get_channel_report` now returns `meta.totals`: an "Online total" (Shopee, Lazada, Website) and "All channels" (adds Offline) computed in whole centavos, with AOV as total revenue over total orders (never an average of AOVs). A channel that is not complete is named as left out with its reason and makes the total `partial`; ad spend and ROAS are not totalled (no ad revenue to recompute ROAS from). The totals sit in `meta`, not in `rows`, so the auto-drawn chart cannot double-count. Only at granularity `total`. The tool's input schema did not change (strict-tool grammar budget).
- **Guardrail loosened, not removed.** The model may add, subtract, divide or average figures that are in this turn's tool results, must show the working in one line and say "calculated", prefers a tool's total, never mixes time bases or a partial channel into a total shown as complete, and still never estimates, forecasts or prorates. Rule THINK-03 and the config line were rewritten; the prompt grew by about 145 tokens (budget test 14,300 to 14,400).
- **Verifier.** `number-check` still only logs and never blocks, but a figure is now classed `derived` (not unmatched) only when **the working is in the answer**: the result and every operand sit in one sentence that has an arithmetic operator or the word "calculated". It must equal a sum, difference, average, ratio, share or percent change of figures that are in the tool results. Decision: a first version accepted any coincidental combination and, replayed on random wrong answers, blessed about 20% of wrong counts and 16% of wrong percents; the working-line rule brought both to 0% (lesson `verifier-must-see-the-working`). Averages are only for pesos and counts, never AOV, ROAS, ACOS or percentages (the prompt says so too). A wrong sum stays unmatched. Caps: 12 operands (a repeated figure counts once), subsets of 2 to 6, two rounds. Known limit: "₱100 + ₱100 = ₱200" is not verified because a repeated figure counts once; it is only logged. The Website total's note says its figures are live CRM orders while Shopee and Lazada come from saved rows and digests, so it is not like for like.
Defaults used for the two open questions, easy to change: "total" means all channels with complete figures, naming them; "calculated, with the working shown" is enough (no UI badge). Not yet checked with a live model (the local Anthropic key is capped until 2026-11-01): scripted golden cases only; a live staging question and a strict-bytes re-measure are required before any release to `main`.

## 2026-10-22 — Weekly Shopee import written as an instruction for an LLM agent
New skill `.claude/skills/shopee-weekly-import/SKILL.md` (tracked, like `pr-description`) and a section in `docs/shopee-import.md`: the Monday routine as steps an agent can follow with the import API or the developer command (coverage, plan, read, apply, verify, report). Decision: the routine is documented as an instruction, not built as another command, because the existing plan, apply, undo and coverage already do the work and the judgement (read the plan, stop on a flagged or frozen day, never force a rejected file) is what needs writing down. Hard rules in it: shop-total exports only (a per-order export is never opened or imported), the token and keys are never printed or committed, one environment per run with PROD only on the co-worker's OK, restate only with the owner's written reason, and undo instead of SQL. Documentation only; no code or data changed.

## 2026-10-22 — Weekly Shopee reports: ads, SKU, traffic and product funnel
The importer now takes all five weekly Shopee exports. Decision: for these four reports one file is one snapshot of its period, so there is no day-by-day merge; the app reads the newest accepted import per week (ads, SKU) or per day (traffic, funnel) through views, `apply` is one status flip and `undo` flips back, the same append-only rule as the sales figures. Ad spend, ROAS and Shopee top products on the Sales range page now come from the imported weeks: each week is shaped as a digest window and goes through the existing whole-window readers (a week counts only when it sits whole inside the chosen dates; the newest run wins over an overlapping digest). They do not touch the revenue totals, which stay on the daily sales. Traffic and the product funnel are stored and in the data catalog but no page shows them yet. The SKU export lists only the top performing products, so each product list says how much of the week's sales it covers and a ranking is treated as a lower bound, never the whole week. The original files (shop totals only, never a per-order export) are kept in the private bucket `shopee-imports`; if the bucket is missing the import carries on without the stored original and says so. New SQL: `supabase/shopee_weekly_reports.sql`, applied after `shopee_import.sql`.

## 2026-10-22 — Import API health check and a clearer 503
`GET /api/shopee/import/health` (signed in, like `/api/chat/health`) reports whether `SHOPEE_IMPORT_TOKEN` is set, whether the archive database is configured, and counts of accepted imports and loaded days; booleans and counts only. The import routes' 503 used to say "import API is not configured" for two different causes (no token, or mock mode with no archive database), which sent the first staging check down the wrong path. The route 503 now says the archive database is not configured; the missing-token 503 keeps its own message.

## 2026-10-22 — Weekly Sales page uses the imported Shopee facts (digest rewiring R2)
The weekly channel view (`/?channel=...`) now takes Shopee revenue, orders, units and AOV from the imported daily facts when every day of the selected period has one, so it agrees with the date-range view. A period with any missing day keeps the digest's own figures, so a partial week never under-reports. Ads spend and ROAS stay as published (no daily source). When the two totals differ, one line under the header shows both. Decision: the stored digest is not rewritten; only the view overlays it (`src/shopee-facts-overlay.ts`). Backend digest reading the facts (R3) is a separate step.

## 2026-10-22 — Shopee import API (stacked on the import command)
`POST /api/shopee/import/plan` (multipart files), `POST .../apply` (`importIds`), `POST .../undo` (`importId`, `reason`) and `GET .../coverage`, over the same pipeline as `npm run shopee:import`; handlers in `src/shopee-import/api.ts`, thin route files in `app/api/shopee/import/`. Decision (owner): bearer token only (`SHOPEE_IMPORT_TOKEN`); with no token every call answers 503, a wrong or missing one 401. Outside the page sign-in on purpose (like the chat route, the handler authorizes itself). Limits: 30 files of 5 MB per request, only known Shopee file names are read, files are never echoed back. This is the door for the Mac's weekly run (digest rewiring step R3) and a later upload page. Verified over real HTTP on the local stack with real weekly files (plan, apply, coverage, same file again = "already loaded").

## 2026-10-22 — Shopee weekly import: exact daily sales, safe to repeat (`npm run shopee:import`)
New pipeline in this repo (`src/shopee-import/`, `scripts/shopee-import.ts`, `supabase/shopee_import.sql`, runbook `docs/shopee-import.md`). It loads the Sales Overview export into append-only tables (`import_runs`, `marketplace_daily_observations`); what the app reads is the view `marketplace_daily_sales`, the newest accepted import per day. Decisions (owner, 2026-10-22): the pipeline lives here, not in the backend; the API will use a bearer token only; days freeze after 28 days; confirmed sales are the basis; raw files go to a private bucket (later step).
- **Safe by construction:** `plan` is a dry run that writes only inert staged rows; `apply` is one status flip; `undo` flips it back and the view falls back by itself; nothing is ever updated or deleted by an import. A file that fails a check (dates, one row per day, daily sums equal the file's totals) is rejected whole and recorded. The same file twice does nothing. Today and later are never loaded. A plan is refused at apply if the figures it was made against moved.
- **The weekly run is unchanged:** the Mac's digest run, its folder and its five files are not touched; the importer is one more reader of the same files (flat folder or per-week sub-folders), and `digest.daily` inside the digests stays.
- **Replaces** the never-filled table `marketplace_daily_sales` with a view of the same name and columns, so the Sales page and Ask Coop readers shipped in v1.12.0 work unchanged. The SQL refuses to drop that table if it has rows. The backend's table writer (coop-pipeline #47) is no longer needed.
- **Real-data test (local database, 15 weeks, 105 days):** the loaded sums equal the digests exactly (Aug 1 to 31 ₱86,324; Sep 1 to 30 ₱59,228; Sep 1 to 27 ₱51,989; Oct 1 to 4 ₱5,469); Jul 6 to Aug 4 is ₱123,768 (the old July digest said ₱117,564 for a window that also includes Jul 5).
- **A rule I got wrong and the real files caught:** confirmed sales can exceed placed sales on a day (13 Aug, 18 Aug), so that is not a check. Lesson `knowledge/lessons/check-the-assumption-on-every-row.md`.
- `reconcile` (digest rewiring step R1, plan section "Digest rewiring"): lists each stored digest's Shopee revenue against the sum of the imported daily confirmed sales for the same days (placed by Shopee's own export dates when the digest has them), with the gap. It reads `digest_archive.digest` only (never `bundle`) and changes nothing; run it on staging after the backfill to measure how far old digests are off.
- Not yet: product (SKU), ads, traffic and product-overview importers; API endpoints; raw file storage; the coverage banner. `tsx` added as a dev dependency to run the command.

## 2026-10-21 — v1.12.1: hotfix, Ask Coop answers again (prod release)
Patch bump (SemVer): bug fix only. v1.12.0 made every Ask Coop question fail on PROD with the provider's 400 "The compiled grammar is too large": the fields added to the strict tools `get_digest` and `lookup_product` pushed the strict set over the API's compiled-grammar cap. Both tools are now non-strict (like `list_crm_*` and `ask_owner`); their executors already validate every field (`shapeDigest`, `lookupProduct`), and `request-shape.ts` allows them. Strict schema bytes: v1.11.0 9,887 (worked), v1.12.0 10,375 (broke), this fix 8,099. No behaviour change otherwise. Lesson: `knowledge/lessons/strict-tool-grammar-cap.md`.

## 2026-10-21 — v1.12.0: Ask Coop answers a product's offline sales with bundles, ranks website products, and Shopee and Lazada can be summed from per-day rows (prod release)
Minor bump (SemVer): new, backward-compatible features. Selective release by cherry-pick from `develop`, on top of v1.11.0: PRs #232, #233 and #234 ship.

- **Offline product in one answer:** `lookup_product` `show: "sales"` gives direct orders, units and revenue, the units picked inside bundles with the bundle's price shared out (equal share per unit, the list-price share beside it) and the combined total, for the owner's dates.
- **Website products for any dates:** `list_crm_orders` `group_by: "product"` ranks the products sold on the website; the live prompt tells Ask Coop to call the tool that holds the figure instead of offering to look.
- **Per-day Shopee and Lazada rows:** the Sales range view and Ask Coop's `get_channel_report` also sum from the backend's `marketplace_daily_sales` table (the view `coop_chat_marketplace_daily` for Ask Coop). Both are soft: with no table or no rows they behave exactly as in v1.11.0.
- *Manual SQL (optional, not needed to release):* the table (`supabase/marketplace_daily_sales.sql` in `zoomy-observability`, PR #47, needs #42) and then `supabase/coop_chat_marketplace_daily.sql` here. Nothing fills the table until the backend writer is deployed.
- *Catalog:* only the `marketplace_daily_sales` entry was added to `src/chat/catalog/catalog.json` (digest domain); the knowledge base is ahead of `main`, so a full regeneration would describe things `main` does not have.
- Per-change detail is in the entries below.
## 2026-10-21 — Ask Coop: an API spend cap says "account needs attention", not "try again"
When the provider refuses with a usage-limit 400 ("You have reached your specified API usage limits"), Ask Coop now shows the same account message as a low credit balance instead of the generic "Coop hit a problem answering that. Please try again." Found when two identical questions failed with the generic text and the cause could not be told apart from a code fault. No provider text is shown to the user.

## 2026-10-21 — Ask Coop: get_channel_report reads the saved per-day Shopee and Lazada sales
Ask Coop's channel report now merges the backend's `marketplace_daily_sales` rows with the stored digests' per-day figures, the same way the Sales range view does, so both give the same totals for the same dates. The read follows the digest pattern: its own one-relation guarded client (`chatDailyClient`, `src/chat/read/daily.ts`), the view `coop_chat_marketplace_daily` (`supabase/coop_chat_marketplace_daily.sql`, applied by hand, `coop_chat_ro` select only) in `ro_role` mode, the table with an explicit column list in `guarded_service` mode. Soft: a missing table or a failed read gives no rows and the report uses the digests alone. Decision: the table is never granted to the read role; only the view. Verified on the local Docker stack in both read modes.

## 2026-10-21 — Sales range: totals can come from the backend's per-day rows
`src/marketplace-daily-data.ts` reads `marketplace_daily_sales` (one row per PH day per Shopee or Lazada channel, written by every digest run; backend PR #47) and `src/daily-sales-digests.ts` shapes the rows, grouped by the run window that wrote them, as digests carrying `daily`. The Sales range view's rollup merges them with the stored digests unchanged (newest run wins per day, a day inside a run's window with no row is a zero), so a custom span is summed from rows where they exist. Ad spend, ROAS and top products still read whole digest windows. Soft by design: mock mode, a missing table or a failed read gives no rows and the page behaves exactly as before. Decision: Ask Coop does not read the table yet; its read guard only allows registry views, so that needs a `coop_chat_*` view and a hand-applied grant (parked). Verified against the local Docker Postgres, not a hosted project.
## 2026-10-21 — Ask Coop: one product's offline sales in one answer, bundles shared out
`lookup_product` takes `show: "sales"` with the owner's dates (`""` and `""` for all data): direct orders, units and revenue, units picked inside bundles with the bundle's price shared out, and the combined total, in one registered result instead of free SQL. Decision (owner rule, assumed until said otherwise): the bundle share is an **equal share per unit** (the bundle's price divided by all units in it, times this product's units); the list-price weighted share (the dashboard's `bundle_picks`) sits beside it in its own column. The older-sales caveat (bundle revenue with no pick detail) is kept. Clarify-first still applies to a misspelled product.

## 2026-10-21 — Ask Coop: website products for any dates
`list_crm_orders` takes `group_by: "product"`: the products sold on the website in the owner's dates, ranked by net line revenue (quantity x price minus the line discount), with distinct orders and units. Orders with no readable line items are counted and named, never guessed. The live system prompt now says to answer a sales question by calling the tool that holds the figure (offline `query_metric`, website `list_crm_orders`, Shopee and Lazada all-time `get_digest` window `all`) instead of offering to look. No new tool (20-tool limit unchanged), no database or env step.

## 2026-10-21 — Ask Coop: one product on Shopee or Lazada across all stored digests
`get_digest` takes `window: "all"` plus a `product`. Ask Coop now answers "how many X did we sell on Shopee, all time" in one turn instead of offering to look at older windows. Each stored digest keeps only its own top 5 products per channel, so the answer is a labelled lower bound ("at least", span and windows named), never a total. Decision: the full per-day, per-SKU history needs data the digests do not hold (July to Sep 27 digests have no `daily` and no Shopee block in `bundle`); backfill is parked. No new tool (20-tool limit unchanged); the lookup reuses `spanTopProducts`.

## 2026-10-21 — Sales range: change versus the span before, an Over time view, and a quick chat
All of this appears only when custom dates or "All time" are picked; the weekly Sales view is unchanged (its server-rendered page matches `develop` line for line).
- **Change versus the span before.** Each total shows its change against the span of the same length directly before it, with those dates named ("vs Sep 21 to Oct 4, 2026"). A change is shown only when the two spans can be compared fairly: the same channels have complete figures in both, and ad figures fully cover both. Otherwise there is no number and a plain reason says why. Ad spend change is grey (spending more is not good or bad by itself). This brings back the change-versus-before that the weekly view already shows and a custom span lacked. A toggle turns it off; it follows the channel chips.
- **Over time, inside Compare channels.** A "By channel / Over time" switch plots revenue, orders or AOV per week or month. Bars for a week or month your dates cut short, or where a channel has no complete figures, are hatched and marked "partial". Ad figures are not plotted over time: they come per export window, not per week. More than 27 weeks falls back to months.
- **Quick chat.** A question box and four chips (the Ask Coop panel beside the graph) open the existing Ask Coop drawer with the question. No new AI endpoint and nothing runs until someone asks; answers, number check and rate limit are Ask Coop's own.
- **Fix: the chat drawer named the wrong period.** While dates were picked it said "Answering about" the selected week. It now names the span (or all time), and the chat's page context says plainly that the Sales page is showing that span, not one week.
- **Layout:** the five totals spread across the full width; Top products sits under the bar graph; the Ask Coop panel sits to the right. The "recommended actions are written per week" note is gone (there are no actions for a span).
- **Decision (owner):** no "What stood out" commentary and no AI summary for a span. If a line is not surely accurate it is a risk, so it stays off the page. The AI summary design is parked in `knowledge/best-practices/ai-summary-on-demand.md`.
- Tests: `test/sales-range-compare.test.ts` (14), more cases in `test/sales-range.test.ts` and `test/chat-pages.test.ts`.

## 2026-10-20 — One Sales page: any dates or all time, no separate Sales range page
- **The Sales page now takes any dates.** The top bar's "Custom dates" button is no longer limited to the selected week: pick any days with data up to today, or "All time", and the same page (`/?channel=all&from=…&to=…` or `&span=all`) shows that span. "Snap to whole weeks" appears when your dates cut a Monday to Sunday week and only moves them on a click. With no dates picked the page is the selected week, exactly as before (checked: the server-rendered page differs from before only by the removed nav item).
  - *Why:* the owner tried the separate `/sales-range` page (previous entry) and decided one Sales page is clearer than two. The calculation, tags and tests from that page are unchanged; only where they live moved.
- **Range view on the Sales page:** totals per channel, plus Ad spend and ROAS beside them, Compare channels, Top products, an amber banner for real gaps and a quiet "where these numbers come from" list.
- **Recommended actions** are written per week, so in range mode that column says so and links to the latest weeks.
- **Period switcher** reads "Custom span" or "All time" while dates are picked; choosing a week clears them. The clear (x) on the date button returns to the selected week.
- **`/sales-range` is now a redirect** to the Sales page and keeps its dates, so shared links still work. The "Sales range" sidebar item is gone.
- **Replaced:** the old clamped custom-dates path on the Sales page (`resolveCustomRange` there, the per-channel `custom` props) is no longer reached. The leftover props in `channel-compare.tsx` are harmless and are left for a separate cleanup so this diff stays reviewable.
- **Data catalog:** `/` row updated (new params and sources), `/sales-range` listed as a redirect; `catalog.json` regenerated.
- Tests: `test/sales-range.test.ts` gains the link-detection and recent-weeks cases (27 in total).

## 2026-10-20 — Sales range: sales over any dates, or all time (new page `/sales-range`)
- **New page, sidebar "Sales range".** Pick any dates across weeks, or "All time", and see revenue, orders, units, AOV, ad spend, ROAS and top products for that span. The weekly Sales page (`/?channel=all`) is unchanged.
  - *Why:* the weekly page clamps custom dates inside the selected week, so a month or the whole history could not be viewed. The owner chose a separate page over changing the existing one.
- **Sales, orders, units and AOV are exact for the days picked.** They reuse the rollup Ask Coop already uses (`src/period-rollup.ts`): Shopee and Lazada from the digests' per-day sales, Website from live CRM orders, Offline from completed POS orders. AOV is total revenue / total orders, never an average.
- **Ad spend, ROAS and top products use whole windows only.** Those figures exist once per export window, not per day, so a window counts only when it sits entirely inside the dates. ROAS is total ad revenue / total spend (`roas x spend` per window). Overlapping windows are never summed: the newest wins and the rest are named. Every ad number carries a tag ("4 full windows"), and a span with no full window says "No data" instead of 0.
  - *Decision (found on staging, 2026-10-20):* a digest's Shopee ad figure belongs to the ads export's own dates, not the digest week. Three July digests carried ads windows of 31, 32 and 14 days that overlap, so weekly-digest summing would have double counted. Windows are therefore placed by `digest.shopee.ads.window` (Lazada: its facet window, else the digest window).
  - *Inside means every day it touches:* a window that starts at 08:00 PH on a Monday is not inside a span that starts Tuesday. A Shopee figure with no export dates of its own is never placed by the digest week; it is skipped and named. Lazada's facets share the digest's query window, so it falls back to that.
  - Shopee/Lazada top products are tagged "Approximate" when several windows are merged: the backend keeps only each digest's top 5. Website top products are exact, from live orders.
- **"Snap to whole weeks"** (never automatic) moves dates that cut a Monday to Sunday week out to whole weeks; the end stops at the last finished Sunday. **No dates in the link** shows the last 4 finished weeks. Dates are clamped to the first stored digest and today (PH time); reversed dates are swapped.
- **Coverage is shown, not hidden.** An amber banner lists real gaps (partial, not combinable, not connected); where the numbers came from sits in a quiet list below.
- **Shared pieces touched:** `Calendar` gets an optional `weekStartsOn` (default Sunday, so every other caller is unchanged); the shell gets the "Sales range" nav item (desktop rail and mobile More) and hides the weekly period switcher on this page.
- **Data catalog:** `/sales-range` added to `knowledge/data-catalog/pages.md`; `catalog.json` regenerated.
- Tests: `test/span-windows.test.ts` (19) and `test/sales-range.test.ts` (22), including the real staging windows.
## 2026-10-20 — Ask Coop: confidence matches, "might these be the same person?" (P4 of 4)
- **Asked:** same customer across platforms by same phone, email, pet name, with a confidence.
- **What changed:** `contacts` gets mode `matches` (scope: one person by query, an event's leads, or two sources; `min_tier` narrows). Every link has a score, a tier (confirmed 100, likely 60 to 99, possible 30 to 59, weak below 30), the reasons and a signals key, best first, top 50. Points (owner-agreed starting weights, in `WEIGHTS` in `src/chat/contacts/match.ts`): email 100, mobile 100, Instagram handle 60, same name 40, similar name 20, same pet name 20, capped at 100.
- **Decisions:** (1) a mobile under 3 or more different names is a shared line and scores 20, not 100; (2) pairs are independent, no grouping, so one wrong link cannot chain; (3) candidate pairs come from shared blocking keys, and a key shared by too many records (40 for names and pets, 100 for exact keys) is skipped and said, so a very common pet name cannot blow up the work; (4) the "booth-to-order 30" signal from the plan is dropped: a till order carries no identity that could link to the website or Lazada, so it could never add evidence across platforms; (5) only "confirmed" may be called the same person.
- **Not yet done:** tuning. The owner labels about 20 pairs (signals pattern and verdict) and the weights and cut-offs are re-set; target at "likely and up": 9 of 10 right.
- **Tests:** tiers, each signal, shared phone, common-name cap, no chaining, the three anchors, output and notes, executor and audit. Live model check and staging test are for a person.

## 2026-10-19 — Ask Coop: find one customer across the website, booth and Lazada (P3 of 4)
- **Asked:** "find Anna Reyes (or a phone or email)" with every source, orders and spend, and "which website customers also bought on Lazada?".
- **What changed:** `contacts` gets modes `find` (a name, email, mobile or pet name; up to 10 people, row-numbered) and `overlap` (people in two sources). They use the Customers hub's own merge (`mergeContacts`: same normalised email OR same last-10-digit mobile), so the groups equal `/customers/all`. The website side is read through the chat's existing GET-only CRM client (one `chat_crm_call` line per read, never `crm-data`); Lazada comes through the seam; booth leads as before. One `chat_pii_read` line per call, never the query.
- **Honest degradation:** a source that could not be read is named in the answer, and an overlap involving it is refused instead of reported as empty. A misspelt name is not guessed. A Lazada buyer with a masked or missing phone is not linked (only a mobile links them).
- **Also:** `mergeContacts` gains additive fields (`pets`, `campaigns`, `names`, `emails`, `mobiles`) so a person is found by any of their identities and shows every pet and booth event; the Customers page is unchanged. The CRM customer enrichment is extracted once (`crmEnrichedCustomers`) and shared with `list_crm_customers`.
- **Decision:** no scores or "probably the same person" yet: that is P4. Exact keys only keeps the answer identical to the Customers page and nothing to tune.
- **Tests:** merge additions, find/overlap module (key spellings, caps, masked phone, source down, parity with the hub), executor with the fake CRM client and audit. Live model check and staging test are for a person.

## 2026-10-19 — Ask Coop: draft messages for an event's leads (P2 of 4)
- **Asked:** "write a thank-you with the promo for those leads", and a personal one for a few.
- **What changed:** `contacts` gets mode `draft` (same allowlist, seam and audit line as P1). Big list: the model writes ONE template and the app fills `{{pet}}`, `{{prize}}`, `{{event}}`, `{{treats}}`, `{{collected_date}}` for each lead in a single pass; unknown placeholders are refused. Small batch (up to 25): the model writes each message itself, addressed by the row numbers of the list. Channel is email, SMS text or Instagram DM text; a lead without that contact is skipped and counted. The owner gets a Drafts table with Copy all messages and Download CSV. The model only sees counts and 5 sample drafts, never the full list. **Nothing is sent.**
- **Also:** the leads table now has a row number and a "Bought at the till" column (the leads page's own time-based order match; an unsure match is labelled). The seam loads orders for it and fails soft, like the leads page.
- **Decision:** values a customer typed are stripped of markup, links and braces, and merged once, so a pet field holding `{{prize}}` or a link cannot expand or be sent along. Messages stay copy-out only (owner decision 2026-10-19). Identical drafts are all kept when copying.
- **Tests:** draft module (placeholders, one-pass merge, cleaning, per-lead, channel skips), tool wiring and audit, Copy all; Explore prompt snapshot + contacts topic text. Live model check and staging test are for a person.

## 2026-10-19 — Ask Coop: the leads of an event, with contacts (P1 of 4)
- **Asked:** "give me all the leads from this event with emails, mobiles, Instagram and pets". Plan `knowledge/tasks/2026-10-19-ask-coop-customer-leads-plan.md`; practice note `knowledge/best-practices/chat-customer-data-access.md`.
- **What changed:** a new `contacts` tool (mode `list_leads`) for the people on the SQL explorer's allowlist only (same gate: no explore, no tool). The app draws the table itself (email, mobile, Instagram, pet as typed, estimated species, picky, prize, collected date, first sign-up consent date) with Copy emails, Copy mobiles and Download CSV. The model gets the counts and the first 50 rows and the notes, never a tool to write or send anything. An unclear event name asks "Which event?" first (same matcher as products).
- **Decisions (owner, 2026-10-19):** the model sees the full contact values; no consent filter (any lead with a contact is listed), shown instead as a consent column and a count of leads with no consent date, plus a standing "first sign-up only, honour unsubscribes" note; the SQL explorer is left as it is; copy and CSV only, nothing is sent.
- **Isolation:** the route injects `ctx.leads` from `app/api/chat/leads-seam.ts`, which reuses the `/customers/leads` loaders (`getSpinLeads`, `getPosEvents`), so the chat sees exactly what a signed-in owner sees there and no database role or view is added. `src/chat` still imports no data layer; the seam is the one named door in the architecture test, and a test pins what it imports.
- **Safeguards:** customer-typed text is stripped of markup and capped; the tool is in the untrusted-text set; one `chat_pii_read` audit line per call (user, event id, row count, column names, never a value); contact turns are redacted before the chat is saved in the browser; the CSV writer is shared with the CRM page and defuses spreadsheet formulas (`src/csv.ts`).
- **Not in P1:** drafted messages (P2), one customer across platforms (P3), confidence matches (P4), and what each lead bought. Staging test and the live tool-size probe are for a person (the probe needs an API key); no SQL, no new env.
- **Tests:** csv, contacts pure module, tool wiring and audit line, request shape and tool cap (20), storage redaction, Explore prompt snapshot (+ the `contacts` topic; skill budget 7,210 to 7,610).

## 2026-10-19 — Fix: Ask Coop stock answers failed on staging (permission denied for table pos_products)
- **Symptom (staging):** "How many … yogurt cubes" confirmed the product, then "the stock lookup returned an error". Earlier, the same question timed out because the model fell back to its own SQL.
- **Cause:** `coop_chat_stock_by_location` selected from zoomy-pos's `pos_inventory_by_location`, which is `security_invoker=on` on staging. A security_invoker view checks its base tables against the caller (`coop_chat_ro`, no table grants by design), so the read failed and the stock data was null. The local fixture had a plain view, so tests and local runs passed.
- **Fix:** `supabase/coop_chat_stock.sql` now builds that view from the base tables (`pos_products` x `pos_locations` left join `pos_inventory_lots`, a hand-kept copy of the zoomy-pos body, same rows and a bigint `stock`), inside one transaction (drop and create, so a failure changes nothing). No `pos_*` object is touched and no grant is added. The local fixture now sets `security_invoker = on` like staging, and a test pins that the chat view never reads `pos_inventory_by_location`.
- **Verified:** reproduced locally (definer view over a security_invoker view: permission denied; straight over the table: works); with `security_invoker` on, the new view reads as `coop_chat_ro` with the same numbers (P1 12/60, P2 0/25), raw tables still denied, and the app in `CHAT_READ_MODE=ro_role` answers with the four tiles. 3196 tests, data catalog OK.
- **To apply (a person):** re-run `coop_chat_stock.sql` on staging (SQL only; no deploy). Lesson: `knowledge/lessons/definer-view-over-security-invoker-view.md`.

## 2026-10-19 — Ask Coop answers inventory: one product in one call, and BoxMe online stock
- **Why:** "How many inventory do we have for the yoghurt cubes" had no single-product stock tool (the model wrote its own SQL and timed out), and Ask Coop could not see BoxMe at all, although the Inventory page reads it.
- **One product:** `lookup_product` show `stock` returns ONE row (Event, Office, BoxMe available, Total), drawn as stat tiles; the app draws them when the model does not. BoxMe's reserved, incoming, damaged, per-warehouse split and next expiry are in the notes. A misspelled name is still confirmed first (previous entry). Live on the local Supabase: 2 steps, about 6 s.
- **Lists:** `stock_on_hand` dimensions `online`, `all_channels` (Event + Office + BoxMe = Total per product; products only one side stocks are named) and `expiring_online` (BoxMe lots inside their expiry window); `stock_cover` dimension `online`. Dimensions rather than a new metric id, so saved reports are unaffected.
- **How BoxMe gets here:** the backend's daily GitHub job (inventory only; staging only so far) writes `boxme_*`. The chat reads it through six definer views (`supabase/coop_chat_boxme.sql`, **apply by hand, staging first**) or the base tables in dev mode, with the page's own columns and mapping (`src/boxme-feed.ts`, now shared) and the page's compute (`buildBoxmeInventory`: rows of the last good sync only).
- **Honest freshness:** every BoxMe answer says "as of the last good sync, <PHT>". A sync older than a day, a failed or a partial sync is said first. BoxMe not connected or never synced is said, never shown as 0. BoxMe "sold per day" is an estimate from daily stock drops, never orders.
- **Decisions:** the views are not added to Explore's view allowlist (Explore reads the raw tables, so no second hand-applied change); the BoxMe tables join the `stock` catalog domain (no new `list_tables` value). Data catalog updated, `catalog.json` rebuilt, `check.mjs` OK. Grammar probe passes with the new dimension values.
- **Verified:** 3195 unit tests, typecheck, build; live on the local Supabase with synthetic BoxMe rows: "chiken jerky" → confirm → 92 units in 4 tiles; "chicken jerky" → tiles, no question; "which BoxMe lots are expiring soon?" → the one lot with its sync time. As `coop_chat_ro` the views read and the raw `boxme_stock` is denied.

## 2026-10-19 — Ask Coop asks before it guesses (product, dates, channel, comparison)
- **Why:** the owner asked "How many inventory do we have for the yoghurt cubes"; Ask Coop drew a chart from its own SQL, then ran out of time. A misspelled name matched nothing, and vague questions were answered with a guess. Owner rule: **always confirm a product that is not an exact match**; ask instead of guessing the other details too.
- **Products:** one word-by-word, typo-tolerant matcher (`src/chat/product-resolve.ts`) over the POS catalog plus sold lines, so products that never sold resolve too. A SKU, the exact name, or a name whose words all appear in exactly one product answers at once ("yogurt cubes"). A spelling match ("chiken jerky", "yoghurt cubes") or several matches end the turn with "Did you mean **Chicken Jerky**?" and a tap button per product.
- **Missing details:** a new `ask_owner` tool asks one fixed question with tap buttons when the question has no dates ("Which dates should I use?"), no channel for a sales question ("Which sales channel?": All channels, Offline, Shopee, Lazada, Website), or "compare" with no target. The model picks only the topic; the wording and choices are fixed in `src/chat/clarify.ts`.
- **How it ends the turn:** a tool returns `{clarify}`, and the chat loop writes the question itself and stops (`stopReason: clarify`), so the model cannot skip it. The buttons are the drawer's existing `<suggest>` chips (cap 3 → 5): a tap sends the choice as the next message. No new stream event or UI component.
- **Dates the data does not cover:** `query_metric` asks "The offline (POS) sales data covers <dates>, so there is nothing for <dates>. Use the dates the data covers?" instead of returning empty rows that read as ₱0.
- **Calendar months:** a period that is whole calendar months now compares with the previous whole months (September vs August 1 to 31, not Aug 2 to 31); uneven lengths are said. Offline revenue, orders and AOV gain a by-month series; a by-day series longer than 92 days is shown by week, said first.
- **Timeout after a chart:** "Here is what I found before time ran out." instead of the failure text when a chart is already drawn.
- `ask_owner` is sent non-strict like the `list_crm_*` tools (it adds nothing to the compiled grammar). Grammar probe (`test/chat-tools-grammar.integration.test.ts`): all three tool sets pass with the new `month` value.
- **Verified:** 3176 unit tests, typecheck, `next build`; live in the drawer against the local Supabase: "chiken jerky last month" → confirm → 24 units; "offline revenue" → dates question → ₱38,147 for September; "sales last week" on Overview → channel question → channel report.
- Plan: `../knowledge/tasks/2026-10-19-ask-coop-inventory-plan.md` (Phase A). Next: Phase B, inventory (one product's stock, BoxMe).

## 2026-10-15 — Ask Coop answers again on prod: the three CRM list tools are not strict
- **What broke:** on prod every Ask Coop question failed ("Coop hit a problem answering that"). The API answered 400 "the compiled grammar is too large" before any token: Explore and the four website CRM tools together put 18 strict tools in one request (the staging config sent 14 and worked). Found by logging the 400 message (#195).
- **Fix:** `list_crm_orders`, `list_crm_customers` and `list_crm_checkouts` are sent with `strict: false`; `get_crm_metrics` and every other tool stay strict. A key the model leaves out takes its default (limit 25, offset 0, filters "all", group_by "none"); the dates have no default; an unknown key (a url, a method) is still refused before any read; the CRM client is still GET-only.
- **Measured:** probes against the live API at `max_tokens: 1`: base 11 and Explore 14 pass, base plus the four CRM tools (15) and all 18 fail; with the three list tools non-strict all 18 pass. `test/chat-tools-grammar.integration.test.ts` repeats this (skipped without an API key): run it before a deploy that touches `metrics-registry.ts`, `tool-defs.ts` or `crm/tools.ts`, because a new metric or dimension grows `query_metric`'s enums and uses up the headroom.
- Also logged: `chat_error` carries the first 300 characters of a 400's message (#195).

## 2026-10-14 — Top products / Top bundles: labelled shares replace the relative bars
- Removed the thin bars under each ranked row. They showed each item relative to #1, which wasn't explained anywhere and read as confusing "progress bars".
- Each row now shows a plain share under its value: "11% of revenue" (Revenue), "18% of units" (Units), and for bundles "13% of revenue" or "82% of bundle orders". Revenue shares use the Revenue KPI (bundles included), so they line up with the top of the page; slivers read "<1%".
## 2026-10-14 — Free items won: show which event each prize was given at
- Each prize card on `/offline-sales` now names its **event**, linking to that event's page; prizes with no event read "No event".
  - *How:* the prize's order event tag (`pos_orders.event_id`), else the event covering the order's date, the same read-time fill the Events page uses (`resolveOrderEvents`). Read-only, no schema change.

## 2026-10-14 — Offline Sales lists: calmer, easier to scan
- **Less glare.** Shared toggles (`SegmentedControl`, e.g. Revenue/Units, Top/Bottom; used across the analytics pages) and the range tabs now mark the active option with a soft muted fill instead of solid bright green. Status colors are soft tinted chips instead of colored text and uppercase headings.
- **Top products / Top bundles:** each row leads with one number (the selected measure) and puts the other on a secondary line ("46 units · 11 in bundles"). A thin bar under each row shows its size relative to #1, so the gaps read at a glance. Bundle deals became a small summary box ("Items ₱35,242 + bundles ₱18,617 = ₱53,859 total revenue").
- **Recent orders:** rows lead with what sold ("Meaty Treats Chicken ×4 +2 more"), then time and payment method, with a dot in the method's chart color. Voided and oversold show as chips.
- **Stock:** status chips ("Out", "3 left"), and the old monospace "10 healthy · 18 low · 2 out" line is now a small health bar with a color legend.
- **Stock alerts:** three soft lanes (Out of stock, Running low, Near expiry) with sentence-case titles and count chips; an empty lane says "All clear" with a check instead of "None".
- **Layout:** on wide screens the lists sit in three content-sized columns (products | recent orders | bundles over stock) so short lists no longer leave big holes; stock alerts span the full width below.
- **Free items won:** a compact 3-across card grid (product first, then who and when) with an icon-only Undo, showing 6 with a "Show all" toggle. Add prize became a quieter outline button.

## 2026-10-14 — Offline Sales overview: more breathing room
- Wider spacing on `/offline-sales` after the full-width layout felt cramped: grid gaps 16 → 20px (24px from laptop up), a bigger gap under the range toolbar, roomier panel padding (24px on laptop+) and KPI cells, and a little more space between list rows.
- Top products names wrap to two lines instead of truncating, since the three-across row made columns narrower.

## 2026-10-14 — Offline Sales overview: full width, responsive grid
- **`/offline-sales` now uses the whole screen** (dropped the `max-w-5xl` cap, like Events and Transactions) and lays out on a 12-column grid that reflows by width:
  - **Wide (xl):** one hero row with event (3), daily goal (4) and KPIs (5); Sales over time (8) beside Pet mix (4); then Top products, Top bundles and Recent orders three across; Stock beside Stock alerts.
  - **Laptop (lg):** event + goal side by side, KPIs 4 across under them; chart and pet mix full width.
  - **Tablet (md):** lists two across. **Phone:** single column.
- **KPIs are one segmented card** (hairline dividers) instead of four boxes: less chrome, reads as one summary.
- **Range and payment option share one toolbar** under the title, since both scope every number below; Refresh sits top right.
- Panels in a row stretch to equal height with their "View all" footers pinned to the bottom. On wide screens the Pet mix legend turns into a row-per-pet list so it fills the space beside the chart, and the chart grows to 260px.
- The spin-the-wheel prizes panel follows the same full width.
- Copy: event dates read "Oct 10 to Oct 17" (was an en dash) and the Stock empty state drops its em dash.

## 2026-10-13 — Motion polish: dialogs animate in and out, reduced motion app-wide
Coop half of a POS + Coop motion audit (`design-motion-principles` skill, Emil primary / Jakub secondary). The user picked which findings to fix.
- **Seven hand-rolled dialogs now share `ModalShell`** (`components/analyst/modal-shell.tsx`): Add stock, Move stock, New product, Bundle, Undo free taste, Edit (price/target) and Edit stock. They used to snap in and out in one frame. Now the backdrop fades over 150ms and the panel fades + scales from 0.96 over 180ms (ease-out-quint), and closing fades both over 120ms with no scale (exits are subtler than enters).
  - *How:* the enter is pure CSS (`starting:` / @starting-style). The exit comes from `useModalExit(onClose)`. Each dialog shadows its `onClose` prop with the hook's animated `close`, so every existing close path (Escape, backdrop, X, Cancel) plays the exit without touching each call site. Parent `{open && …}` mounting is unchanged.
- **The batch/upload review lightboxes fade in** over 150ms. An exit would need a restructure (they're inline, not components), so that was left out.
- **Reduced motion is now app-wide:** one `prefers-reduced-motion: reduce` rule in `globals.css` collapses every transition and animation. Before, only 15 of ~80 animating components had their own guard. Loading spinners keep turning (functional, not decorative), and `useModalExit` closes immediately.
- **Kept as is (user call):** the Ask Coop shine, the "Happening now" ping and the channel chip hint. The Chat and Playbook drawer exits weren't chosen this round.
- Verified: typecheck, 2610 tests, and in the browser (Add stock open + Escape close, with and without reduced motion).

## 2026-10-13 — Transactions filters: fewer visible choices, removable filter pills
- **The filter bar on `/offline-sales/orders` now shows five category triggers (Method, Date, Price, Status, Event) instead of every option at once.** Each opens its own dropdown; picking an option applies it straight away.
  - *Why (Hick's law):* the old bar laid out about 14 choices inline (two segmented controls plus three popovers) and felt cramped. Fewer visible choices means a faster decision, and the full list is still one click away.
- **Applied filters read back as pills** ("Method Cash ×", "Price ₱100 to ₱500 ×") below the bar. Each pill removes just that filter, and **Clear all** resets everything. Triggers keep a fixed label with a dot when applied, so the bar never shifts width as filters change.
- **Date quick ranges:** Today, Yesterday, Last 7 days, Last 30 days apply in one click; the calendar stays for custom ranges. A matching range shows its preset name in the pill.
- Fixed en dashes in the date and price labels ("Sep 1 – Sep 9"): they now read "Sep 1 to Sep 9", per the no-dash UI copy rule.
- Dropdowns animate from their trigger (origin-aware scale + fade, 150ms ease-out), matching the env switcher.

## 2026-10-13 — Event lead contacts: an "Update leads" button replaces the CSV round trip
- **New "Update leads" button on `/customers/leads`.** It pulls every spin-the-wheel lead from the storefront and adds the ones Coop doesn't have yet, then shows how many were added.
  - *Why:* each event meant exporting a CSV from zoomyforpets.com/admin/spin-wheel and running `scripts/import-spin-leads.mjs` by hand.
  - *Where leads really live:* the booth form saves them in **Shopify**, in the shop's `custom.newsletter_subscribers` metafield (rows tagged `source: 'spin-win'`), not in a storefront Supabase table as the old comments said. Coop has no Shopify access, so it reads them through the CRM worker's new read-only `GET /api/spin-leads` (zoomy-crm `feat/api-spin-leads`), using the existing `CRM_API_URL` / `CRM_API_READ_TOKEN`. No new secrets.
  - **Insert-only.** Existing rows are never updated or removed, and pressing the button again is harmless.
  - *Decision:* a lead counts as new when its **contact** (email or Instagram handle) isn't in the table yet. The storefront allows one spin per contact, so this is safe. The table's own key (contact + time) can't be used: CSV-imported rows hold minute-rounded times and Shopify holds seconds, so every existing lead would have looked new.
  - *Decision:* a new lead's `collected_at` is its **consent time**, i.e. the spin itself. Shopify keeps a returning subscriber's original signup date, which is why a few CSV-imported leads show June/July dates. Existing rows are left as they are.
  - Prize ids (`peso300`, `toy-collar`, …) are mapped to the labels the table already uses (`src/spin-leads-sync.ts`). A prize Coop hasn't seen keeps its raw id until it is added there.
  - Fails loudly, never as "0 new": if the CRM worker or Shopify can't answer, the button says so and nothing is written.
- **New "Picky eater" field** (Oct 2026 booth form). It is saved by the button and by the CSV import, and shown as a column once any lead has it. Needs `supabase/spin_wheel_leads_picky.sql` (additive: one new column), **run on prod before the button is used**.
- The leads cache is now tagged, so new leads show up straight away instead of after the 30s cache window.
- Unchanged: unsubscribes. A lead removed from the Shopify list stays in Coop, because the button only adds.

## 2026-10-13 — Transactions page redesign
- **`/offline-sales/orders` uses the full width and groups sales by day.** Each day gets a header ("Sat, Oct 10, 2026 · 2 sales", or "Today" / "Yesterday"), and each row shows just the time, so the date isn't repeated on every sale.
  - Rows lead with what was bought, then the method, event, free-item, IG handle, edited/voided/oversold tags and a unit count. The total sits at the right.
  - Edit and Void are compact icon buttons beside the total (dimmed until you hover the row on a mouse, always shown on touch). Unvoid stays a labelled button on voided sales.
  - The running row number was dropped; it changed with every filter and page and didn't identify a sale.
- **Filters sit in one toolbar box.** On a phone the Method choices scroll sideways inside it instead of running off screen.
- **Count and pager:** "150 transactions" above the list and "Showing 1 to 10 of 150" with page numbers below (always visible). `PageInfo` now carries `total` (the filtered row count it already queried).

## 2026-10-13 — New/Edit event as a slide-over; persistent pager; colored statuses
- **Creating or editing an event opens a right-side panel** instead of an inline card that stretched across the full-width page. The list (or the event page) stays visible behind it.
  - Fields are grouped: Event (name, organizer), Where (venue, city), When, Cash, and Close out when editing.
  - **One date-range picker** replaces the two native date inputs: pick the first and last day on a calendar (future days allowed), see "Sun, Oct 18 to Tue, Oct 20, 2026 · 3 days". One pick makes a single-day event. The "runs alongside" note is unchanged.
  - Opening float has a ₱ prefix and quick picks (₱1,000 / ₱2,000 / ₱3,000 / ₱5,000). Errors show under the field they belong to.
  - Close out: Active / Closed toggle; "Counted at close" appears once Closed is picked.
  - Esc or the backdrop closes it; Cmd/Ctrl+Enter saves.
  - `Calendar` gained an `allowFuture` prop (default off, so the sales date pickers still block future days).
- **The Events pager is always visible**: "Showing 1 to 8 of 8 events", page numbers, and Per page 12 / 24 / 48 (multiples of 12 so tiles fill whole rows). `Pagination` gained `alwaysShow` (default off; other tables unchanged).
- **Status pills are color-coded** everywhere they appear (tiles, table, event page): Happening now green with a pulsing dot, Upcoming blue with a clock, Done neutral with a check.

## 2026-10-13 — Events pages use the full width
- **`/offline-sales/events` and each event page now span the whole content area** beside the sidebar (was a centered 896px column that left wide empty margins on desktop).
  - Tiles go up to 4 across on wide screens (`xl`), so a 12-event page always fills whole rows.
  - On wide screens the search box sits on the same row as the When/Sort filters instead of stretching across the page.

## 2026-10-13 — Events: Tiles / Table toggle
- **A Tiles / Table switch sits beside the event count on `/offline-sales/events`.** Table shows Event (name + place), Status, Dates, Orders and Revenue per row. Live events keep a green left edge. Clicking a row opens the event page, and the name is also a real link.
  - Search, When, Sort and pagination apply to both views, so switching keeps your place.
  - *Decision:* the chosen view is remembered per browser (`localStorage`, guarded) and defaults to Tiles. It's a viewing preference, not shared state, so it doesn't belong in the URL or the database.

## 2026-10-13 — Events page is a tile grid; each event has its own page
- **`/offline-sales/events` now lists events as a grid of tiles** (3 across on desktop, 2 on tablet, 1 on phone, 12 per page). Each tile shows the status pill, name, dates, place, revenue and order count, and the whole tile links to the event.
  - *Why:* every event was a full card with its cash box and analytics stacked inline (the live one expanded), so reaching older events meant scrolling past several screens of charts. Tiles keep the whole list scannable in one view.
  - Search, When/Sort filters, pagination, "New event", and pinning live events to the top (with the green ring) are unchanged.
- **New per-event page `/offline-sales/events/[eventId]`** holds what the card used to: header (status, dates, venue, organizer, revenue), Edit (inline form), cash reconciliation, and the full analytics panel, always expanded.
  - Orders use the same read-time event attribution as the list (`resolveOrderEvents`), so tile and page totals agree. Unknown ids 404.
  - The event-scoped "View all products" rankings page now goes back to that event instead of the list.
- Shared bits moved to `components/analyst/event-parts.tsx` (status pill, date range, cash reconciliation). Date ranges now read "Oct 10, 2026 to Oct 17, 2026" (no en dash, per the UI copy rule) and format in UTC so a date never shifts by a day.

## 2026-10-10 — One review view for a batch; unsaved edits are kept
- **A page in an open batch always opens in the batch review, on that page's tab.**
  - *Why:* clicking a file in a bulk upload opened the single-scan review, while "Review & commit N pages" opened the batch review: two different screens for the same pages, each with its own store and period fields, and edits made in one were not in the other.
  - The file rows in the uploader now link to `/uploads/batch/<batch>?page=<upload>`. `/uploads/<upload>` redirects there too when the scan is waiting for review inside an open batch, so the Files list and old links land in the same place. Committed, failed and single-file uploads keep the single-scan page.
  - The open tab is kept in the address (`?page=`), so Back, refresh and shared links return to the same page.
- **Edits made while reviewing are kept if you leave and come back.** Changed counts and flags marked as checked are saved in the browser per batch (`src/review-draft.ts`) and restored when the review opens again; they are cleared on commit.
  - *Decision:* drafts live in the browser, not in `gl_extractions`. That table must keep the reader's original values, because the writer profile learns from the difference between them and what the reviewer confirmed. Trade-off: a draft does not follow you to another device or browser. A draft is tied to the exact reading it was made on, so a page that is read again starts fresh.
- **Removed the "Scan reader" accuracy line from the Uploads page** (not wanted there). Each reading still records whether the writer profile was used, so accuracy can still be measured.

## 2026-10-09 — Scan reader learns the writer's handwriting from reviewed pages
- **Each scan is now read alongside an earlier copy of the same page that a person already reviewed, plus notes on the digits misread before.**
  - *Why:* in Phase 1 one person fills in the forms for both pilot stores. Claude can't be fine-tuned on one person's handwriting, but it learns a style well from examples sent with each request. In the Oct 9 test batch the reader got 1 of 210 handwritten numbers wrong: this writer's 8 was read as 5 (MPMLSCB03 drawer 82, read as 52).
  - **Reference page:** the newest committed copy of the same form page with at least 8 handwritten numbers. It prefers the batch's store when known, else any store (one writer). It is sent with its confirmed values and an instruction never to copy them. Near-blank pages (page 4) get no reference.
  - **Writer notes:** built from every cell a reviewer changed in the last 40 committed scans (the reader's value in `gl_extractions.rows` compared with the confirmed value in `gl_inventory` by `source_upload_id`). They name digit confusions ("this writer's 8 was misread as 5"), missed values and stray marks, with recent examples.
  - **Row totals settle doubtful digits:** the system prompt now says ending on hand is stockroom + drawer + selling + delivery (true for 13 of 14 Staging rows that have an ending). When a row doesn't add up, the reader re-reads the doubtful digit and records the other reading in the hint, or flags the row.
  - **Learned from the connected database, nothing hard-coded:** Staging learns from Staging reviews, prod from prod reviews. Prod starts with no profile and reads exactly as before until its first pages are reviewed. Any error building the profile falls back to the old read. `GL_WRITER_PROFILE=off` turns it off.
  - **Cost and speed:** a read with a reference sends one more page image (about 440 KB PDF for page 2). The system prompt is prompt-cached; the reference is not, because each form page gets a different reference so a cache write would never be reused. Building the profile gives up after 8 s (the upload then reads the old way), and the reviewed-scan reads are kept in memory for 60 s so a 5-page batch doesn't repeat them.
  - **Store scope:** a store-scoped user's reads only use references and corrections from their own stores, and their accuracy line counts only those stores.
  - Accuracy counts every value that was written or that the reader saw, so a stray mark read as a number counts against it. Digit notes only use single-digit misreads; swaps like 15 vs 51 count as other misreads instead of becoming noisy digit notes.
  - **Measured:** each staged extraction records whether a profile was used (`rows.reader`). The Uploads page shows "Scan reader · X of Y handwritten numbers read right in the last N reviewed pages", and once there are pages from both groups, the rate with and without the reference.
  - The review gate is unchanged: nothing is saved to inventory until a person confirms it. No schema change.

## 2026-10-08 — Ask Coop reads the whole database except secrets (Train 3)
- **Access.** `run_query` reads every `public` table and view by its own name. The view-per-table model hid every new table and column until someone re-ran SQL, and it narrowed the owner's "everything except passwords and credentials" without saying so.
- **The lock stays in the database.** The read-only login gets `SELECT` plus `BYPASSRLS`. One whole-word secret-name rule (password, token, secret, key, pin, hash, credential, with a reviewed `pos_settings.key` exception) and the Zoomy-only tenant fence (`gl_*`, `company_*`, `companies`) close tables and columns. The allowlist is 29 views.
- **Future objects.** An event trigger re-applies the rule on every DDL, and a 5-minute pg_cron job backs it, because Supabase skips user event triggers for superusers and reserved roles. A daily drift job shows up in `/api/chat/health`.
- **App layers.** A value scanner hides secret-shaped values that sit under innocent names, and fails closed past every bound. `list_tables` and `describe_table` read the live schema. A 66-case attack suite covers the parser and scanner. Two limits are accepted: string-function splitting of a secret, and X58 text in Postgres logs.
- **Owner decision.** `digest_archive.bundle` stays queryable (the UI still never selects it).
- **Catalog.** A runtime catalog generated from `knowledge/data-catalog/` drives the prompt, the page map and the go-links. The `tables.md` edits live outside git. `crm-tools.md` is deferred to Train 4.
- **Answers.** A new default view, `pos_orders_completed`, sits next to `pos_orders`; the status lint now fires only on raw `pos_orders` with no status filter. Event stock keeps its Train 1 view (`coop_explore_stock_event`). "Completed" means what the dashboard counts: every order that is not voided (`status is distinct from 'voided'`, a null status included), the same in `query_metric`, the view, the coverage line and the Offline Sales page; in practice status is only `completed` or `voided`. The `stock_on_hand` and `stock_cover` registry metrics arrived, and a code-written basis note is added.
- **Cost cap.** Each question has a cost cap in input-token equivalents: `CHAT_TURN_BUDGET` (default 300000); past it the turn stops with a "try a narrower question" line.
- **Go-links.** The chat can open 18 dashboard destinations (was 8), from the catalog's page map (`components/analyst/coop-chat.tsx` `APP_PATHS`).
- **Health.** `/api/chat/health` adds `drift` (the daily drift job's newest time and count) and `uncatalogued` (open tables missing from the catalog).
- **Website.** When the CRM is configured, the prompt says Website totals come from live orders through `get_channel_report`, and the gap line names what is still not readable (customers, carts, order lists).
- **Aliases.** The `coop_explore_*` views stay as aliases until a later PR.
- **Train 2 merged in.** Its final fix wave (one event-label rule, `min(min(btrim(e.name) collate "C")) over (partition by lower(btrim(e.name)))`, and a parser that accepts only `collate "C"`) now governs the base-table examples too: one label rule across the skill, E01-E18 and the tool descriptions.
- **Apply order.** By hand on staging: `coop_chat_explore_direct.sql`, then `coop_chat_default_views.sql`, then `coop_chat_stock.sql` (it needs the `coop_chat_ro` role from `coop_chat_readonly.sql`; the readonly checks (b) now expect ten grants). Check with `coop_chat_explore_direct_checks.sql`; `coop_chat_explore_checks.sql` is for the Train 1 state only. PROD waits for zoomy-pos to revoke public execute on its write RPCs.
- **Rollback.** Unset `EXPLORE_MODE` first (or deploy a pre-Train 3 app): the prompt names base tables the rolled-back login cannot read. Then `coop_chat_explore_direct_rollback.sql`, `coop_chat_explore.sql` and the Train 1 checks.

## 2026-10-07 — Ask Coop reads the website CRM (Train 4)
- **Four GET-only tools.** Website customers, orders and abandoned checkouts live only in the CRM Worker, so Ask Coop gets `get_crm_metrics`, `list_crm_orders`, `list_crm_customers` and `list_crm_checkouts`. Totals, groups and paging are computed in code; results chart and pass the number check.
- **Decision: the model never sees a URL, the token, a checkout link, a voucher code, the raw Shopify blob or free-text line-item properties.** The chat has its own guarded client (GET only, one base URL, endpoint and parameter allowlists, read-scoped token, 5 s / 4 MB / 8 GETs / 6 calls per turn). Both it and the pages share one field allowlist (`src/crm-project.ts`). This replaces the spec's "value scanner reused" for CRM data (owner sign-off in the PR).
- **`get_channel_report` (any period) reads through the same client.** Its Website row uses the new client; the temporary Train 2 exception for the old reader (`src/crm-data.ts`) is gone.
- **Decision (owner): customer contacts reach the model unmasked.** Email, phone and names from the CRM tools go to the model, the Anthropic API and the browser's localStorage chat history without masking. This departs from `knowledge/best-practices/pii-and-secrets.md` ("mask at the read seam"), by owner decision and on the same precedent as Explore. Still never returned: checkout links, voucher codes, the raw blob.
- **Decision: a field allowlist replaces the spec's "value scanner reused".** `src/crm-project.ts` copies only listed fields, so a field the Worker adds later is dropped until added on purpose; no scan of values is run.
- **Decision: customer text is untrusted.** It is cleaned, capped and marked in every result. An answer that used CRM or Explore text shows links as plain text. There is no send or write tool, so injected text has nowhere to go.
- **Three prompt states.** The prompt text depends on: no CRM env; CRM env set with `CHAT_CRM_TOOLS=off`; tools on. `get_digest` and `NOT_STORED` are true in all three, so the model never claims tools it does not have.
- **Env.** `CRM_API_URL`, `CRM_API_READ_TOKEN`; optional kill switch `CHAT_CRM_TOOLS=off` hides the tools without touching the Website CRM page.
- **Known limits.** Only the Worker enforces that the read token cannot open `/admin` (the dashboard never calls it, and a test pins that). Customer text can only be labelled untrusted, not stopped.
- Best practice: `knowledge/best-practices/chat-readonly-api-tools.md`.
- **Merged onto Train 3.** The CRM tools sit after `get_channel_report` next to Explore's `list_tables` / `describe_table` (15 tools with the CRM, 18 with Explore too; the strict limit is 20). The per-turn "Not available" line keeps the three CRM states and appends the catalog-built "Not in the database" line from the same flags (`DataFlags {website, crm}`).

## 2026-10-07 — Ask Coop digest periods and charts (Train 2)
- **Digests by date.** Ask Coop reads digests by date in Philippine days. `window_from` is a PH-midnight `timestamptz` and was read with `slice(0,10)`, which showed 27 Sep for a window starting 28 Sep. PROD holds mixed windows (weekly, about a month, rolling 30 days, re-runs), so every stored window is listed per turn (newest re-run only), and `get_digest` can pick the one covering a date.
- **Any period per channel.** New `get_channel_report`: Shopee and Lazada from the digests' per-day `daily` data (merged per channel and day, newest digest wins), Website from live CRM orders, Offline from POS. AOV is recomputed, never averaged. Old windows without `daily` are summed only when they tile exactly, and overlapping ones are refused as "not combinable". Website units are "unknown" when the CRM has no line items. The chat route now passes `getCrmOrders` to this one tool: a deliberate, temporary architecture exception (aggregates only, fence test updated) that Train 4's GET-only CRM tools replace.
- **`recent_weeks` removed.** It matched weeks by Monday and showed a month as a "week"; `get_channel_report` replaces it.
- **Two-dimension charts.** Event-by-pet results draw as grouped bars, 100% stacked or small multiples (one colour per series), with a code-written note for every group over 10% untagged and display spelling merged to the most frequent variant. No SQL to apply.
- **Framing rule (EXP-08).** Explore skill rule that a claim about a group must hold for every row (no "both venues" overclaims); golden A07 and a fixture trap pin it. Explore skill budget raised to 6,600 tokens (final measure about 6,494 after the fix wave below).
- **Not saved into reports.** `get_channel_report` charts, like `get_digest` charts, are not saved into reports.
- **Final review fixes.**
  - **One event-label rule.** EXP-04 and EXP-06 contradicted each other (and the few-shot taught `lower()`), so live A7 showed lower-case event names. Now one rule: group by `lower(btrim(e.name))`, label with `min(min(btrim(e.name) collate "C")) over (partition by lower(btrim(e.name))) as event` (one capitalised spelling per event, never split across pets). EXP-04 points to EXP-06. The Explore validator now allows `CollateClause` for collation `"C"` only (negative corpus row X17 uses `en_US`).
  - **Venue rule.** When the question names venues or malls the SQL selects the venue column too (venue, event, pet, measure), which feeds the venue-level untagged note.
  - **Channel reports draw themselves.** In live A8 the model typed a table and no chart appeared; the loop's backstop now auto-draws a `get_channel_report` result (chart first, table twin) when no render tool ran.
  - **Coverage notes name their sources.** Every Shopee or Lazada row now says which digests supplied the days ("per-day sales from digests Sep 1 to Sep 27, 2026; ... (every day covered)") so the model no longer says it did not check.
  - **CRM exception narrowed.** The architecture test pins the chat's `@/src/crm-data` imports to exactly `crmConfigured` and `getCrmOrders` (Train 4 replaces them with GET-only tools).
  - **Explicit x still pivots.** Live A7: the model called `render_chart` with kind `grouped_bar`, x `event`, y `revenue_php`; an explicit x skipped the two-dimension pivot and drew one plain bar chart. With a non-auto kind, an x naming a category column now picks the groups.
  - **`get_digest` covering** rejects impossible dates (2026-02-30), sharing `isRealDay` with `get_channel_report`.

## 2026-10-07 — Ask Coop fast path (Train 1)
- **Ask Coop fast path (Train 1).** The per-turn context no longer calls contacts, free-form questions or stock unavailable when Explore is on (it did on every turn in PROD). The chat now sends the open page, and dashboard links pasted in a question are described from a page map, so "this" means the page's data. Explore can read stock (5 views over 4 zoomy-pos sources; `coop_explore_stock_event` is the default) with sellable Event stock as the default basis, because two kinds of "stock" exist and the dashboard forecast uses Event. `pos_locations` was left out (it may not exist on staging or PROD), and `coop_chat_explore.sql` now stops in step 0 with a clear message if a stock source or `pos_inventory_by_location.location` is missing. Needs `supabase/coop_chat_explore.sql` re-applied on staging and PROD.

## 2026-10-08 — BoxMe (Online) inventory is live data, not a stub
- **What:** the BoxMe channel of `/inventory?channel=online` now shows real BoxMe warehouse stock and replaces the D13 stub. Per SKU it shows Available, Awaiting pick, Reserved, Incoming, Damaged, next expiry, the Stratpoint Offline count (Office + Event) and a "Lasts" estimate. Above the table:
  - a freshness pill
  - a four-total strip
  - status chips that also filter the table
  - Line pills and search
- **Below the table:**
  - an Expiring soon list
  - a Catalog match card listing POS products not at BoxMe and BoxMe SKUs unknown to POS
  - the existing marketplace analytics, under their own heading (D13 kept)
- **Product page:** `/inventory/[sku]` gets a BoxMe card with the per-warehouse split and a daily available-units trend. The KPI block is now labelled "Stratpoint (Offline)" instead of a hard-coded subtitle. Arriving from the BoxMe table shows the BoxMe card first, and Back returns to the BoxMe tab.
- **Decisions:**
  - **Separate `boxme_*` tables, not a `'boxme'` row in `pos_locations`.** BoxMe owns its numbers, so mirroring them into POS lots would collide with POS sales, FEFO and the stock RPCs.
  - **Writer is zoomy-observability.** Its `boxme-sync` job (GitHub Actions, daily 07:30 Manila, ahead of the 08:00 stock digest) owns `supabase/boxme_inventory.sql`. This app only reads.
  - **No fixed IP.** BoxMe's docs say an IP whitelist is mandatory, but our key works from unregistered IPs (VPN and local tests). A static-IP proxy (`BOXME_PROXY_URL`) is the fallback if BoxMe starts enforcing it.
  - **Join on `seller_sku = product_id`.** All 20 BoxMe SKUs match `pos_products` on Staging.
  - **Status:** Out at 0 available. Low at or under BoxMe `min_quantity` (or the POS threshold when that is unset), or under 14 days of cover.
  - **"Lasts":** uses day-over-day drops in stock (restocks ignored) once 7 days of daily snapshots exist. Until then it reads "Building history".
  - **Freshness:** stale after 26h, a banner on a failed or partial run, and a key-expiry warning inside 14 days.
- **Files:**
  - `src/boxme-inventory-{data,compute}.ts`, `src/boxme-format.ts`, `src/boxme-mock.ts` (demo data from a real BoxMe dry run)
  - `components/analyst/boxme-{inventory-view,inventory-table,sku-card}.tsx`
  - `src/inventory-status.ts`: the shared status pill styles, now importable by server components
  - new `POS_TAGS.boxme` tag
- **Database:** `boxme_*` applied to **Staging only**. Prod waits for sign-off.
- **Tests:** `test/boxme-inventory-compute.test.ts` (15).

## 2026-10-07 — Event tiles get "View all products" (event-scoped rankings)
- **Each event tile's Top sellers block now ends with "View all products →".** It opens Product rankings scoped to that event (`/offline-sales/rankings?event=<id>`), with the Products and Bundles tabs, sort, search and paging the overview's View all already has.
  - *Why:* the existing View all ranks every offline sale together; the team wanted the full list (including the "kulelat" bottom sellers) for one event.
  - **Carries the tile's state:** the active Day pill (`&day=`) and the Revenue/Units + Top/Bottom toggles (`&sort=`, `&dir=`), so the full list's first rows match the tile's top 5. Multi-day events show the same Day pills on the rankings page.
  - Same order set as the tile: read-time resolved event attribution (`resolveOrderEvents`), then the optional day filter. An unknown event id is a 404; a `day` outside the event's dates falls back to all days.
  - Header names the event and the back link returns to Events. No schema change.
- Rankings range label reads "1 to 10 of 42" instead of using an en dash (UI copy rule).

## 2026-10-07 — Upload review shows only this batch's pages; dark-mode date icons
- **"Pages uploaded with this one" no longer pulls in other uploads.**
  - *Why:* the strip predates batch uploads. For a scan not yet committed, it guessed the form's pages as "anything the same person uploaded within 12 hours". A batch of pages 2 and 3 therefore showed pages 1, 4 and 5 from earlier test uploads, which was confusing.
  - **Now a scan in an upload batch shows exactly that batch's pages,** labelled "Pages in this batch". Pages with no readable scan in the batch show as empty ("No readable scan of this page in this batch"), and a **Review the batch** link opens the batch review.
  - Committed scans still show the pages committed into the same store and period. The 12-hour guess remains only for older uploads that have no batch.
- **Calendar icons in dark mode:** native controls now follow the app theme (`color-scheme` on `:root` / `.dark`). The date pickers' calendar icon is visible on dark fields, and scrollbars and native select popups match too.

## 2026-10-07 — Goldline works on phones (desktop unchanged)
- **Checked every Goldline page at phone width (390 px) against Staging data.** Nothing scrolled sideways, but several screens were hard to use. Every fix applies **below the tablet breakpoint only**; desktop renders exactly as before (checked).
  - **Row editor (scan review and batch review):** each row is now a card with all five counts as labelled, larger fields (Stockroom · Drawer · Selling · Delivery · Ending), the reader's hint and **Looks right**. Before, only two columns fit and the rest needed side-scrolling. "Go to next flag" finds whichever layout is showing.
  - **Scan preview:** phones can't show a PDF inside a page (it rendered as a blank box), so it becomes a **View the scan** button that opens the phone's PDF viewer.
  - **Store health:** a card per store (score, form status, in stock, cover, dead stock, low · out) instead of a squeezed table.
  - **Uploads:** a card per file (name, type · time, status, delete).
  - **Inventory:** the status filter is one swipeable row instead of two-line labels.
  - **Summary tiles** are tighter across Overview, Stores, Inventory, product page and Store health. The Overview's three tiles sit two per row.
- **Review fixes:** the Inventory filter wrapper disappears from layout on desktop (`md:contents`), so the desktop filter row is pixel-identical. The phone lists carry `role="list"` for screen readers. Upload cards show a rejected file's reason as text, since touch screens never show tooltips.
- **No em/en dashes in UI copy.** About 60 user-facing strings were rewritten: error messages, page copy, date ranges ("Oct 6 to Oct 7"), "Showing 1 to 25 of 263", and split-file names ("cubao (page 2 of 5).pdf"). The rule is now in the workspace `CLAUDE.md` ("UI Copy"). The scan reader's own instructions are unchanged, since they aren't user-facing.
- **Local dev:** `DEV_AUTH_AS="goldline:company_admin,coop_admin"` gives the dev-bypass session memberships so tenant pages render locally. It has the same double gate as `DEV_AUTH_BYPASS`, so it's inert on any deployment. The layout's "Zoomy viewer" check now follows the session's view like a real one (unchanged without `DEV_AUTH_AS`).

## 2026-10-07 — Environment switcher (Staging ↔ Production) for Coop Admins
- **Who sees it:** anyone who **holds a Coop Admin role**, in whatever view they're using. A Coop Admin who's in the Goldline or Zoomy view still sees it. It's checked on the server from the person's memberships; people without that role never get it.
- **Header pill** ("Staging" / "Production", colour-coded blue / purple), styled after the reference console:
  - Its menu lists the two environments with a colour rail, marks the current one **Active**, and links the other to **the same page** on that site, keeping filters and anchor.
  - A **Manage environments** link sits at the bottom.
  - A thin colour strip along the top of the header (thicker in Production) shows Coop Admins where they are.
- **Only two environments:** the develop branch also deploys to Staging.
- **Decided: link between deployments, not switch the data source.** Each environment keeps its own database keys and sign-in, so the Staging site never holds a production key and Staging stays prod-free. That also works with prod and Staging being on different Supabase accounts.
- **No settings needed on either Vercel project.** The environment list lives in code (`src/coop-env.ts`).
- **Each site knows which environment it is from the database it's connected to,** not from the address it was reached on (a site can be served from deployment URLs, branch aliases or custom domains).
  - The **Production confirm fails closed:** only the Staging database counts as Staging, so anything else, including an unrecognised database, still asks for PRODUCTION.
  - *Why:* the regression review caught that an address-based check would treat the prod deployment as Staging when opened through a non-canonical URL, which would skip the confirm and mislabel the audit entry.
- **Manage environments (`/admin/environments`),** read-only, for Coop Admin role holders in any view. For each site it shows the address, whether it's up and connected to its database, the deployed branch and commit, and the database (ID partly hidden). It reads each site's new public **`/api/health`**, which returns only those facts; no data, no secrets.
- **Production safeguards:**
  - In Users & Roles on Production, **Suspend** and **Remove access** require typing **PRODUCTION**. This is checked in the server actions too, not only in the UI. Reactivating is unaffected.
  - Each access change records its **environment** in `company_user_audit.env`, via the additive `supabase/company_user_audit_env.sql`, applied to Staging. Until that's applied to prod, the audit write falls back to the old row, so no entry is ever lost.
- **To use it on Production:**
  - The prod site needs this code deployed; until then Manage environments shows prod as "running an older version".
  - You need a Coop Admin role in prod's own `company_users` (reviewed SQL), because each site checks its own database.
- **Other review fixes:**
  - `/api/health` reuses its database check for 20 s, so repeated hits can't load the database.
  - Manage environments distinguishes "behind Vercel protection" and "unexpected response" from "not reachable".
  - The switcher keeps the current #anchor (read at click time), and the Active row is readable by screen readers.
- **Tests:** database-based environment detection, the fail-closed guard, links and the confirm rule (`src/coop-env.test.ts`), plus the server-side Production guard (`test/admin-actions.test.ts`). Dev-only preview at `/dev/env-switcher`.

## 2026-10-07 — Goldline pages load faster (and stay fast at 300 stores)
- **Measured first** on Staging, from Manila, one run per request:

  | Page | Before | After |
  |---|---|---|
  | Inventory board | ~800–900 ms | ~170–310 ms |
  | Action Feed / Store health | ~240–290 ms | ~100–145 ms |
  | Overview | ~400–450 ms | ~125–200 ms |
  | Product page | ~140–200 ms | ~115–190 ms |
  | Stores | ~110 ms | ~90–150 ms, now bounded at scale |

  Every page also shows an **instant loading screen** on navigation.
- **Why it was slow:**
  - **Chains of sequential round trips.** The Overview made ~7 database reads one after another, and the Inventory board ran two loaders back to back.
  - **The session and company list were re-read several times per request.**
  - **Reads that grow with history:** the Stores page shipped every sales row ever uploaded to the app, and the old Counts loader read every count period.
  - **Missing indexes:** every read filters counts by period *end*, but the indexes led with period start, so those reads scanned the company's full history.
- **Database (additive; applied to Staging):** `supabase/goldline_perf_indexes.sql` adds:
  - period-end indexes on `gl_inventory` (company, company+store, company+item), `gl_sales`, open `gl_shipments` and `gl_uploads(status)`
  - **`gl_sales_rollup`**: the Stores page's per-store and per-SKU sums, computed in Postgres and verified against sample rows
  - **`gl_count_sources`**: the board's latest-count header (scans, pages, review count) in one call instead of three
- **App:**
  - **Reads that don't depend on each other run in parallel** (Overview, Inventory board + count header, Action Feed counts alongside the period lookup).
  - **Big reads (counts, sales) fetch pages in parallel.** `fetchAllRows` now takes `{concurrency}`, which requests several 1000-row pages at once and stops at the first short page. It returns the same rows in the same order (tested). At the 300-store ramp this turns hundreds of sequential page waits into a quarter as many.
  - **Cached reference data:** the catalog, store list and supply side (settings, lead times, warehouse) are cached per company for up to 10 minutes (`src/goldline-ref-data.ts`). Every save that changes them (price, hide, warehouse, shipments, supply settings) expires the cache immediately, so edits show on the next load.
  - **Per request:** the session and nav context are read once (React `cache`), and company names are cached for 5 minutes.
  - **Loading screens** (`loading.tsx`) for Overview, Stores, Inventory, the product page, Action Feed, Store health and Uploads.
  - Dev-only `/dev/perf` page that times each loader (timings only; 404 in production).
- **Review fixes:**
  - The Action Feed's early counts window is now ~25 days of lag (twice-monthly counts) instead of 60, so it doesn't over-read at scale.
  - Supply settings clears the cache even if the save fails partway.
  - Linked-sales lookups fetch 2 pages at a time.
  - Upload review screens get their own loading screen.
  - `/dev/perf` runs only in development.
- **Note:** catalog or store changes made directly in SQL (seeds, onboarding new stores or products) take up to 10 minutes to show, because they bypass the app's cache expiry.

## 2026-10-07 — Goldline Inventory board: counts + forecast in one view, plus the warehouse
- **Counts and Forecast are merged into one Inventory board** (`/stock`), built like Zoomy's Inventory page. The store picker includes **All stores (N)**. The old `/stock/forecast` redirects here and keeps its `?store=`.
- **Columns:** Product · Status · Price · On hand (back room = stockroom + drawer · on display) · Trend · this month · last month · 3 months · **Lasts** (days, or months for slow movers) · **Need** · **Warehouse** · **Ship by** · ⋯.
- **Controls:**
  - Sort any column; the default is most urgent first.
  - Filter by status (Needs action / Out / Healthy / Not enough data) and by product line, and search.
  - Show hidden products, paging, and cards on mobile.
  - Clicking a row opens the product page.
- **The supply side,** from the business's own sheet columns:
  - **Benta per month** is the pace.
  - **How many months will it last** is Lasts.
  - **Ilan ung need ng <store>** is Need: a top-up to two cycles of cover, less anything already on the way.
  - **Ilan pa ung nasa warehouse** is Warehouse.
  - **Gano katagal umabot sa store** is the per-store delivery time, which gives **Ship by** (run-out date − delivery time; "Now" once that's past). The header says when a send today would arrive.
  - **Gano katagal gumawa** is the per-product-line production time, which gives **Produce by**: when the warehouse, after covering every store's need, runs dry, minus production time. It shows "produce now" if needs already exceed stock.
- **Tiles:** Reorder now · Ship now · Warehouse short · Produce soon (within 2 weeks).
- **Actions (⋯ menu and header):**
  - View product page.
  - **Record shipment** (warehouse → store). It is atomic: it refuses more than the warehouse holds and shows "on the way" until the store's next count records the delivery. **On the way** lists shipments, each with Cancel, which returns the units.
  - **Edit warehouse stock**, **Change price** (logged to `gl_price_changes`), and **Hide product**.
  - **Supply settings:** company defaults, per-store delivery days and per-line production days.
  - Store-scoped roles can ship and set their own stores' delivery times, but not company-wide values.
- **Sample data:** the warehouse stock and lead times aren't gathered yet, so `supabase/goldline_supply.sql` seeds **sample values** (`is_sample`). A banner says so, and anything edited in Coop is saved as real. The seed:
  - production: lip ~30 days, lashes/accessories ~45, the rest ~21
  - delivery: Metro Manila 2 days, Visayas 6, Mindanao 8
  - warehouse: a deterministic 0–399 per item, a few at 0
- **Data (additive, applied to Staging):**
  - New tables `gl_supply_settings`, `gl_line_lead_times`, `gl_store_transit`, `gl_warehouse_stock`, `gl_shipments` and `gl_price_changes`; plus `gl_products.hidden`.
  - New RPCs `gl_record_shipment`, `gl_cancel_shipment` and `gl_set_price`, which are service-role only.
- **Regression-review fixes:**
  - **Dates:** they use Philippine time (the server's UTC date was a day behind before 8am Manila).
  - **Cancelling a shipment:** a shipment due to have arrived can't be cancelled, which would put stock back that's at the store; it shows "due · awaiting count".
  - **Writes check their targets:** they verify the product, store and product line exist in the company, and a store-scoped role with no stores is denied rather than treated as unrestricted.
  - **"Ship by":** it clears once what's on the way covers the need, so the "Needs action" filter matches the Ship now tile.
  - **Store-scoped roles:** they don't see warehouse-wide flags, which would be computed from their stores only.
  - **Shipping from "All stores":** it requires picking a store.
  - **Price changes:** an unchanged price isn't logged.
  - **Loader:** it appends instead of copying arrays, and linked-sales lookups are chunked.
  - **Verified in a browser:** the store and product pickers work inside the dialogs.
- **Shared logic and tests:**
  - Pure, tested `src/goldline-supply.ts` (13 tests). It builds on `storeMovement`, so statuses match the Action Feed and the product page.
  - The "sold per month from counts" logic is now `countedSoldByMonth`, shared with the product page.
  - Dev-only preview at `/dev/goldline-inventory` (404 in production).

## 2026-10-07 — Goldline product page: sales and stock, month by month
- **New page `/stock/[...item]`** for Goldline. It is the per-product view Zoomy already has, and that Nichido's POC sketched.
  - Header: the product name, item code, price and bestseller ★.
  - **Four headline numbers:** on the shelf now · status · sold last month · suggested order.
  - **The sales-and-stock chart:** 3 real and 3 forecast months, an optional vs-last-year comparison, the stock line with delivery ▲ markers, and "runs out".
  - **What the store counted:** every count with its A/B half, the latest 6 shown, with "Show all".
  - **How many sold:** a month-by-month table.
  - Reached by clicking a product on **Inventory** or **Stock forecast**, or an item card on the **Action Feed**. These are now full-row links to that store's view; the Action Feed button keeps its own action.
- **Decisions (plan §11):**
  - **Where "sold" comes from.** It's estimated from consecutive counts today (last on hand + delivered − this on hand, by the month each count ends in; a count that rose with no delivery is skipped, not read as zero). A product switches to the **sales report** automatically once its POS SKU is linked and that store has sales rows. The page always names its source, and a **register check** (counts vs register, within ±2 units or 10%) appears for linked products.
  - **Per store, plus "All stores".** The store picker includes "All stores (N)". The totals add up each store, carrying a store's last count forward through a month it missed. The suggested order is each store's own order added up, so an overstocked store can't hide one that's out. Store managers only see and total their own stores.
  - **Monthly bars.** The A/B half-month detail lives in the counts table.
- **The page agrees with the other stock pages.** Status, cover, stock-out date and suggested order come from the existing movement engine (`storeMovement`), so it matches Stock forecast and Action Feed. A store with nothing sold in 2 cycles reads "Not moving".
- **Empty and early states:** "Not counted yet" when no visible store has counted the product. "Not enough history yet" (the chart starts after a product's second count) while still showing on hand and the counts.
- **Shared chart:** `StockSalesChart` now treats a missing value as "no data" (no bar, no point) instead of 0, and says "last counted this week". Zoomy always passes numbers, so its page is unchanged.
- **Regression-review fixes:**
  - **Current month in the projection:** the projection now includes the rest of the current month. A store counted on the 15th still has half a month of selling ahead, so "runs out" was about half a month late and can now land on the current month.
  - **Missing from the latest count:** a product the store's latest count left out reads "not on the store's latest count" instead of showing stale figures.
  - **Deliveries:** a delivery on a count with no on-hand figure carries to the next count.
  - **Missed counts:** sold is spread over the days between counts by month, so a missed count doesn't pile two cycles into one month.
  - **Partly linked sales:** linked sales fill their months and the counts fill the gaps.
  - **Route:** it is a catch-all (`/stock/[...item]`), because real item codes contain "/" (e.g. `24/7SEPMM`), and a malformed address now gives a 404.
- **Built as:**
  - Pure, tested `src/goldline-product.ts` (22 tests), with `productView` shared by the page and a dev-only preview at `/dev/goldline-product` (synthetic data; 404 in production).
  - A company- and store-scoped loader that reads one item's ~15 months of counts plus linked sales, paged.
  - No schema change.
  - Status labels are now shared between Stock forecast and this page.

## 2026-10-07 — Uploads: tap a finished file to open its review
- In the batch file list, a page that has been read is now a **fully clickable row** that opens that page's review (`/uploads/[id]`). Previously you had to aim for a small "Open" text button.
  - The row highlights on hover and shows a chevron, and it is a single keyboard stop with an inset focus ring and a label such as "Review 2.pdf (page 2)".
  - Rows still uploading or failed keep their Retry, Cancel and Remove buttons, which sit above the row link.

## 2026-10-07 — Multi-file uploads: a store's whole form in one go, with progress that follows you
- **Batch uploads (one store's inventory form for one period).**
  - Drop or browse several files at once: a PDF per page, one PDF with every page, or both, plus a sales CSV if needed.
  - Multi-page PDFs are **split into pages in the browser** (pdf-lib, loaded on demand), so every page goes through the existing read → review pipeline with its own progress. This also fixes a gap: a 5-page PDF used to have only one page read. The upload route now refuses multi-page PDFs from any other caller with a clear message.
  - Up to 20 files, 25 MB each.
- **Store and period are entered once per batch.** They're prefilled from page 1's printed header (tagged "Read from page 1 — check it") and apply to every page, so pages 2–5 no longer need them re-typed and all pages land in one Inventory count.
  - **Store is now a searchable dropdown** of the company's stores ("1 · CUBAO"), with "Other store code…" for stores not listed yet. This applies on the batch uploader, the batch review and the single-scan review. `gl_stores` currently holds the 5 stores from the Nichido POS sample.
- **Reading queue.** Files are read 2 at a time.
  - Each row shows the file type, name, size, a live status ("Uploading 40%", "Finding the page…", "Reading page 3 · 60 items", "Page 3 · 2 to check") and its own bar.
  - Each row has Retry, Cancel and Remove.
  - The batch shows an overall bar with a time estimate, and a pages 1–5 strip marking pages that are in, missing or duplicated.
  - A CSV waits for the period.
  - A reload or tab close while uploading asks for confirmation first.
- **Progress follows you.** The queue lives in the app shell, which stays mounted across in-app navigation, so uploads keep running on other pages.
  - A compact indicator shows bottom-right on desktop and as a slim bar under the header on mobile ("Reading 3 of 5", bar, current file, View).
  - When done it turns into "5 pages ready to review → Review" and can be dismissed.
  - It's hidden on the Uploads pages, where the full panel is.
- **Batch review** (`/uploads/batch/[id]`).
  - Store + period once at the top.
  - **Page tabs** with each page's open-flag count (✓ when clear), plus duplicate and missing-page markers.
  - Each tab has the scan (click to enlarge), the confidence card and the rows with the flag navigator, the same tools as single-scan review.
  - A sticky bar always says what's left ("Resolve 2 flagged rows first", "Page 3 was uploaded twice…") and offers "Go to next flag", then **Commit all N pages**.
- **Atomic commit — one Postgres transaction (`gl_commit_batch`).** It locks the batch row, so two simultaneous "Commit all" clicks serialize and the second is refused.
  - It requires **exactly** the batch's pages awaiting review: none may be left behind, and none may still be reading.
  - It refuses a repeated item code, whether across pages (a page scanned twice) or within one page. The error names the code.
  - It upserts every count and closes the pages and the batch together, so a failure leaves nothing half-applied.
  - Same authorization, store scope and validation as a single-page commit. Service-role only; applied to Staging.
  - *Why a DB function:* the regression review showed that sequential client-side writes could double-commit under a race, or strand pages after a mid-way failure.
  - A page that's still reading blocks the commit inside the transaction. A page whose upload lands after the commit is marked failed with "Start a new batch to add it", so a page is never stranded in a closed batch.
  - **Deploy order:** the app now calls `gl_commit_batch`, so apply `supabase/goldline_upload_batches.sql` to an environment **before** its code ships there (Staging is done; prod goes in the additive promotion pass).
- **Data:** new additive `gl_upload_batches` + nullable `gl_uploads.batch_id` (`supabase/goldline_upload_batches.sql`; RLS on, API roles revoked; applied to Staging). Background processing for bulk multi-store uploads stays a later phase.
- **Review hardening:**
  - The batch review merges pages that finish reading while it's open (it never commits a page that was still empty), keeps your edits across refreshes, and keys tabs by upload.
  - Password-protected PDFs are refused with a clear message, in the browser and in the route.
  - Store and period typed before the first upload are saved once the batch exists. Saves are debounced and no longer run inside state updaters.
  - Cancel works while the batch is being created. Retry only applies to failed or cancelled files.
  - A CSV never joins a batch, and a batch's store is checked against your store access.
  - The page refreshes once per burst of finished files, not after every file.
- **The scan preview now follows you as you scroll** (single-scan and batch review, desktop). It pins just under the header, sized to the viewport.
  - *Root cause:* the shell's `<main>` was `overflow-y-auto` while the window does the scrolling, which silently disabled every `position: sticky` inside pages.
  - `<main>` now uses `overflow-x-clip`. This also brings back Channel Compare's sticky panels (offset below the header) and Health's condensing header (now listens to the window).
  - The batch commit bar is sticky inside the content column instead of `fixed`, so it no longer spans under the sidebar, and it sits above the mobile tab bar.
- Pure rules tested (`src/upload-batch.ts`). typecheck + full suite (2522) + pagination guard pass; impeccable detector: no findings.

## 2026-10-07 — Users & Roles: role chips color-coded by company
- Access chips now carry their company's color, the same hue as its badge in the header view switcher (`companyHue`): Goldline gold, Zoomy green, any other company its own stable hue. A company reads the same everywhere. Coop Admin chips are a neutral tint with a shield icon.
- The same colors appear in the "+ Add access" menu (color dot per company, shield for Coop Admin) and on the Invite panel's role tiles.
- Status is shown only when it's the exception: an amber dot plus "(invited)" for invited, dashed and faded with "(suspended)" for suspended. "Active" is the unmarked default, so a green status dot no longer competes with Zoomy's green. The legend now reads: chip color = company · Coop Admin · Invited · Suspended.
- Review (code-reviewer): no critical, high or medium issues. Applied the lows: hover and open states step up the chip's own tint and border (a brightness filter was nearly invisible on light), `disabled:opacity-60` is restored, and suspended chips fade to 75% so their text stays readable.
- Chip text contrast is about 7–8:1 on light and about 6:1 on dark. typecheck + full suite (2518) pass; impeccable detector: no findings.

## 2026-10-07 — Switching views takes you to that view's home
- Bug: changing the view in the header switcher kept you on the current page. Switching from Goldline to Zoomy while on `/uploads` showed Zoomy's (empty) uploads inside the Zoomy nav. The switcher now navigates to the new view's home: Zoomy → `/`, Goldline (and other companies) → `/overview`, Coop Admin → `/admin/users`.
- Review (code-reviewer): no critical, high or medium issues, and no redirect loop (`/` only redirects non-Zoomy views). Applied the lows: dropped a redundant refresh that could flash the old page, ignore unknown view keys, and keep the switcher pending until the new page starts rendering.
- **View-switch animation** (multi-role users; only they have the switcher). Picking a view veils the page with a soft blur, and a card with the destination's wordmark or badge ("Switching to Goldline Cosmetics…") eases in: 200 ms, strong ease-out, scale 0.96 → 1. It fades out faster (150 ms) once the new view has rendered, which reads as a crossfade between tenants. Reduced motion keeps only a short fade. Announced via `role="status"`. The exit waits until the switch has actually been pending, and an 8 s safety net means the veil can never stick. Review fixes: if the switch never registers as loading it exits after 1.5 s (not 8 s); announced via a persistent live region (the overlay itself is aria-hidden); exit fade aligned to the removal timer. The shell stays mounted across navigation, so the overlay can't be cut short.
- `homeFor` now knows Zoomy's home too. Before, a Zoomy user bounced off a Coop-Admin-only page landed on the company `/overview`; it now goes to `/`. Tested.

## 2026-10-07 — One shell, two brands: company wordmarks in the switcher
- Plan §07i: the only per-company difference a user sees is the logo and the data behind it.
  - The header view switcher shows the active company's wordmark: Zoomy's red **Zoomy!** over "TREATS", Goldline's light, wide-tracked **NICHIDO**. The company name stays in the accessible label.
  - Menu rows show each wordmark in a fixed-width slot (so names align), then the company name and a line with the role and what the business is ("Company User · cosmetics · stores · CSV + handwritten forms").
  - A single-role user's header label shows the wordmark too.
  - Coop Admin keeps its shield; companies without a brand entry keep their color monogram.
- Brand definitions live in `src/brands.ts`; `components/analyst/brand-mark.tsx` renders them. These are typographic recreations, since no official logo files exist in the repo. Official artwork should be added as inline SVG (the security-headers test forbids remote `<img>`).
- **Regression review (code-reviewer) + fixes:** no critical or high issues. (MEDIUM) The single-view label fell back to the Zoomy wordmark whenever a view had no company id; it now assumes Zoomy only when there's no nav at all (local dev / legacy). (MEDIUM) The Zoomy red (#D9483B) was below AA contrast at 13–14px. It's now theme-aware: #B8382C on light (≈5.1–5.8:1) and #F0705F on dark (≈5.1–5.7:1), via CSS variables. (LOW) Hoisted the brand lookup and removed the non-null assertions.
- typecheck + full suite (2503) pass; impeccable detector: no findings.

## 2026-10-07 — Goldline stock forecast, Action Feed and Store health
- **Movement engine** (`src/goldline-movement.ts`, tested). Goldline's POS export isn't mapped to the form's item codes yet, so movement is **estimated from consecutive counts**: units sold in a cycle = last on hand + this cycle's delivery − this on hand. Velocity is the average over up to 3 cycles. From it come days of cover, a stock-out date, and a suggested order up to two cycles of cover. Status: Out; Reorder (< 10 days); Within a cycle; Healthy; Needs 2 counts. Also flags dead stock (on hand, nothing moved in 2 cycles) and anomalies (a cycle ≥ 3× the usual and ≥ 5 units, or a count that rose with no delivery). Every page says the figures are estimates.
- **Stock forecast** (`/stock/forecast`, plan §07g), a "Forecast" tab next to "Counts" on Inventory. A store picker, four tiles (reorder now, out, runs out within a cycle, healthy), and a table sorted by urgency (on hand, sold/cycle, cover, runs out, order, status). Until a store has two counts it explains why cover is blank and still shows on hand.
- **Action Feed** (`/action-feed`, plan §07h). A ranked to-do list: missing counts, out of stock, reorders, anomalies, dead stock with the pesos tied up. It covers all stores by default (each card tagged with its store) or one store, with filter chips by kind. Each card has one action (Order → forecast, Review / Plan → counts, Upload). Ranked by severity, then pesos at stake (`src/goldline-actions.ts`, tested). The plan's "ask the data" box is left out, since Goldline Chat is out of scope.
- **Store health** (`/store-health`). Health redefined for Goldline's data (no orders or CAC, so no QRR): a 0–100 score per store for the current form period. Weights: in-stock rate 40, days of cover 25, stock that's moving 15, form committed within 3 days of period end 20 (late = half). Cover and dead-stock parts stay neutral until a store has two counts. The page shows a company score (average of stores with a count), KPIs, and a store table worst-first with links to each store's counts. The scoring is explained on the page.
- **Data** (`src/goldline-ops-data.ts`): company- and store-scope fenced; reads only the last ~70 days of counts (up to 4 per store) plus the snapshot view, catalog and stores. Stores with no count this period surface as missing.
- **Nav** (Goldline): Overview · Stores · Inventory · Actions · Health · Uploads (Settings for multi-role). Mobile bar: Overview, Inventory, Actions, Uploads; More: Stores, Health.
- **Regression review (code-reviewer) + fixes:**
  - (HIGH) "Current period" was the newest count of any store, with an exact-match test, so one store with an odd or mistyped period made every other store "missing". It's now the period most stores counted in recent periods (`pickCurrentPeriod`), and a store counts as current if its latest count ends within 3 days of it (`isCurrentCount`).
  - (HIGH) A skipped cycle or an item missing from one count turned two cycles of sales into one, inflating velocity, orders and spikes. Sales are now normalized to the actual days between the item's counts.
  - (MEDIUM) A count that rose with no delivery was recorded as a zero-sales cycle and could fake "dead stock". It's now skipped (still reported as an anomaly). Spikes and dead stock only count when the newest cycle is the latest count.
  - (MEDIUM) Stores without this period's count now get only the missing-count action, not reorders built from stale counts.
  - (MEDIUM) The snapshot read is limited to the last 180 days, and store scope is applied in the queries, not just in code.
  - (LOW) Form timeliness uses the Manila date. Stable cross-store sort. Fixed a NaN in the forecast's cover sort.
- typecheck + full suite (2518) + pagination guard pass; impeccable detector: no findings.

## 2026-10-06 — Scan review extras: form grid, flag navigator, page strip, totals check
- **Two views of the rows.**
  - "Needs review" lists only the flagged rows; it's the default when anything is flagged.
  - "All · form grid" mirrors the paper: rows grouped under the printed family headings with their price (from the new catalog), and flagged rows still highlighted.
  - Search by item or code. Column headers carry the form's Tagalog column names as tooltips.
- **Flag navigator.** "Flag ‹ 1 / N ›" walks the flagged rows (wrapping) and focuses the row's first input, with "k of N resolved" next to it.
- **Resolving flags.** A flag is resolved by editing its row or clicking **Looks right**, which then jumps to the next open flag. The confidence card's "Review N flagged rows" now lands on the first open flag.
- **Commit is held until every flag is resolved** (plan §07d), with a "Resolve N flagged rows to commit" shortcut. The button reads "Confirm & commit".
- **Totals check.** Shows this page's ending value (on hand × printed price, with the same on-hand rule as Inventory) beside an optional "Total written on the form" field. Result: ✓ Reconciled within ₱1, or "Off by ₱X", saying which way.
- **Page strip.** Pages 1–5 under the file name: the current page, the latest scan of each other page (links), a red dot when that scan has flags, a ✓ when it's committed, and a dashed chip when a page has no scan yet.
- **Regression review (code-reviewer) + fixes:**
  - No critical or high issues.
  - (MEDIUM) The page strip was company-wide, so a page link could open another store's scan. It's now limited to the same form: a committed scan shows the scans committed into the same store + period ("Pages in this count"); a pending scan shows the uploader's other scans within ±12 h ("Pages uploaded with this one"), since pages 2–5 carry no store until reviewed. The current scan is read directly, not from a capped list.
  - (MEDIUM) A typed search could hide the next flag's row, so the navigator and "Resolve N flagged rows" did nothing. The search is lifted to the page and cleared when jumping to a flag.
  - (LOW) Editing resolves a flag only when the value actually changes. The navigator walks unresolved flags first. Removed a dead ref, and the family header uses `scope="rowgroup"`.
- Pure logic in `src/review-workbench.ts` (tested). New reads `catalogForCodes` and `formPageStrip`, both company-scoped and bounded. typecheck + full suite + pagination guard pass; impeccable detector: no findings.

## 2026-10-06 — Goldline catalog: product lines, prices and bestsellers for all 263 form items
- `gl_products` now covers every item on the inventory form, pages 1–5: **263 items, all priced, in 56 product lines, with 47 bestsellers.** Before, only 6 placeholder rows existed. Inventory value, Overview categories and the coming forecast / Action Feed / Health all depend on this.
- Source of truth is the blank Nichido templates: their text layer prints each family heading with its price, every item code and shade, and "(Bestseller)". `scripts/goldline/build-catalog.py` matches every manifest item (`src/goldline-extract.ts`) to its template line (accessories that share a printed "ACCS ###" code are matched by name), inherits the family heading and price (an item's own printed price wins), and treats items printed with their own price under another heading as their own product (outside Accessories / Make-Up Collection). 0 unmatched items.
- `supabase/seed_goldline_catalog.sql` is an idempotent upsert on (company_id, item_code). It sets product line, shade, price and bestseller and **leaves `sku_code` untouched** (the form doesn't print POS codes). Applied to Staging: 257 inserted, 6 updated.
- Correction: the 6 earlier placeholder rows had invented values (e.g. FBPP01 at ₱250, marked bestseller). The template prints ₱150 and marks Golden Tan, not Salmon, so those were overwritten. Their placeholder POS SKU codes (3800500x) remain and still need real values from a POS export or master list.

## 2026-10-06 — Scan review: confidence front and center
- The review page's Document card now leads with how sure the OCR was, said three ways:
  - **A large score** in the dashboard's metric face, colored by band: high ≥ 85%, medium 60–85%, low < 60%, which is the existing flag threshold.
  - **A verdict and what to do next.** High: "Check the N rows flagged below, then commit". Medium: review carefully against the scan. Low: check every row, a clearer scan helps.
  - **A stacked bar of rows by band** with counts, because an average can hide a few bad rows.
- "Review N flagged rows" jumps to the flagged rows.
- A one-line note says confidence is the reader's own estimate, not a guarantee.
- Per-row confidence chips use the same bands and colors, so the summary and the table agree.
- The store and period fields sit below with clearer labels, and the card shows the detected form page ("page 2 of 5"). Pages 2–5 get a hint to reuse page 1's store and period so all pages land in one Inventory count.
- **Regression review (code-reviewer):** no critical, high or medium issues; flagging and the commit flow are unchanged. Fixed the lows: row chips clamp to 0–100%; malformed (NaN) confidences are treated as 1 in both the summary and the table via `rowConfidence`, so they can't disagree; chip text is mixed toward the foreground (`toneText`) so amber clears AA contrast in light mode.
- Pure logic in `src/review-confidence.ts` (tested). typecheck + full suite (2491) pass; impeccable detector: no findings.

## 2026-10-06 — Starting view for multi-role users: last used by default, pinnable in Settings
- Each sign-in now starts in the user's **starting view**: their pinned view (Settings → Starting view) if they still hold it, else the **most recent view they used**, else the first view. A view they no longer hold is skipped. Rules in `startViewKey` (`src/company.ts`, tested in `src/start-view.test.ts`).
- "Most recent" is stored server-side, so it follows the person across devices and browsers. Every switch writes `last_view`. New additive table `company_user_prefs` (`supabase/company_user_prefs.sql`: user_email PK, default_view, last_view; RLS on, anon/authenticated revoked; applied to Staging, promote with the other SQL).
- Decision: the switcher's `active_view` cookie is now bound to one sign-in (`${viewSid}:${key}`). The sign-in id and starting view are minted in the JWT callback at sign-in and carried on the session. A cookie left from an earlier sign-in no longer overrides the starting view; within a session, switching works as before. Sessions from before this change keep the old cookie behavior until their next sign-in (`pickCookieView`), so nobody signed in at deploy loses switching.
- **Settings** is no longer Zoomy-only. `/settings` shows "Starting view" to anyone with more than one view (any view: Zoomy, Goldline, Coop Admin). Zoomy's digest preferences still show only in the Zoomy view. Settings appears in the Goldline and Coop Admin nav (and the mobile More sheet) only for multi-role users; a single-role non-Zoomy user is sent home from `/settings`.
- The Starting view card matches the header switcher (same badges, Coop Admin then companies A–Z), with "Where I left off" (showing what that currently is) on top. It saves on change, with a live "Saved" status; the server re-validates the choice against the person's roles (`setDefaultViewAction`).
- **Regression review (code-reviewer) + fixes:**
  - No critical or high issues.
  - (MEDIUM) A failed preferences read at sign-in would have silently pinned the first view for the whole 8-hour session. `fetchViewPrefsResult` now tells "none saved" apart from "unreadable", and on an error the JWT retries at most once a minute until it resolves.
  - (MEDIUM) The settings layout now notes that new routes under `app/settings/` aren't Zoomy-guarded.
  - (LOW) The `last_view` write runs in `after()`, so switching doesn't wait on it, and failures are logged.
  - (LOW) The Starting view options are disabled while a save is in flight, so there are no out-of-order reverts.
  - Reviewer confirmed: no input can grant a view, a user can't write another's prefs, the cookie stays bound across token refreshes, and pre-change sessions keep switching.
- typecheck + full suite (2493) + pagination guard pass; impeccable detector: no findings.

## 2026-10-06 — Goldline Inventory page, tied to the scan uploads; Uploads revamp
- **Inventory (plan §07f)** at `/stock` (nav: Overview · Stores · Inventory · Uploads). `/inventory` stays Zoomy's page behind the Zoomy data guard. One store × form period at a time, picked by store and period selects (`?store=&period=YYYY-MM-DD_YYYY-MM-DD`), defaulting to the latest period. Shows a "N low · M out" pill, four KPI tiles (Ending value, Items tracked, Low stock, Out of stock), and a table: Item, Product (★ bestseller, product line when catalogued), Stk / Drw / Sell straight from the form, On hand, Value, Status. Filters (All / Low / Out / Not counted), search, pagination.
- Rules, stated on the page and tested in `src/goldline-inventory.ts`:
  - **On hand** is the form's Ending column when it's written, otherwise stockroom + drawer + selling area. Delivery isn't added again because it's already in the physical counts.
  - **A blank row is "Not counted", never zero or Out.**
  - **Low** means fewer than 10 on hand.
  - **Value** is on hand × catalog price. Only 6 products have prices so far, so the tile says how many items are unpriced.
- **Tied to uploads:**
  - The page lists the scans it was built from, by form page, each linking to its review. It names the form pages (1–5) not in yet, with an Upload link.
  - A banner links to scans still waiting for review (`/uploads?status=needs_review` now pre-filters the list).
  - A committed scan's review page has "View in Inventory →" for its store and period.
- New additive view `gl_inventory_snapshots` (`supabase/goldline_inventory_snapshots.sql`): one row per company/store/period with item count, scans, consultant and last commit. It feeds the pickers so the page never scans all of `gl_inventory`. `security_invoker`; anon/authenticated revoked. Applied to Staging; promote with the other Goldline SQL.
- **Uploads revamp:**
  - **Add a file:** a real drag-and-drop zone (keyboard accessible) with colored type badges. Picking a file shows a file row (type, size, what happens next), date fields for a CSV's period (validated), and one clear action ("Upload and read scan" / "Upload sales").
  - **Live progress:** a step tracker (Upload → Find the page → Read the counts → Save for review) and a progress bar. The upload band is real bytes. The server now streams real milestones as NDJSON when asked (`Accept: application/x-ndjson`; other callers get the unchanged JSON). Within a stage the bar eases toward, but never reaches, its end (`src/upload-progress.ts`), so it can't claim "done" early. Elapsed time is shown; errors show inline with "Try again".
  - **File list:** colored type badges (CSV green, PDF violet, XLS red) per the plan.
- **Delete, with consequences spelled out:**
  - Deleting a committed upload now also removes the data it's still the source of: its `gl_inventory` counts or `gl_sales` rows. Counts a later scan has overwritten belong to that scan and stay. Previously they lingered with a dead source link.
  - A confirmation dialog (Base UI AlertDialog) checks the impact first and warns, e.g. "This scan is committed. Deleting it also removes its 43 inventory counts for 1 · CUBAO, Oct 1–15, 2026 from Inventory."
  - A toast confirms what was deleted.
- **Regression review (code-reviewer) + fixes:**
  - (HIGH) If the delete-impact check failed, the dialog said "no numbers change" while the delete still removed committed counts. A failed check now shows the reason with Retry, and Delete stays disabled until the impact is known. `deleteImpact` fails loud on query errors, and the dialog resets between files.
  - (HIGH) Store-scoped roles weren't fenced on the new paths. Inventory now only lists snapshots for the role's stores. Deleting, and checking a delete's impact, refuse uploads that touch stores outside scope (`uploadStores`, paged).
  - (MEDIUM) The dialog now warns that counts this scan replaced from an earlier scan won't come back on their own.
  - (MEDIUM) `deleteUpload` checks the extraction delete. The upload row still goes last, so a failure leaves a visible, retryable upload.
  - (MEDIUM) A CSV with no readable rows now shows its real reason instead of "Upload failed (422)".
  - (MEDIUM) The stream tolerates a client disconnect. A new `safeHandle` marks a stored upload failed on any unexpected error, instead of leaving it in "processing".
  - (LOW) A `?period=` without `?store=` now narrows the pick.
- Tests: `goldline-inventory.test.ts`, `upload-progress.test.ts`. typecheck + full suite (2485) + pagination guard pass; impeccable detector: no findings.

## 2026-10-06 — Removed the "Your access" tab; the header switcher is the one place to switch views
- Dropped the "Your access" nav item (desktop rail and mobile bar) and deleted the `/account` page and `account-view.tsx`, which nothing else linked to. The header view switcher already does the same job.
- Decision: the header switcher was hidden on phones (`max-sm:hidden`), so "Your access" was the only way to switch views there. The switcher now shows at every width, with the name truncated tighter on phones so the header fits.
- Single-view users see a plain label instead of a pill with a ▾ chevron that opened nothing.
- The mobile "More" sheet hides its empty link grid for Goldline and Coop Admin (it still holds Sign out).
- typecheck + full suite (2467) + pagination guard pass.

## 2026-10-06 — View switcher revamp: Coop Admin set apart, companies A–Z, color badges
- The top-bar view switcher (same `ViewSwitcher` component) now pins **Coop Admin** at the top with a shield badge and the caption "People & roles · no business data", then a divider, then **companies A–Z** under a "Companies" label (the label only shows when there's a Coop section to separate from). Each company has a stable color monogram badge ("GC", "Z") so views are told apart at a glance; the active one is marked with a check.
- The trigger shows the active view's badge and name only. The role moved into the menu's second line, which fixes the "Goldline Cosmetics · Compa…" truncation.
- Rebuilt on Base UI Menu (radio items, keyboard + screen-reader semantics, portal so it's never clipped, origin-aware 150 ms entry) instead of the hand-rolled dropdown and click-catcher overlay. A spinner replaces the chevron while switching.
- Decision: the order is display-only (`groupViews` in `src/view-switcher.ts`); `membershipViews` keeps its order because default-view resolution depends on it. Colors: Goldline is fixed to gold and Zoomy to green, any other company gets a stable hue from its id (`companyHue`), in light and dark variants. No company has `theme` set yet; a brand color there can override this later.
- Tested (`src/view-switcher.test.ts`). Design skills: impeccable (detector: no findings) + emil-design-eng. typecheck + full suite (2450) pass.

## 2026-10-06 — Users & Roles console redesigned (people-first, no re-typing emails)
- Pain point: giving an existing person a second role meant re-typing their email in the top "Grant a role" form. The console is now people-first: one row per person (initials, email, "You" marker, role count) with their access as chips. "+ Add access" on the row lists only roles they don't hold yet; one click grants it.
- Each access chip shows a status dot (active / invited / suspended) and opens a menu: Suspend or Reactivate, and Remove access…, which asks for an inline confirmation on the row (no modal). Your own Coop Admin chip explains that it can't be suspended or removed; the server still enforces the self and last-admin guards.
- "Invite person" opens an inline panel: email + pick one or more roles at once (checkbox tiles with what each role means). Typing an existing person's email switches it to "Add access" and greys out roles they already have. New server action `grantRolesAction` validates every grant before writing any (tested in `test/admin-actions.test.ts`).
- Search by email, filter by access (company / Coop Admin) and status, count, empty states for "no one yet" and "no matches" (with Clear filters), and a status legend. Menus use Base UI Menu (portal, origin-aware 150 ms ease-out entry).
- New shared `components/ui/native-select.tsx`: hides the browser arrow and draws an inset chevron, fixing the cramped right-edge chevron. Applied to the new console and the Goldline Uploads filters. Several Zoomy pages still use plain selects with the same issue.
- **Regression review (code-reviewer) + fixes:** (MEDIUM) inviting a brand-new person with several roles saved the first as `invited` and the rest as `active`; (MEDIUM) granting access someone already holds silently changed it, and could reactivate a suspended membership. Replaced `grantRole` with `grantRoles`: it reads the person's access once, skips what they already hold (the action reports "They already have this access"), gives every new row one status (`active` only if they already have an active membership), and inserts all new rows in one statement so a failure changes nothing. (LOW) malformed grant entries return a clean error; a pending "Remove…?" clears if that access vanishes on refresh; the inline confirm is `role="group"` (not modal), the saving spinner is a `role="status"`, and menu triggers stay focusable during a save (a second action is ignored). Reviewer confirmed the Coop Admin gate, self/last-admin guards, Base UI usage, and NativeSelect passthrough.
- Design skills: impeccable (Operate mode, craft floor, detector: no findings) and emil-design-eng. typecheck + full suite (2453) + pagination guard pass.

## 2026-10-06 — Goldline Overview rebuilt to the planned design (§07a)
- `/overview` for a non-Zoomy company now follows the plan mockup: a time-of-day greeting in Manila time ("Good morning, Goldline"), the sales window from the latest POS period, an "N stores live" pill (active `gl_stores`), three KPI tiles (Net sales, Units sold, Gross sales) using the house `Metric` tile with a change vs the previous period, and "Top categories" (net sales by `gl_products.product_line`, top 5 with "View all").
- Decision: the POS export is periodic, so "this window" = the latest `period_start/period_end` in `gl_sales` and the delta compares it to the period before. With one period there's no delta ("First period on record"), never a fake 0%.
- Empty handling: with no sales the frame stays (greeting, pill, "—" tiles) and the categories card becomes an upload prompt linking to `/uploads` (Company Users) or a note to ask one (read-only roles). SKUs without a product line roll into a muted "Uncategorized" row that always sorts last, with a footnote counting them. 0 active stores → "No stores live yet".
- Pure rollups live in `src/goldline-overview.ts` (tested: empty, window/prior selection, deltas, category mapping, greeting); `getGoldlineOverviewData` in `goldline-analytics.ts` does the company-scoped, paginated reads. Inventory / Health / Chat in the mockup's nav are still unbuilt (see `docs/goldline-onboarding-plan.md`).
- **Regression review (code-reviewer) + fixes:** (MEDIUM) a partial or month-to-date upload next to a full period would show a large false rise/drop "vs previous period" → deltas now only show when the prior period is like-for-like (`comparablePeriods`: ends before the current one starts and is within 3 days of its length, which allows semi-monthly 15/16/13-day halves); otherwise the tile says "No like-for-like previous period". (MEDIUM) the page paged through all of `gl_sales` on every render, growing with each upload → it now reads the latest period and the latest one ending before it (two one-row lookups), then only those two periods' rows. Reviewer confirmed tenant scoping on every read and the date/timezone handling. Left as is (LOW): categories with zero or negative net in the window aren't drawn as bars.
- typecheck + full suite (2456) + pagination guard pass.

## 2026-10-06 — Goldline uploads: the real cause of "couldn't process this scan"
- Read from the new `gl_uploads.error_detail`: every PDF failed with `400 output_config.format.schema: For 'integer' type, properties maximum, minimum are not supported`. The page-detect schema (`PAGE_DETECT_SCHEMA`) put `minimum: 0, maximum: 6` on the page integer, which structured outputs reject. Removed the bounds; `detectPage` already clamps to 0–6. The earlier "document-only message" diagnosis (below) was wrong; that change is harmless and stays. Tests now assert neither schema carries numeric bounds.
- Not a credits problem. `humanizeExtractError` now names an out-of-credits account plainly ("Automatic reading is paused…") instead of falling to the generic message.
- Uploads list: dropped the red reason line under each filename; the status pill is enough. The reason is kept as a hover title on the pill.

## 2026-10-06 — Goldline uploads: fix PDF extraction regression + review/nav/preview issues
- **PDF extraction was broken for ALL pages (incl. page 1)** after the page-auto-detect slice: `detectPage`'s user message contained a document block with **no text block**, which the API rejects (400). Added a text block + bumped its `max_tokens`. This is the fix for "1.pdf / 2.pdf … can't be scanned."
- **Larger pages**: extraction `max_tokens` 8000 → 16000 (pages 2 & 4 have ~67–68 rows; 8000 truncated the JSON). `store_code` is now optional in the schema/guard (only page 1 carries the store header; pages 2–5 have none) and normalized to `''`.
- **Diagnostics**: new nullable `gl_uploads.error_detail` (scrubbed, ≤500 chars) stores the raw technical error on failure for debugging via the DB; the UI still shows the friendly `reject_reason`.
- **Double "Overview" in the nav**: the legacy Overview accordion group is now Zoomy-only; non-Zoomy companies get the single flat Overview tab (fixes the duplicate for Goldline and the stray Overview for the data-blind Coop Admin).
- **Delete action**: Uploads file list gets a per-row delete (confirm step) → `deleteUploadAction` → removes the stored file + staged extraction + row, company-scoped; `canEditData` only.
- **Product name in review**: the review rows table now shows the printed product name (from the detected page's manifest) beside each item code.
- **Scan preview**: the `[id]/file` route now 307-redirects to the short-lived signed URL (Supabase serves the PDF with Range support, which in-iframe PDF viewers need) instead of buffering a 200-only body that rendered as a broken box.
- **Auth**: `trustHost: true` + auth errors routed to `/signin` (addresses the `/api/auth/error?error=Configuration` bounce on the staging callback). Also gitignored the local `.impeccable/` and `graphify-out/` generated dirs.
- typecheck + full suite (2443) + pagination guard pass.

## 2026-10-06 — Goldline: inventory pages 2–5 extraction + page auto-detect + 2-column review
- **Manifests pages 2–5** (`src/goldline-extract.ts`): enumerated every printed item from the blank Nichido templates (page 2 ~67, page 3 ~60, page 4 ~68 incl. accessories, page 5 ~25). Page 4's accessories share a printed ITEM# (ACCS 288/150/125…) so codes are synthesized from the brush number to keep each row unique. Page 6 is the daily Sales Report (not inventory) — intentionally no manifest. Added `INVENTORY_PAGES`.
- **Page auto-detect** (`buildPageDetectPrompt` + `PAGE_DETECT_SCHEMA`; `detectPage` in `goldline-extract-run.ts`): a cheap Vision call reads the footer "PAGE # N", then the upload route extracts with that page's manifest — upload any single page and it just works. Page 6 / unrecognized pages get a clear out-of-scope message (no empty review). Removed the hardcoded page=1.
- **Review preview** (`app/api/goldline/uploads/[id]/file` + `upload-review.tsx`): the proxy now buffers bytes + sets content-length / X-Frame-Options SAMEORIGIN (fixes the blank "can't preview" box). New 2-column layout — a compact, sticky scan thumbnail (~28%, click to enlarge in a full-screen lightbox) on the left, the editable table + commit on the right (~72%).
- Tests: manifest integrity (unique codes, non-empty, page-6 absent), per-page prompt, detect schema. typecheck + full suite (2409) + pagination guard pass.
- **Regression review (code-reviewer agent) + fixes**: (HIGH) the added sequential `detectPage` call could push the PDF path past the route's 120s `maxDuration` (detect+extract), risking a hard kill that leaves an upload stuck in `processing` — tightened timeouts (detect 20s + extract 85s = 105s) and raised `maxDuration` to 160s so a slow call throws in-code (catch → `failed`) instead. (LOW) refreshed the now-stale page-1-only `humanizeExtractError` message + its test for the pages 1–5 world, and corrected comments that still said "reads page 1" / mislabeled `scanUrl` as a signed URL. Reviewer confirmed tenant isolation on the proxy, route control flow, manifest uniqueness (incl. page-4 synthesized codes), detect clamping, preview/XSS, and the client/server boundary.

## 2026-10-06 — Chat: a looping answer (`<br> <br> ...`) is stopped, not streamed to the cap
- Bug (staging, Explore on): the model looped on `<br>` until `max_tokens`, so the owner saw ~1,500 `<br>` then "The answer was cut off." `<br>` appears nowhere in our prompts or data, so this is model degeneration; trigger most likely the tool-less wrap-up step: a local Playwright run with a 34 s first model step crossed the 30 s soft deadline, `tool_choice: none` followed, and the model typed `<render_chart> </render_chart>` as text (a milder form of the same failure). Raw network latency alone cannot produce this, but a slow model step can reach it.
- Fix, three layers: (1) `src/chat/degenerate.ts` + `loop.ts` abort the stream when one 1-12 char unit (with a letter, digit or angle bracket) repeats 20+ times, then end with `DEGENERATE_TEXT` and `stopReason: 'degenerate'`; (2) `COOP_CHAT.output` forbids HTML tags and "I'll add X" without the tool call, and `WRAP_UP_TEXT` says plain text only; (3) `collapseBr` in `chat-markdown.tsx` collapses stray `<br>` runs to one newline and drops typed `<render_*>` tags (fenced code untouched).
- Decision: message only, no auto-retry, `maxTokens` unchanged (a bigger cap only makes a runaway cost more). Live path can still show up to 19 repeats already streamed.
- Test: `chat-loop`, `chat-degenerate`, `chat-markdown`, `chat-prompt`. Verified in the browser against the local harness (Playwright): no junk, no cut-off. Open: the staging `chat_turn` line for the original turn would confirm the trigger.

## 2026-10-06 — Explore status and a live probe in /api/chat/health
- Feature: `GET /api/chat/health` gains an additive `explore` object so a hosted deployment shows why Explore is on or off. `enabled` and `reason` come from `resolveExploreAccess` for the signed-in person (reason codes only, never the URL or list); flags `EXPLORE_MODE` (`on`), `EXPLORE_DATABASE_URL` (`set`, `length`, `roleOk`, hostname-only `host`, `kind` pooler/direct/loopback/other), `EXPLORE_ALLOWED_EMAILS` and `ALLOWED_EMAILS` (`set`, `count`). When enabled, `probe` runs one fixed statement (`current_user`, `transaction_read_only`, a count of `coop_explore_orders`) through the same read-only cursor envelope as the chat, capped at 5 s, and reports `{ok, role, readOnly, ms}` or a short code (`connection_refused`, `auth_failed`, `timeout`, `undefined_table`, `permission_denied`, ...), never driver text. No probe for non-allowed users; nothing cached or logged.
- Decision: the probe lives in `src/chat/explore/probe.ts` (pure, injected runner) and the real driver is reached only through `explore-setup.ts` (`exploreHealth`), so the architecture rule that only `client.ts` imports `postgres` and only `explore-setup.ts` imports `client.ts` still holds. `ExploreDbError` now carries the driver code (`sqlstate`, never text) so the probe can tell a wrong password from a closed port. Runbook: "Explore status in /api/chat/health".
- Test: `chat-explore-probe.test.ts` (fake runner) and `chat-explore-probe.integration.test.ts` (local Docker only, loopback guard first).

## 2026-10-06 — Uploads: inline scan preview (CSP-safe) + honest non-page-1 handling
- **Preview**: the review page embedded the PDF with `<object>`, which the app CSP (`object-src 'none'`) blocks → "Can't preview inline". New same-origin proxy `GET /api/goldline/uploads/[id]/file` (company-scoped, streams the private file as application/pdf) + an `<iframe>` (frame-src is open) so the scan renders inline; signed URL stays server-side.
- **Non-page-1 PDFs**: the route reads every upload against page 1's manifest, so a later page (2.pdf/3.pdf) returned 0 rows and showed a misleading empty-but-committable review. Since a real page 1 always yields one row per printed item, 0 rows now fails loud with a clear "this doesn't look like page 1 — page 1 only in v1" message. (Full multi-page support still needs the blank page 2–6 templates.)
- typecheck + full suite (2405) + pagination guard pass.

## 2026-10-06 — Uploads review: scanned-file preview (planned in §07d)
- `src/goldline-data.ts`: `signedUploadUrl(companyId, uploadId)` — a short-lived (10 min) signed URL to the stored scan, company-scoped (ownership re-checked, so one tenant can't fetch another's file); `UploadRow` + the reads now carry `storage_path`.
- `app/uploads/[id]/page.tsx` + `components/analyst/upload-review.tsx`: the review page shows the scanned PDF inline (collapsible `<object>` + "Open" in a new tab) above the extracted rows, so the reviewer can compare the source against the numbers. The bucket is private; the browser loads it via the signed URL. typecheck + full suite (2405) + pagination guard pass.

## 2026-10-06 — UX: human-readable upload extraction errors
- `src/goldline-extract.ts` `humanizeExtractError` (+tests): maps raw extraction / Claude API errors to short, plain-language messages — the page 2–6 manifest gap ("supports page 1… pages 2–6 coming soon"), page_mismatch, unreadable scan, busy/rate/timeout — and a safe generic for anything else (400s, invalid_request_error) so a raw JSON blob never reaches the UI.
- `app/api/goldline/upload/route.ts`: the PDF extraction catch now logs the raw error server-side and shows/stores the friendly message (both the inline error and the file row's reject reason). typecheck + full suite (2405) + pagination guard pass.

## 2026-10-06 — Fix: Goldline PDF extraction 400 (invalid thinking param)
- `src/goldline-extract-run.ts`: removed `thinking: {type: "disabled"}` from the Claude Vision call — `claude-sonnet-5-5` rejects it with a 400 ("send {type: between_tools} instead"). For a pure, no-tools extraction we omit the param and let the model default, so a scanned PDF upload reaches the review workbench instead of failing. (The upload/auth/storage/key path was already working; only this param was wrong.)

## 2026-10-06 — Multi-role access: regression-review fixes (session freshness, atomic-ish audit, admin index)
- **CRITICAL**: revoke/suspend now takes effect in real time. Admin actions (`app/admin/actions.ts`) re-read the actor's roles from the DB — not the session token — before any write; the JWT refreshes memberships every ~5 min and session `maxAge` is 8h (`auth.ts`). A revoked/suspended membership stops working within minutes instead of living in the JWT until it expires.
- MED: audit writes are best-effort (`src/admin-data.ts`) — a committed role change is never reported "failed" because the audit insert hiccuped; failures are logged instead.
- LOW: partial unique index `company_users_one_coop_admin_per_email` (NULL company) backstops duplicate coop_admin rows (applied to Staging + `supabase/multi_role.sql`).
- Reviewer confirmed: no cookie/param privilege escalation, role-write authz, lockout guards (incl. no grant-bypass of the last admin), membership-only gate (suspended excluded, invited activated), coop_admin NULL-company handling, tenant isolation, client/server boundary, Zoomy legacy unchanged. typecheck + full suite (1844) + pagination guard pass.

## 2026-10-06 — Multi-role access P2: Users & Roles console + membership-only gate
- `src/admin-data.ts`: Coop-Admin role-management data layer — `listUsers` (grouped by email), `listCompanies`, `grantRole`/`setStatus`/`revoke`, `countCoopAdmins`; every write logged to `company_user_audit`; bounded count/single reads marked `pagination-ok`.
- `app/admin/actions.ts`: coop_admin-gated server actions (re-checked server-side, never trusting the client) with lockout guards — can't remove/suspend the last active Coop Admin, can't suspend/revoke your own Coop Admin; email/role/company validated.
- `app/admin/users` + `admin-users-view`: the console — grant form (company → Company User, or Coop Admin) + per-membership suspend / reactivate / revoke. Data-blind.
- `auth.ts`: sign-in gate is now **membership-only** (dropped `ALLOWED_EMAILS`); pre-granted `invited` memberships flip to `active` on first sign-in.
- typecheck + full suite (1844) + pagination guard pass.

## 2026-10-06 — Multi-role access P1: active-view model + "Your access" switcher
- `src/company.ts`: `resolveActive` is now VIEW-based — the user picks the active view (a company id, or the `coop_admin` sentinel) instead of coop_admin always winning. `membershipViews`/`viewKey` expose the selectable views; `canManageRoles` (coop_admin-only) replaces `canManageTeam`; `fetchMemberships` reads `status` and drops suspended rows. Membership gains optional `status`.
- `src/active-context.ts`: `active_view` cookie (was `active_company`); `getNavContext` returns every view (+ names) and the active key; `requireZoomyData` redirects a non-Zoomy view to `homeFor()` (Coop Admin → /admin/users, company → /overview).
- `app/actions/company.ts`: `setActiveView`. `company-switcher.tsx` → `ViewSwitcher` (shows `Company · Role` / `Coop Admin`). `app/account` + `account-view`: shared "Your access" page (not Zoomy-guarded) to switch views.
- `dashboard-shell`: per-view nav — Zoomy legacy unchanged; Coop Admin view → Users & Roles + Your access; a company view → Overview/Uploads/Stores/Your access; header view-switcher when >1 view.
- `supabase/multi_role.sql`: additive `company_users.status` + `company_user_audit` (applied to Staging). Tests updated/added (viewKey, membershipViews, resolveActive-by-view, canManageRoles, homeFor). typecheck + full suite (1844) + pagination guard pass.

## 2026-10-05 — Local dummy pet data for trying Ask Coop Explore by hand
- Test (local DB only): `scripts/local-supabase/dummy-pets.sh apply | remove | status` loads a fictional, deterministic layer into the local Docker Supabase: 6 `[DUMMY] ` events (Aug to Oct 2026, one a lowercase / trailing-space respelling of another), 254 orders (about 30 percent with no `pet_type`, 35 on event dates with no event id, 5 voided, products P1 to P4 and bundles B1/B2 only) with 436 order items, and 122 `spin_wheel_leads` (campaign `dummy-*`, `example.com` emails, fake handles) whose free-text `pet` column mixes "Name / Breed", no slash, name only, breed only, odd case, extra spaces, "Aspin mix", empty, null and two hostile values. Pet-type mix differs by event (SM Aura dog-heavy, Circuit Makati cat-heavy, Trinoma "both"-heavy), so rankings are not ties. Markers: event ids `D-*`, order ids 100000 to 199999, campaigns `dummy-*`; `remove` deletes exactly those and restores the plain fixture.
- Expected answers: `dummy-pets-expected.sql` (SELECT-only) and its saved output `dummy-pets-expected.txt` (pet type per event, breeds per event, leads with no breed, tagged vs date-attributed orders, weekday sales). The header of `dummy-pets.sh` has the how-to and 8 sample questions (Taglish and English). Decision: run `dummy-pets.sh remove` before `npm test`: with the data applied the golden test EXP-03 R01 fails by design (its name search also matches the dummy "Circuit Makati Weekend"); the RO proof exits 0 either way.

## 2026-10-05 — Ask Coop: fixes from the seventh live run (G08b, G14, G15)
- Fix (J1, G08b/G15): the Explore backstop now also draws registry results. A turn on the Explore tool set that ends (end_turn, wrap-up, deadline, max steps) with a successful `query_metric` result of at least two rows that no block was drawn from gets it drawn by the app, exactly as `render_chart` with auto selection would (the registry's own `recommendView`: kpi, chart or table; the result's own checks and caveats), at most two results per turn. A one-row result stays text (THINK-06), an error result draws nothing, a result the model rendered is not drawn twice. Typed markdown tables are now stripped on registry turns too, but only when a block was drawn (by the model or the app); a turn where nothing was drawn keeps its table. Turns without the Explore tool are unchanged (their text streams live and cannot be stripped). Decision: a table-only answer is a defect (owner rule), so the guarantee is in code, not the prompt. Code: `autoRender` in `render-executors.ts`, `registryUsed` and `releaseHeld` in `loop.ts`; tests `test/chat-registry-autorender.test.ts`.
- Fix (J2, G14): an Explore result with ONE category column and several measures (weekday, orders, revenue, share; 7 rows) was drawn as one stacked bar with 7 weekday series titled "Orders by Weekday". Root cause in `recommend-view.ts`: `rowsAreWhole` treated any share column summing to ~100 as "the rows are the parts of the plotted measure", so the 7 categories became series of one stacked bar, and the primary measure was just the first one (orders). Now, for Explore results only: several measures never count as a whole (the share belongs to one of them); the plotted measure is the one the title names, else the first peso measure, else the first count (never the share); and a short list (up to 7 rows) keeps the SQL row order instead of re-sorting by value. Result: kind bar, x weekday, one series, "Revenue (PHP) by Weekday". The Explore guide gets a calendar-order line (order by isodow / month number / hour unless a ranking was asked, and still return the ranking figure as a column).

## 2026-10-05 — Ask Coop Explore: fixes from the fifth live run (G01)
- Fix (H1): the display label of a merged group must be the group key. The model grouped by `lower(btrim(e.name))` but labelled with `min(btrim(e.name))`, which returns a different spelling per pet sub-group, so one event was drawn as two categories. The Explore guide (EXP-06) and example E02 now select `lower(btrim(e.name)) as event`. Backstop in code (`spellingSplitCaveats`, `explore/result.ts`): when two labels of a category column are equal after `lower(btrim())` but spelled differently, the result carries "Labels X and Y differ only in capitalisation or spacing; they were not merged: group by lower(btrim(...)) in the SQL to merge them." on every block drawn from it (auto-render or model-rendered). Decision: code flags, never merges (merging would change numbers).
- Fix (H2): on an Explore turn where a block was drawn (model render call or the app's backstop), GFM markdown tables are removed from the answer text before it is shown (`stripMarkdownTables`, `src/chat/strip-tables.ts`; prose around them stays, blank lines collapse, fenced code is untouched). The app already draws the chart + table twin, and the model had typed a second copy. Turns with no drawn block and non-Explore turns keep their tables.
- Fix (H3): on Explore enforce turns the number-check context no longer includes earlier ASSISTANT turns, only the user's own messages, the preamble and the selected-period block (plus this turn's result cells). A stale model-typed "6 orders" from a previous reply let a typed "Correction: ... 6 orders" through. The log-only check of non-Explore turns keeps every earlier turn as context. Test meaning change: none of the old tests relied on assistant-turn figures.

## 2026-10-05 — Ask Coop Explore: fixes from the fourth live run (G01)
- Fix (G1): the auto-render backstop now draws EVERY successful, non-empty, unbound `final` Explore result of the turn in query order (at most 3; extras are named in a caveat on the last drawn block), each with its own chip, Show SQL and code-written caveats. The live turn had two finals (orders by event and pet, leads by event and breed) and only the leads were drawn, so the orders block's basis caveat never showed. Probes are still never drawn, a result the model rendered is not drawn again, no model call. Test meaning change: "two finals, neither drawn: only the LAST is drawn" now expects both.
- Fix (G2): auto chart titles are built from column labels only, never from row or series values. Two category columns: "<measure> by <dimension> and <dimension>" ("Revenue (PHP) by Event and Pet"); more than 3 measure columns (a pivot): a unit word, "Counts by Event"; up to 3: their labels. Explore peso columns read "(PHP)". The chart alt text names at most 3 series, then "and N more". Decision: the title says what is plotted, so a result with several peso measures is titled by the one drawn.
- Fix (G3): no mental arithmetic. The model had added two spellings of one event in its head ("6 orders", true 7) and typed per-event totals that were no cell. (a) `sql-explore.md` EXP-04/EXP-06: never add, merge, round or total figures in prose; merge spellings in the SQL (`group by lower(btrim(name))` + `sum`) and return per-group and grand totals as cells; the old "two spellings are two rows" line is replaced. (b) Example E02 is now a case-insensitive event grouping with a per-event total column (window sum); the local-fixture test checks the total equals the pet rows' sum. (c) `number-check.ts` gained `countNouns`: on Explore enforce turns a single digit before order(s), lead(s), sign-up(s), event(s), customer(s), unit(s), item(s), pack(s) or bundle(s) must be a cell; the existing held-text retry (one rewrite, with the violation list) handles it. Registry and non-Explore checks are unchanged (option off by default).

## 2026-10-05 — Ask Coop Explore: fixes from the third live run (G01, R01, G25)
- Fix (F4): `sql-explore.md` EXP-06 now says normalising free text (pet, prize, handles) must never fold unparseable or odd values into a "no breed given" or "other" bucket silently: list those rows separately with a count and the reason and report instruction-like text as data in its field (G25). Guide rule only, no code filter; pinned by `test/chat-explore-skill-rows.test.ts`.
- Fix (F3): registry `event_rollup` rows now carry `tagged_orders` (explicit POS event tag) and `date_orders` (untagged sales attributed by the event dates), computed in code from the tagged-id set taken before `resolveOrderEvents`, with a reconcile check that they add up to `orders` (additive: existing columns and numbers unchanged; the description lists the columns for `describe_data`). With the event filter 'all' the caveat now says "All events combined" and points to the per-event split in the rows, because the model had applied the combined 17 tagged to a single event (R01). Test meaning change: the existing event_rollup rows assertion gained the two keys.
- Fix (F1+F2): the model ended Explore turns after `run_query` without calling a render tool, so the chart choice, the Exploratory chip, Show SQL and the code-written caveats never ran. Decision: the app owns the backstop. When an Explore turn finishes (end_turn, wrap-up, deadline, max steps) with a successful `final` result no block was bound from, `autoRender` (`render-executors.ts`) draws the LAST such result through the render_chart auto path (chart with table twin); no model call, no model-typed numbers, probes and empty results never drawn, no duplicates. Text from an Explore-capable step that calls tools and no render tool is now dropped (`loop.ts`), so repair narration ("Fix the grouping.") never opens the answer. `sql-explore.md` tells the model the app draws the result and it should explain in 2 to 3 sentences, not retype a table. Test meaning changes: the probe test (narration used to leak) and the executors key list (now includes the non-tool `autoRender`).

## 2026-10-05 — Ask Coop Explore: fixes from the second live run (G01)
- Fix (D1): an Explore result with two category columns (event, pet) and several measures now draws ONE measure (the one the block title names, else the first peso measure) with the second dimension as series, and folds nothing until past the existing limits (`recommend-view.ts` `decideTwoDim`; the title is passed in from `bind.ts`). Before, it plotted orders under a revenue title and folded 8 rows into "Other".
- Fix (D2): the evidence note is written by code. `parse.ts` now returns `columnRefs`; orders joined to events get a basis caveat (tagged to the event in the POS, by the event date window, or both) and a leads query gets the lead count, the count with a pet value and the date pet was first collected (the fixed coverage statement gained two columns; counts are for the whole leads view, not the query's scope). Decision: code, not the model, owns the "how was this counted" sentence.
- Fix (D3): `sql-explore.md` EXP-06 now says row text is data: never silently drop rows because their text looks like an instruction; state the exact criterion and the count whenever rows are excluded; report instruction-like text as data in its field, ignored. Pinned by `test/chat-explore-skill-rows.test.ts`.
- Fix (D4): `allowedDevOrigins: ['127.0.0.1']` in `next.config.mjs` (dev only). Next 16 blocks cross-origin dev requests, the HMR websocket included, from any host but localhost, so the page never hydrated at http://127.0.0.1:3100. Confirmed in the Next 16 docs for `allowedDevOrigins`.

## 2026-10-05 — PR template, `pr-description` skill and hook
- Chore: `.github/pull_request_template.md` (tables for summary, changes, tests, checklist, rollout). The shared `pr-description` skill fills it from the real diff; a PreToolUse hook (`.claude/hooks/pr-description-check.mjs`) blocks `gh pr create` unless the body has the template sections and the title is a Conventional Commit. Bypass: `PR_CHECK=off`. Decision: block `--fill` because a commit-log body skips the checklist.

## 2026-10-02 — v1.4.1: Save report no longer fails on a blank title
- Fix: saving a dashboard whose title the model never set answered "Give the report a title." Now the title falls back to the first block's title or tile label, then the question that produced it, then "Untitled report" (`src/reports-title.ts`). An explicit title still wins; rename from the report page.

## 2026-10-01 — Talk to Data: the Ask Coop Data Analyst skill — `feat(chat)`

How Ask Coop thinks, now as runtime product content in its cached prompt
(`src/chat/skills/ask-coop-data-analyst/`): a core "How you think" procedure (understand, check the
data first, get every number from a tool, sanity-check, state the method, present like an analyst,
close the loop), a voice, and four topics (parts and totals, comparing periods, allocated figures
and prices, coverage and data quality). Every rule has a stable id; a gear marks the 18 rules the
app also enforces in code.

- **The guide and the code cannot drift:** tests fail if an id exists on only one side, if a
  placeholder is unfilled, if a number in the text differs from the code constant, if a gear rule has
  no test titled with its id (the gate is shown to fail), or if the skill passes its size budget
  (about 2,400 tokens today, cap 4,500, estimate).
- **Scope decision:** the chart-form and dashboard-layout topics describe things that do not exist
  until the chart tools (F7), so they ship with F7. Today's skill says only what the app can do.
- Replaces the two stopgap guardrail lines from the previous step with rules BI-08 (rank claims
  only about the rows shown) and ANL-04 (no number words).
- **Kept out of the prompt on purpose** (tests guard it): production-derived figures (a prompt gets
  parroted and the data changes), and any promise to "log" or "save" something Coop cannot do.
- Vercel: a real `next build` shows the skill files are traced into the chat route, so no config was
  needed.
- **Live skill evals** (12 cases, real model, synthetic data, mechanical scoring): 11 of 12 pass.
  Reading the failures led to three changes: a narrow question must not get an unrequested comparison
  (THINK-06 and a scorer check), the small-sample rule now says "say small sample before any figure
  and lead with counts" instead of banning a share the owner asked for, and a scorer false negative
  was fixed. The remaining failure was a 4th sentence, so the cap became 4 (a method line and a next
  question already make 3).
- **No regression** on the 14 base questions with the skill loaded (real data, read-only): median
  5.4 s, p95 11.3 s, median cost $0.015 and max $0.033 (estimates); cached prefix 12k to 15k tokens.

---

## 2026-10-01 — Talk to Data: Ask Coop answers from live POS data — `feat(chat)`

The first real answer. A question in the Ask Coop drawer is answered from live offline POS
data through the metrics registry, streamed, with the data check first. Verified in a real
browser against the real (read-only) data: the dog/cat bundle split reproduces the plan's
figures with the caveats first.

- **Data check:** `describe_data` and a short coverage note on every question (today's date
  in Philippine time, the date range, how much is untagged, what is not available), so the
  model learns the limits before it queries. This fixes the wrong-year date seen in the spike.
- **Tool loop** (`src/chat/loop.ts`): a manual, streamed Messages-API loop on Sonnet 5.5 with
  two strict tools, up to 8 steps, the model's thinking blocks passed back unchanged, every
  request through the layer-1 shape check. NDJSON stream; the drawer shows a status line
  ("Looking at bundle sales") while it works.
- **Decision:** where the live-data path is not ready (production before the read-only
  database role is applied, a missing secret, a failed load) the chat **degrades to
  digest-only** (no tools, no POS reads, one `chat_degraded` log line) instead of returning
  503, so today's working digest chat does not go down on staging or PROD. The plan had a hard
  503. Safety is unchanged: no POS data is read without the guarded path.
- A tool that refuses a request (unknown dimension, undeclared measure) now reaches the
  model flagged as an error with the allowed values.
- **Live measurements** (14 questions, real model, effort medium, estimates): median 6.3 s,
  data questions 8.4 s, p95 12.8 s, cost median $0.014 and max $0.044, prompt cache hits on
  every call after the first, 0 guard trips, 0 errors.
- Reading the live answers found three defects, fixed before shipping: a rank claim from a cut
  list ("sold the most units" when only the top 5 by revenue were shown), home-made number
  words ("about half"), and a misleading "34% untagged" caveat on the SKU split (the share now
  counts only orders that have pick detail). Two guardrail lines cover the first two until the
  analyst skill lands.
- The digest stays in the prompt for Shopee, Lazada and Website questions (the pinned legacy
  import remains until `get_digest` exists).
- Known, pre-existing and dev-only: `ask()` calls `send()` inside a React state updater, so
  React Strict Mode sends the first question twice in development. Production runs it once.

---

## 2026-10-01 — Talk to Data: metrics registry, exact bundle allocation and checks — `feat(chat)`

The semantic layer behind Ask Coop: every figure comes from one registry definition computed
by code, never by the model. Nothing user-visible changes yet (`/api/chat` is not rewired;
`describe_data`, the tool schemas and the model loop are the next features).

- **Nine metrics** with declared measures and one-line methods: `offline_revenue`,
  `offline_orders`, `offline_aov`, `top_products`, `payment_mix`, `event_rollup`, `pet_mix`,
  `bundle_sales`, `bundle_picks`. A pure `runMetric(request, data, now)` rejects anything off
  the closed shape (free-form keys, undeclared measures, bad dates) with the allowed values.
- **Decision:** a bundle's pick lines carry ₱0, but peso values per SKU are derivable. Each
  bundle's paid price is split across its picks by list-price weight **on the sale date**
  (`src/pos-price-history.ts`, `src/pos-bundle-compute.ts`), in whole centavos with the
  largest-remainder rule, so SKU totals add back to the paid total exactly (₱0 tolerance).
- Checks and insights are code (`src/chat/checks.ts`, `insights.ts`): reconciles, round
  row count, ₱0 lines, price changes, small sample, untagged share, partial coverage, sudden
  change, mock source. A failed check marks the result unreliable.
- Checked against the real PROD data (read-only, nothing committed): bundle revenue ₱147,300
  (equals the existing `bundleSalesSummary`), named ₱106,950, dog 66.4% of tagged, Buy Any 4
  92.8% of named, 582 picks allocating exactly ₱106,950 against ₱139,360 list value.
- Found in that run: the SKU breakdown covers only ₱106,950 of the ₱147,300, because 68 older
  bundle orders have no pick detail. The result now says so. Also fixed before shipping:
  SKU rows were grouped by name, which would merge two products that share a name.
- Dates are Philippine time, weeks run Monday to Sunday; a range outside the data is valid
  and reports coverage partial or none (a wrong-year range returns "no data in that range").
- SQL: three more dashboard-owned views for the role (`coop_chat_prices`,
  `_price_changes`, `_events`; no cash or staff columns). Still not applied to any hosted
  project. Local proof: 69 checks pass, and all nine metrics return identical results in
  `ro_role` and `guarded_service` mode.

---

## 2026-10-01 — Talk to Data: database read-only role for Ask Coop — `feat(chat)`

Layer 5 of the read-only enforcement: even if every code layer failed, the database
refuses a write. **Nothing is applied to any hosted project yet**: the SQL is applied by
hand (staging first, PROD by the co-worker) and gates the PROD release.

- `supabase/coop_chat_readonly.sql` creates role `coop_chat_ro` (no login) and four
  dashboard-owned definer views (`coop_chat_orders`, `_order_items`, `_products`,
  `_bundles`) with no customer columns, SELECT only. It does not touch any `pos_*` DDL.
- **Decision:** the earlier plan to revoke EXECUTE-from-PUBLIC on every `public` function
  is NOT applied blindly: zoomy-pos owns those functions and may rely on that grant.
  Instead a `db_pre_request` hook makes every request as `coop_chat_ro` run in a read-only
  transaction (a callable write function then fails), and a read-only audit query lists
  what the role can execute. The revoke/grant sweep is a separate optional file that needs
  zoomy-pos sign-off.
- Known limit: the hook stops writes, not reads through a callable read function. Layer 4
  (the HTTP guard) blocks `/rpc` in the app; the sweep closes it in the database.
- `src/chat/read/mint-jwt.ts` mints a 5-minute HS256 token (`node:crypto`, no new
  dependency) from `CHAT_RO_JWT_SECRET`; `ro_role` mode fails closed (503) without it and
  never reads the service-role key. Optional `CHAT_RO_APIKEY` is sent as the `apikey`
  header (untested against the hosted gateway).
- Proved on a throwaway local Supabase in Docker (`scripts/coop-chat-ro-proof.mjs`, 53
  checks, idempotent, refuses non-local URLs), including: a SECURITY DEFINER write
  function was callable by the role until the hook, and fails with "read-only
  transaction" after it; service_role, anon and authenticated are unaffected.
  `test/chat-ro-local.integration.test.ts` (skipped unless pointed at a local stack)
  shows `ro_role` answers equal `guarded_service` answers and no customer value returns.
- Architecture scanner: the `.update(` ban gets one pinned exception for `createHmac().update()`
  in `mint-jwt.ts` only; the same call anywhere else still fails the build.

---

## 2026-10-01 — Talk to Data: read-only foundation for Ask Coop — `feat(chat)`

Ask Coop is being upgraded to answer from live POS data (design:
`../knowledge/architecture/2026-10-01-talk-to-data-design.md`). Before any data tool
exists, this lands the layers that make sure it can only **read**. Nothing changes for
users yet: `/api/chat` is not rewired, and the existing digest chat behaves as before.

- **Decision:** "no write tool exists" is one layer of nine, not the guarantee. The model
  reads text other people wrote (product names, notes), so each layer fails closed with
  its own test. This is a release gate for every Talk to Data deploy.
- `src/chat/tools.ts` frozen tool allowlist, `request-shape.ts` (no web, code or MCP
  tools, no forced tool choice), `audit.ts` (`chat_tool` / `chat_guard_trip` log lines).
- `src/chat/read/`: a typed read client (`select` only), an HTTP guard (GET/HEAD only,
  allowlisted relations, no `select=*`, no customer columns) and a fail-closed read mode
  (production returns 503 unless `CHAT_READ_MODE=ro_role`).
- `src/pos-orders-read.ts`: `readPosOrders(client)` extracted from `src/pos-sales.ts` so
  chat and the pages share one paged read with an **injected** client. Page behaviour is
  unchanged (fixture regression test, 1,352 items across two pages).
- `test/chat-architecture.test.ts` fails the build if chat code imports a write path or
  a full-power client. One documented legacy exception: the route's `getDigests` import,
  removed when the route is rewritten.
- Found while testing: the guard judged the raw path but took the host from the parsed
  URL, so `https://host\@evil/...` slipped past. Fixed by requiring both to agree; tests
  cover it.
- Spike findings behind this: `scripts/spikes/` (strict tools + thinking on Sonnet 5.5,
  and a SELECT-only database role through PostgREST). Layer 5, the database role, is the
  next feature and gates production.

---

## 2026-10-05 — UX: sign-out confirmation
- Signing out now opens a confirmation dialog ("Sign out of Coop?") instead of firing immediately — it was a one-click destructive action with no guard. Shared by both entry points (desktop account menu + mobile sheet); dismiss via Cancel, overlay click, or Escape; the confirm action uses the destructive token. No behaviour change beyond the extra confirm step.

## 2026-10-05 — Goldline P3/P4: Stores leaderboard + sales overview (gl_sales analytics)
- `src/goldline-analytics.ts` (server-only): `getGoldlineAnalytics(companyId)` derives store + SKU rollups and a headline summary from `gl_sales`, joined to `gl_stores` for names. Company-scoped on every read (service-role bypasses RLS, so `company_id` is the fence) and paginated via `fetchAllRows`; JS aggregation at v1 scale (RPC/view is the later optimization).
- `app/stores/page.tsx` + `components/analyst/goldline-stores-view.tsx` (P4): per-store leaderboard — units / gross / net / SKU count — searchable, sortable, paginated, with summary stat cards. Empty-state prompts a CSV upload.
- `app/overview/page.tsx` (P3): server-rendered sales summary (gross / units / net / stores-selling) + Top stores and Top SKUs bar lists. Empty-state when there are no sales yet.
- Both pages scoped by `getDataContext` and surfaced in the non-Zoomy nav (Overview · Uploads · Stores); they're new routes, not under the Zoomy guard. Zoomy has no `gl_*` data so they render empty there (and its nav doesn't link them).
- Staging seeded with a **catalog only** (5 `gl_stores`, 6 `gl_products` with the item_code↔sku_code crosswalk); `gl_sales`/`gl_inventory` intentionally left empty for manual CSV/PDF upload testing. typecheck + full suite (1840) + pagination guard pass.

## 2026-10-05 — Goldline P0: tenant guard on Zoomy-only routes (data-isolation fence)
- **Security fence before Goldline go-live.** The legacy Overview/Health/Inventory/Sales/… pages read Zoomy data with no company dimension, so a non-Zoomy viewer would have seen Zoomy data by URL. Added `requireZoomyData()` (`src/active-context.ts`) + a pure, unit-tested `shouldRedirectFromZoomy` (`src/company-nav.ts`, +3 tests): a Goldline user or the data-blind Coop Admin is redirected to `/uploads`; signed-out and local dev-auth bypass are a no-op.
- Applied as a transparent **section guard layout** per Zoomy-only section (`app/{health,inventory,offline-sales,customers,reports,traffic,repricer,settings,lazada,crm}/layout.tsx`) plus the root overview (`app/page.tsx`) — one choke point per section, so future sub-pages are auto-guarded. `/uploads`, `/signin`, `/dev` are intentionally unguarded.
- Ask Coop fenced to Zoomy too: `/api/chat` returns 403 for a non-Zoomy context, and the shell hides the “Ask coop” pill for non-Zoomy companies.
- Zoomy is unaffected (guard no-ops for `companyId === 'zoomy'`). typecheck + tests + pagination guard pass; runtime pending the Staging deploy.
- **Regression review (code-reviewer agent) + fixes**: (CRITICAL) the root layout fetched `getDigests()` for every authed user and serialized Zoomy data into the RSC payload on every route above the guards — now gated so Zoomy digests load only for a Zoomy viewer (dev-auth bypass + legacy no-membership staff stay Zoomy; a resolved Goldline/Coop-Admin gets none, which also hides the period switcher). (HIGH) the new `getActiveContext` import had broken `test/chat-route.test.ts` at import → mocked it, suite green again. (MED) the chat guard is skipped under dev-auth bypass so the "bypass never calls `auth()`" invariant holds. (MED) the shell now treats a data-blind Coop Admin (`companyId` null) as non-Zoomy — reusing the tested `shouldRedirectFromZoomy` as the single source of truth — so a non-Zoomy viewer's nav reduces to Uploads only (no Zoomy tabs / Ask Coop pill) and the pill/label are correct. Removed the now-redundant `showUploadsFor`.

## 2026-10-05 — Goldline P0: company switcher + cookie-based active company + Uploads nav
- `src/active-context.ts`: `getActiveContext` now falls back to an `active_company` cookie when no explicit company is requested (still re-validated against real memberships by `resolveActive`, so a cookie can never grant access). Adds `getNavContext()` — the active company, role, and switchable companies (names fetched only when a switcher would actually render) for the app shell.
- `src/company.ts`: `fetchCompanies(ids)` — edge-safe PostgREST name lookup for the switcher, fail-soft `[]`.
- `app/actions/company.ts` (`setActiveCompany`) + `components/analyst/company-switcher.tsx`: the top-bar tenant switcher writes the cookie via a server action then refreshes; only rendered when the user belongs to >1 company.
- `components/analyst/dashboard-shell.tsx` + `app/layout.tsx`: the shell takes a `nav` prop and shows the switcher (>1 company) plus an **Uploads** tab for non-Zoomy companies. **Zoomy's single-tenant path is unchanged** — no `nav`/one company means no switcher and the exact legacy tabs. Deeper per-company nav reduction waits on the existing pages being company-scoped (next slice).
- **Regression review (code-reviewer agent) + fixes**: both critical invariants held (Zoomy single-tenant nav unchanged; the cookie can't grant cross-tenant access — it's re-validated against memberships). Fixes: (1) the old static "Zoomy" header pill is replaced by the real switcher when >1 company, else a pill showing the active company's name (so it never double-renders or mislabels once multi-tenant) — `getNavContext` now always resolves names since the pill always shows one; (2) `setActiveCompany` cookie is `secure` in production; (3) `switchableCompanies` de-duplicates; (4) extracted a pure, unit-tested `showUploadsFor` (`src/company-nav.ts`, +2 tests) to pin the "Zoomy → no Uploads tab" invariant against future drift. Noted/accepted: under `DEV_AUTH_BYPASS` the switcher can't be exercised locally (nav resolves via real `auth()`).
- typecheck + full suite + pagination guard pass; runtime pending the Staging deploy (and a 2nd seeded company to exercise the switcher).

## 2026-10-05 — Goldline P2: Uploads UI (list + review workbench) + commit path
- `app/uploads/page.tsx` + `components/analyst/uploads-view.tsx`: the per-company ingestion inbox — drop a `.csv`/`.pdf` (posts to the upload route scoped by active company), then a searchable / status- & type-filterable / paginated file list with status pills; a sales CSV commits and refreshes, a scanned PDF auto-routes to its review page. Scoped by `getDataContext`; a data-blind Coop Admin / non-member sees a gate, not data.
- `app/uploads/[id]/page.tsx` + `components/analyst/upload-review.tsx`: the review workbench for a scanned page — editable store/period header, a document-confidence bar, and an exception-first rows table (flagged-only ↔ all toggle) with low-confidence rows highlighted and every count editable before commit. A CSV shows a status summary instead.
- `app/uploads/actions.ts` (`commitReview`) + `src/goldline-data.ts` (`getUpload`, `getExtraction`, `commitInventory`): the commit server action re-derives the tenant context, re-checks `canEditData` + store scope, coerces/caps the submitted rows, then upserts `gl_inventory` (idempotent on the natural key) and closes the upload — all three writes company-scoped. `saveExtraction` now stages the full extracted page (header + rows) so review/commit have the store + period.
- **Regression review (code-reviewer agent) + fixes**: (HIGH) `commitReview` now confirms the client-supplied `uploadId` belongs to the acting tenant (`getUpload`) before any write — closes a cross-tenant linkage where a crafted id could stamp one company's `gl_inventory` against another's upload; (MED) raw Postgres error text no longer reaches the browser — the commit action and the upload route's storage/DB 500s log server-side and return a generic message; (MED) period is validated as a real calendar date with `start ≤ end`, not just the YYYY-MM-DD shape; (LOW) committed counts are bounded (non-negative, ≤ 1,000,000) and rejected loudly. Confirmed clean by the reviewer: tenant scoping on all reads, auth gates, the `server-only`→client `import type` boundary (no runtime leak), and pagination.
- Additive, new routes only — no existing page touched; nav wiring + company switcher come with the rescope slice. typecheck + full suite (1837) + pagination guard pass; runtime pending the Staging deploy.

## 2026-10-05 — Goldline P2: archive data layer + upload/extraction route; Staging DB applied
- `src/goldline-data.ts`: server-only writes/reads for the `gl_*` tables (same service-role seam as `src/data.ts`). `createUpload` stores the raw file in the private `goldline-uploads` Storage bucket then opens a `gl_uploads` row; `upsertSales` idempotently upserts parsed POS rows on the natural key; `saveExtraction` stages a Vision page in `gl_extractions`; `listUploads` reads newest-first through the paginator. Every row stamped with the active `company_id`.
- `src/goldline-upload.ts` (+ 7 tests): pure upload gate — only `.csv`/`.pdf`, 25 MB cap, extension authoritative with a MIME-contradiction reject; returns the `gl_uploads` kind.
- `app/api/goldline/upload/route.ts`: the POST endpoint. Scopes by the active company (`getDataContext` + `canEditData` — data-blind Coop Admin and read-only analysts refused), gates the file type first, then CSV → `gl_sales` (needs `period_start`/`period_end`) or PDF → Claude Vision page 1 → `gl_extractions` staged `needs_review`. Fails loud, marking the upload `failed`/`rejected` with a reason.
- **Staging DB applied**: `companies.sql` + `goldline.sql` run on `syxwixxzmytvhwhkwdvw` — `companies` seeded with `zoomy`, 4 `pos_dashboard_users` migrated to Zoomy `company_admin`, all `gl_*` tables + the `company_role` enum present, private `goldline-uploads` Storage bucket created.
- **Regression review (code-reviewer agent) + fixes**: (1) `store_manager` `storeScope` is now enforced on the write path — a new pure `outOfScopeStores` helper (`src/company.ts`, +3 tests) rejects an upload (CSV rows or a scanned form) for any store outside the caller's scope, the intra-tenant fence the DB `company_id` can't see; (2) uploaded filenames are sanitized to a safe basename (`safeObjectName`) before becoming a Storage key, so a crafted name can't escape the `company_id/` prefix; (3) the Vision call carries a 100s per-request timeout under the route's 120s limit so a hung call marks the upload `failed` instead of leaving it `processing`; (4) the extraction response is runtime shape-checked before it reaches the review queue. Accepted/deferred: membership/role is cached in the JWT (re-validated at sign-in, not per request) and the SDK call shape needs the Staging smoke test to confirm end-to-end.
- typecheck + 34 tests + pagination guard pass. Route runtime is pending a Staging smoke test (needs `ANTHROPIC_API_KEY` for the PDF path).

## 2026-10-05 — Goldline P1/P2: POS CSV parser + live Vision extraction wrapper
- `src/goldline-csv.ts`: dependency-free RFC-4180 CSV parser + `parseGoldlinePos` mapping the real Nichido POS columns to `gl_sales`-ready rows — case/space-insensitive headers, thousands separators stripped, blank cells → null (not 0), rows missing store/SKU skipped with a note. 7 tests.
- `src/goldline-extract-run.ts`: server-only live Claude Vision call (`extractInventoryPage`) over the P2 prompt/manifest/schema; reads `ANTHROPIC_API_KEY` from env, returns one parsed page or throws on `{error}` / invalid JSON. `extractionConfigured()` lets the PDF path disable cleanly without a key.
- `src/goldline-extract.ts`: extraction model aligned to the chat's `claude-sonnet-5-5`.
- typecheck + 24 tests + pagination guard pass. The live call is pending a Staging smoke test with the key in env.

## 2026-10-05 — Goldline onboarding P2 (core): template-aware extraction prompt + schema
- `src/goldline-extract.ts`: the pure, template-aware extraction core for the Nichido inventory forms — a per-page item manifest (page 1 enumerated from the verified scan; pages 2–6 pending generation from the blank templates, guarded so a page can't run blind), the fixed system prompt carrying the form-specific guardrails (slot-fill against the manifest, blank ≠ zero, column discipline, no total math, page-match, fail-loud `{error}`), and the JSON output schema (header + one row per item with per-field confidence + `alt`). No network/SDK here, so it unit-tests; the live Claude call + upload route is the next slice, smoke-tested on Staging with `ANTHROPIC_API_KEY` in env.
- `src/goldline-extract.test.ts`: 6 cases over the prompt, manifest, and schema. typecheck + all tests + pagination guard pass.

## 2026-10-05 — Goldline onboarding P1: gl_* data model + tenant scoping seam
- `supabase/goldline.sql`: the `gl_*` tables, modeled on the real Nichido source files — `gl_stores`, `gl_products` (with the `item_code` ↔ `sku_code` crosswalk), `gl_sales` + `gl_inventory` (store × SKU × period, idempotent natural keys + indexes), `gl_uploads`, `gl_extractions` (Claude Vision output staged for review), and per-company `company_digest_archive` / `company_business_health`. RLS on, service-role only; additive, depends on `companies.sql`. Apply on Staging first.
- `src/active-context.ts`: server accessor (`getActiveContext` / `getDataContext`) bridging the session to `resolveActive`, so pages scope by the active company and a data-blind Coop Admin gets no data context.
- `.env.example`: `ANTHROPIC_API_KEY` placeholder (server-only, for Goldline PDF extraction; set in Vercel, never committed). typecheck, tests, and the pagination guard pass.

## 2026-10-05 — Goldline onboarding P0: multi-tenant foundation (data-blind Coop Admin)
- `supabase/companies.sql`: new `companies` + `company_users` tables and a `company_role` enum (coop_admin / company_admin / analyst / store_manager). RLS on with no policies (service-role only) — app-level scoping by the active `company_id` is the primary fence, this RLS is the backstop. Seeds Zoomy as the first company and migrates existing `pos_dashboard_users` to Zoomy members so sign-in can move off `ALLOWED_EMAILS` without locking anyone out. Additive — no existing table touched. Apply on Staging first.
- `src/company.ts`: role/membership types, `resolveActive` (Coop Admin resolves to a cross-tenant, data-blind context), capability helpers (`canEditData` / `canManageTeam` / `isCoopAdmin`), and a fail-soft PostgREST membership fetch (edge-safe, no `server-only`).
- `auth.ts`: sign-in now allows a `company_users` membership in addition to `ALLOWED_EMAILS` (backward-compatible); memberships are attached to the JWT at sign-in and surfaced on the session.
- Tests: `src/company.test.ts` (11 cases) for the scoping + capability logic. typecheck, the new tests, and the pagination guard pass. Not yet applied to Staging; no company switcher or page rescoping yet (next slices).

## 2026-10-02 — Talk to Data: database setup runbook, grid proof; staging applied
- `docs/talk-to-data-db-setup-runbook.md`: step-by-step for the three SQL files, the verify query, the proof, the Vercel env vars, rollback and a symptom table. Staging was applied and verified today (proof ALL PASS, 49 of 49); PROD is next.
- `supabase/coop_chat_readonly_proof_grid.sql`: the read-only proof as a PASS/FAIL result grid, because the Supabase SQL editor hides RAISE NOTICE output. Tested locally (49 of 49, data unchanged).

## 2026-10-02 — Ask Coop: caching audit and a capped live eval harness
- ai-expert caching audit (`knowledge/tasks/2026-10-02-ai-expert-caching-review.md`): the prompt-cache prefix is byte-stable (about 13,300 tokens) and read on every step. In-turn tool results were re-sent at full price: added top-level automatic caching (4th breakpoint) with a request-shape rule and a test. TTL stays 5 minutes (revisit after two weeks of data).
- Data cache keyed by Supabase project; a miss logs the serialized size (2 MiB item limit); `chat_turn` logs a timestamp.
- Live eval harness: dollar budget cap (default $3, stops before the next call), tiers (`smoke` default about 9 cases, `full`, `majority` re-runs only failures), a cheaper grader (thinking `between_tools`/effort low on Sonnet; truncated replies are UNGRADED), cases back to back, planned worst-case cost printed first and refused over the cap. Opus cache-read price corrected.
- Open: the Anthropic account has no credit, so no live chat run yet; the owner should check Console usage by key and set a workspace spend limit.

## 2026-10-02 — Ask Coop: owner-defined dates, test plan, model-free E2E, hardening
- Owner direction: the owner defines the dates and Ask Coop asks when they are missing (THINK-01); live chats carry no digest block or pre-selected week; `get_digest` `recent_weeks`/`weekly_revenue` follows the owner's `from`/`to` (Monday-Sunday weeks, Offline POS for every week, online only where a digest exists, missing weeks listed); several comparable measures over time draw as lines; the answer says which chart it chose and why (VIZ-13) and what it leaves out before any figure (THINK-07); chart first (VIZ-12); a requested pie is a real pie.
- Test plan and audit written (`knowledge/tasks/2026-10-01-talk-to-data-test-plan.md`, `...-f9-f12-audit.md`): 124 requirements traced to tests. 29 golden cases incl. an `ask_first` category; route test (35); reference figures produced from a fixture; `dev.sh` and host-block tests.
- Model-free browser E2E on the local database passed (reports pages, gallery, versions, restore, two-tab race writes one version, owner-only controls, "Reports not set up", real pies). Chat E2E is blocked: the Anthropic account has no credit.
- Fixed: a malformed `/api/chat` body (messages not an array) answered 500, now 400, and a null entry is dropped; the starter chip no longer names a period; stored report specs are validated before they reach the browser; the Reports menu moves focus in, supports arrow keys and returns focus on Escape; reload no longer wipes the chat in dev; a billing failure shows a clear account message.
- Known and open: the skill is at about 4,477 of 4,500 tokens; number check is log-only and can pass a wrong figure that matches an unrelated number (3 `it.fails` document it); design criterion 12 expects a `concentration` insight where the code emits `top_contributor`; the "unanswerable log" is not built.

## 2026-10-01 — Talk to Data: independent-review fixes (blocker, 4 majors, quick wins)
Fixes from the consolidated independent review of `feat/talk-to-data-spikes`. Each fix has a test that fails without it.
- **Owner rule, B1:** `test/chat-live.integration.test.ts` read whatever `SUPABASE_*` env was set (it could have been PROD) and built a second, unguarded service-role client. Deleted: the golden live test supersedes it (all 14 questions are in `golden-cases.ts` with the same ids and wording). One shared guard now: `scripts/local-only.mjs` (`assertLocalSupabase`, `isLocalSupabaseUrl`: only `http(s)://127.0.0.1` or `localhost`, no userinfo; refuses `*.supabase.co`, `127.0.0.1.evil.com`, `[::1]`, backslash and `@` tricks; the error never echoes the URL), re-exported for tests as `test/support/local-only.ts`. Called by `chat-live-golden`, `chat-ro-local`, `chat-digest-local` (a set but non-local `SB_LOCAL_URL` now fails the file instead of skipping), `scripts/chat-eval.mjs`, `scripts/coop-chat-ro-proof.mjs` and `scripts/spikes/readonly-role.mjs`. `test/local-only.test.ts` scans every `test/*.integration.test.ts` and fails when one builds a Supabase client without calling it. `chat-live-skill` and `spikes/strict-tools-thinking.mjs` touch no Supabase (synthetic data, fake executor). `import-spin-leads.mjs` and `export-lead-match-data.mjs` are unchanged: they read `SUPABASE_URL_ARCHIVE` from the environment by design (their docs say `node --env-file=.env.local`), so whichever project that points at is what they read.
- **M1, markdown images (exfiltration):** assistant markdown no longer renders images (`components/analyst/chat-markdown.tsx`: `disallowedElements: ['img']`, links absolute http(s) only, `target=_blank`, `rel=noopener noreferrer nofollow`). Copy still copies the raw text. New small CSP in `security-headers.mjs` (via `next.config.mjs` `headers()`): `img-src 'self' data: blob:`, `object-src 'none'`, `base-uri 'self'`, `frame-ancestors 'none'` and nothing else, so scripts, styles and Google sign-in are untouched. Decision: no remote image host is allowed because the app draws none (no `<img>`, no `next/image`; `session.user.image` is passed to the shell but never rendered; a tripwire test fails if that changes). `script-src`/`default-src` would need nonces and are left for a separate piece of work.
- **M2, report version writes are no longer two non-atomic steps:** the version row is the arbiter. Update/Restore now read the real highest version row, insert version N+1 (the `(report_id, version)` primary key lets exactly one racing writer win; a duplicate key maps to the stale-version error, no retry), then advance `current_version` (and a rename) with `current_version < N+1 and deleted_at is null`. The counter is only a cache: a crash between the steps or a lost response cannot wedge the report, because `getReport`, the actions and the page (`currentVersion` now comes from `latestVersion`) all derive the version from the version rows, and the next write repairs the counter. A failed or lost version insert changes nothing else (no rollback needed). Save: if version 1 cannot be written (or its response is lost) the half-made report is soft-deleted and an error returned. The fake database gained `lt` filters, lost-response injection and a crash case; tests cover 3 concurrent writers, crash after the insert, lost response then retry then reload, restore on a lagging counter and a delete racing an update. Header of `supabase/coop_reports.sql` updated (comment only, no schema change).
- **M3, deadline and cut stream:** `runChatLoop` takes `deadlineMs` (default 50 s, injectable clock): before each model step past the budget it emits "That took longer than I allow. Try a narrower question." and `done`; the route passes what is left of 50 s after its own data loads (`maxDuration` is 60). The drawer appends "The answer was cut off." when a stream closes with neither `done` nor `error`. The stream logic moved out of `coop-chat.tsx` into pure `components/analyst/chat-stream-state.ts` so it is testable.
- **M4, block overwrites:** `placeBlock` replaces a block in an earlier message only when its id belongs to the open dashboard (`held`); after "Clear dashboard" a new `b1` is a new block and the old one stays (end-to-end test over the stream reducer). `dropBlocks` removes an id from the newest message that holds it. New chat now aborts the running stream (`StreamSlot`), and a stale stream winding down can no longer clear the busy flag of its successor.
- **Quick ones:** `runReport` wraps each block in try/catch (a block whose maths throws, e.g. `allocateByWeights` on a negative header total, becomes a "This block could not be calculated." card, never a 500); database error text no longer reaches the UI (`reports-actions.ts`, `reports-data.ts` return short generic lines and log code plus message server-side, never report content); `chatReadClient` and `chatDigestClient` now require `mode` and throw without it (fail closed, no default to the service-role mode).
- **Not done (review minors, deliberately):** guard select allow-list (m1), architecture scanner syntax gaps (m2), injected `remove_block` policy (m3), number-check precision (m4), order-paging duplicates, cache size log, owner re-check on PATCH, `body.messages` 400, localStorage scoping, menu a11y, the duplicated-guard refactor (m5 to m7, simplifications).
- Checked: `npx tsc --noEmit` clean; `npx vitest run` 81 files and 1,553 tests pass, 4 live/local integration files skipped (they need a local stack and an opt-in). Nothing was run against any Supabase project; no browser.

## 2026-10-01 — Ask Coop: block ids, chart-first, real pie (fixes after F8)
- `f08c187`: blocks drawn from digest or product lookups have no re-runnable recipe, so no report records them. The report event used to remove them as "gone"; digest pies vanished. `applyReportEvent` now removes only ids that were in the previous report (`held`).
- `273fdfa`: two unrecorded blocks in one turn both got `b1` (the counter only advanced on `record`), and `placeBlock` replaced one with the other. Unrecorded blocks now get unique `u<time>-<n>` ids (regression test in `chat-render-executors.test.ts`). Chart-first default (VIZ-12): the first `render_table` of a request gets a one-time nudge to draw a chart first (bounded cost: one extra model step). The pie draws as a real pie.
- Known gap found by the review and fixed in the entry above: the same id could still collide across messages after "Clear dashboard".

## 2026-10-01 — Ask Coop: number check, 25-case golden set, evals, seed script, local harness (Talk to Data F11)
- **Number-in-result check** (`src/chat/number-check.ts`, called from the loop): every figure the answer shows is looked for in this turn's tool results, the question, the preamble and the digest block; a figure with no source is logged as a violation. Log-only by design until the false-positive rate is measured: it never changes, delays or blocks an answer, and a failure of the check is swallowed. Known weakness (review m4): it matches any number anywhere in the results, so it can miss a made-up small figure.
- **Golden set:** 25 cases (`test/support/golden-cases.ts`: the 14 F5 questions, lookup, dashboard, multi-turn and negative cases) run offline against a scripted model (`test/chat-golden-offline.test.ts`, `chat-golden-fake`, `chat-multiturn-spec`, `chat-viz-cases`, `chat-injection`), which proves the harness, the allowlist and the mechanical checks, not the model. The multi-turn bundle script must end in the exact expected spec.
- **Live evals** (by hand, never CI, real model calls cost money): `test/chat-live-golden.integration.test.ts` and `scripts/chat-eval.mjs` (3-run majority, pass/fail table by model and by skill step, optional LLM grader). They refuse to run unless the Supabase URL is the local stack. `scripts/local-supabase/seed-bundles.mjs` seeds the bundle fixture into the local database. No live result is claimed in this entry; read the answers before calling a run green (lesson `read-the-live-answers`).
- Decision: injection fixtures obey only tool names outside the allowlist, so that test is true by construction; the allowed in-memory mutators are the open review item m3.

## 2026-10-01 — Ask Coop: get_digest, lookup_product, local Supabase harness (Talk to Data F10)
- `get_digest` (stored weekly digests through a digest-only guarded client: one relation, four columns, never `bundle`; the dashboard's `digest` JSON, masked at the seam) and `lookup_product` (in-memory match over the already loaded data, so no PostgREST filter is ever built from user text). Tool count is now 10 strict tools, still no optionals or unions. A digest-sourced result carries `meta.source = digest`. SQL: `supabase/coop_chat_digest.sql` (definer view for the `ro_role` mode; apply by hand). Later in the same branch (`07789f5`): `get_digest` week-by-week series (`recent_weeks`) for online vs offline charts.
- Local harness `scripts/local-supabase/` (`up.sh`, `dev.sh`, `down.sh`, proxy, seed, README): a throwaway Postgres + PostgREST in Docker on loopback behind a `/rest/v1` proxy that refuses non-loopback hosts. `dev.sh` blanks every Supabase-named env variable and sets `COOP_REQUIRE_LOCAL_DB=1`; `block-remote.cjs` patches fetch, http(s) and socket connects so a hosted host cannot be reached. Rule: lesson `e2e-only-on-local-supabase`.
- Verified offline (tests per tool, guard, relation lists, harness block-list). Browser E2E on the local stack was still pending when this entry was written.

## 2026-10-01 — Coop Reports: saved, versioned dashboards (Talk to Data F9)
- **Server (`5811238`):** `supabase/coop_reports.sql` (`coop_reports`, `coop_report_versions`; RLS on, no policies; applied by hand, not applied to any hosted project) and `src/reports-{types,client,data,actions,run,access,session,suggest}.ts`. Only the recipe is stored (filters plus up to 12 blocks), never data or model prose. Two service-role clients behind a guarded fetch that allows only the two tables and GET/POST/PATCH (no DELETE, no PUT, no rpc, no upsert, no bulk PATCH); access rules live in code (private report of another person is a 404, delete and visibility are owner-only, soft delete). Opening a report re-runs it with zero model calls (`reports-run.ts`); a block whose metric was removed becomes an error card. "Pin dates" resolves the range once into a custom range (at most 400 days). The chat tree cannot import any of it (architecture test), so the model cannot save, restore or delete.
- **UI (`492e946`):** `/reports` gallery, `/reports/[id]` (`?v=N`, read-only banner for old versions, Restore makes a new version), pin, rename, visibility, delete, "Ask Coop about this report", Save / Update bar in the drawer, nav entry, "Reports not set up" state.
- Decision: no RPC or transaction (the write client forbids rpc), so version writes use the primary key as the arbiter (hardened in the review-fixes entry above). Team visibility means everyone who can sign in (set `ALLOWED_EMAILS` for PROD). No `spec_version` migrations exist: a spec with another `spec_version` is refused as a whole.
- Verified offline only (fake in-memory database, one test file per module); browser E2E on the local stack was still pending.

## 2026-10-01 — Ask Coop: follow-ups edit the open dashboard, full-screen drawer (Talk to Data F8)
- The drawer keeps the open dashboard (`ReportSpec`, `coop-report-v1`) and sends it with each request. The server re-validates it (`report-spec.ts`: allowlist, registry enums, 12 blocks, 32 KB, data keys dropped), re-runs it, and edits it through render tools (a block id re-binds that block), `set_report_filters` (one call re-runs every block, atomic), `remove_block`, `set_report_title`. The model never types data or a report id. Chips line shows the filters and block count; "Clear dashboard" clears only the report.
- Live script on the real model: dashboard (4 tiles, chart, table) -> "make the chart a pie" (b5 re-bound in place, mode user) -> "only cats" (one filter call) -> "last month instead" -> "add the top SKUs" (appended b7 to b9) -> "remove the KPI tiles" (gone from spec and screen). Known nit: "add top SKUs" drew two tables.
- DASH-01 gate moved into the loop and made one-shot: the first step that renders before any text gets every render call refused once; after that calls pass. Bounded cost (about one extra step) instead of the earlier repeated refusals (5 to 7 steps, 58 s).
- Fixed: `send` was called inside a `setMessages` updater, so Strict Mode sent each question twice in dev (lesson: no-side-effects-in-state-updaters). A removed block now also leaves the earlier message it was drawn in.
- New: full-screen toggle in the drawer header (md and up; Esc or the button returns; remembered in `coop-chat-wide`). Above about 900 px wide the content keeps a 56rem reading column.

## 2026-10-01 — Ask Coop: stat tiles, charts and tables in answers (Talk to Data F7)
- Chat gains 3 render tools (`render_kpi`, `render_chart`, `render_table`). They take a result id and field names, never values; code builds each block from the stored result and picks the form by data shape (`recommend-view.ts`). Explicit preferences are honored in tiers (as asked / adjusted with a note / substituted with a reason). No dual axis, no axis or color options.
- Colors follow the entity (`entity-colors.ts`); "No tag"/"Other" are neutral. Every chart has a table twin with all rows. New skill topics `viz-forms`, `dashboard-composition` (VIZ/PREF/DASH rules, gear rules tested).
- UI: `chat-blocks.tsx`, `chat-charts.tsx`, blocks interleaved in the assistant message, persisted tolerantly in `coop-chat-v1`. Dev-only preview at `/dev/chat-blocks`.
- Decision: `cat-1..4` palette not yet validated for colorblind safety (design-owner decision open); ships with relief channels (legend, table twin). Per-bar entity colors on single-series bars deferred (needs an optional contract field).
- Checked: full suite pass, tsc clean, preview page in light and dark at 440/360px, and a live run in the drawer with the real model on PROD data (bundle dashboard: 4 tiles, stacked bar with a separate gray untagged bar, table with a total; then "as a pie").
- Live run found and fixed a bug the tests missed: the UI read a pie as rows-as-slices while the server emits categories-as-series, so the pie drew one slice. `pieSlices` now reads the server shape, with a test over real `recommendView` output (lesson: parallel-agents-need-a-shared-fixture-from-real-output).
- Added VIZ-11: a form catalog (job to form, marking what is not drawn yet) from the UX Magazine handbook; THINK-01 now looks the form up before rendering.
- DASH-01 is now a code gate: a render call made before any text this turn is refused once ("write the caveat and headline as text now, then repeat the same render calls"). A prompt rule and a worked example alone never changed the order. Live: caveat and headline now come first. Cost: 5 to 6 model steps (about 28 s) instead of 3 (about 14 s) on a dashboard ask. The first wording of the refusal made the model give up and print a text table, so the message says the call was fine.

---

## 2026-10-01 — Talk to Data: the Ask Coop Data Analyst skill — `feat(chat)`

How Ask Coop thinks, now as runtime product content in its cached prompt
(`src/chat/skills/ask-coop-data-analyst/`): a core "How you think" procedure (understand, check the
data first, get every number from a tool, sanity-check, state the method, present like an analyst,
close the loop), a voice, and four topics (parts and totals, comparing periods, allocated figures
and prices, coverage and data quality). Every rule has a stable id; a gear marks the 18 rules the
app also enforces in code.

- **The guide and the code cannot drift:** tests fail if an id exists on only one side, if a
  placeholder is unfilled, if a number in the text differs from the code constant, if a gear rule has
  no test titled with its id (the gate is shown to fail), or if the skill passes its size budget
  (about 2,400 tokens today, cap 4,500, estimate).
- **Scope decision:** the chart-form and dashboard-layout topics describe things that do not exist
  until the chart tools (F7), so they ship with F7. Today's skill says only what the app can do.
- Replaces the two stopgap guardrail lines from the previous step with rules BI-08 (rank claims
  only about the rows shown) and ANL-04 (no number words).
- **Kept out of the prompt on purpose** (tests guard it): production-derived figures (a prompt gets
  parroted and the data changes), and any promise to "log" or "save" something Coop cannot do.
- Vercel: a real `next build` shows the skill files are traced into the chat route, so no config was
  needed.
- **Live skill evals** (12 cases, real model, synthetic data, mechanical scoring): 11 of 12 pass.
  Reading the failures led to three changes: a narrow question must not get an unrequested comparison
  (THINK-06 and a scorer check), the small-sample rule now says "say small sample before any figure
  and lead with counts" instead of banning a share the owner asked for, and a scorer false negative
  was fixed. The remaining failure was a 4th sentence, so the cap became 4 (a method line and a next
  question already make 3).
- **No regression** on the 14 base questions with the skill loaded (real data, read-only): median
  5.4 s, p95 11.3 s, median cost $0.015 and max $0.033 (estimates); cached prefix 12k to 15k tokens.

---

## 2026-10-01 — Talk to Data: Ask Coop answers from live POS data — `feat(chat)`

The first real answer. A question in the Ask Coop drawer is answered from live offline POS
data through the metrics registry, streamed, with the data check first. Verified in a real
browser against the real (read-only) data: the dog/cat bundle split reproduces the plan's
figures with the caveats first.

- **Data check:** `describe_data` and a short coverage note on every question (today's date
  in Philippine time, the date range, how much is untagged, what is not available), so the
  model learns the limits before it queries. This fixes the wrong-year date seen in the spike.
- **Tool loop** (`src/chat/loop.ts`): a manual, streamed Messages-API loop on Sonnet 5.5 with
  two strict tools, up to 8 steps, the model's thinking blocks passed back unchanged, every
  request through the layer-1 shape check. NDJSON stream; the drawer shows a status line
  ("Looking at bundle sales") while it works.
- **Decision:** where the live-data path is not ready (production before the read-only
  database role is applied, a missing secret, a failed load) the chat **degrades to
  digest-only** (no tools, no POS reads, one `chat_degraded` log line) instead of returning
  503, so today's working digest chat does not go down on staging or PROD. The plan had a hard
  503. Safety is unchanged: no POS data is read without the guarded path.
- A tool that refuses a request (unknown dimension, undeclared measure) now reaches the
  model flagged as an error with the allowed values.
- **Live measurements** (14 questions, real model, effort medium, estimates): median 6.3 s,
  data questions 8.4 s, p95 12.8 s, cost median $0.014 and max $0.044, prompt cache hits on
  every call after the first, 0 guard trips, 0 errors.
- Reading the live answers found three defects, fixed before shipping: a rank claim from a cut
  list ("sold the most units" when only the top 5 by revenue were shown), home-made number
  words ("about half"), and a misleading "34% untagged" caveat on the SKU split (the share now
  counts only orders that have pick detail). Two guardrail lines cover the first two until the
  analyst skill lands.
- The digest stays in the prompt for Shopee, Lazada and Website questions (the pinned legacy
  import remains until `get_digest` exists).
- Known, pre-existing and dev-only: `ask()` calls `send()` inside a React state updater, so
  React Strict Mode sends the first question twice in development. Production runs it once.

---

## 2026-10-01 — Talk to Data: metrics registry, exact bundle allocation and checks — `feat(chat)`

The semantic layer behind Ask Coop: every figure comes from one registry definition computed
by code, never by the model. Nothing user-visible changes yet (`/api/chat` is not rewired;
`describe_data`, the tool schemas and the model loop are the next features).

- **Nine metrics** with declared measures and one-line methods: `offline_revenue`,
  `offline_orders`, `offline_aov`, `top_products`, `payment_mix`, `event_rollup`, `pet_mix`,
  `bundle_sales`, `bundle_picks`. A pure `runMetric(request, data, now)` rejects anything off
  the closed shape (free-form keys, undeclared measures, bad dates) with the allowed values.
- **Decision:** a bundle's pick lines carry ₱0, but peso values per SKU are derivable. Each
  bundle's paid price is split across its picks by list-price weight **on the sale date**
  (`src/pos-price-history.ts`, `src/pos-bundle-compute.ts`), in whole centavos with the
  largest-remainder rule, so SKU totals add back to the paid total exactly (₱0 tolerance).
- Checks and insights are code (`src/chat/checks.ts`, `insights.ts`): reconciles, round
  row count, ₱0 lines, price changes, small sample, untagged share, partial coverage, sudden
  change, mock source. A failed check marks the result unreliable.
- Checked against the real PROD data (read-only, nothing committed): bundle revenue ₱147,300
  (equals the existing `bundleSalesSummary`), named ₱106,950, dog 66.4% of tagged, Buy Any 4
  92.8% of named, 582 picks allocating exactly ₱106,950 against ₱139,360 list value.
- Found in that run: the SKU breakdown covers only ₱106,950 of the ₱147,300, because 68 older
  bundle orders have no pick detail. The result now says so. Also fixed before shipping:
  SKU rows were grouped by name, which would merge two products that share a name.
- Dates are Philippine time, weeks run Monday to Sunday; a range outside the data is valid
  and reports coverage partial or none (a wrong-year range returns "no data in that range").
- SQL: three more dashboard-owned views for the role (`coop_chat_prices`,
  `_price_changes`, `_events`; no cash or staff columns). Still not applied to any hosted
  project. Local proof: 69 checks pass, and all nine metrics return identical results in
  `ro_role` and `guarded_service` mode.

---

## 2026-10-01 — Talk to Data: database read-only role for Ask Coop — `feat(chat)`

Layer 5 of the read-only enforcement: even if every code layer failed, the database
refuses a write. **Nothing is applied to any hosted project yet**: the SQL is applied by
hand (staging first, PROD by the co-worker) and gates the PROD release.

- `supabase/coop_chat_readonly.sql` creates role `coop_chat_ro` (no login) and four
  dashboard-owned definer views (`coop_chat_orders`, `_order_items`, `_products`,
  `_bundles`) with no customer columns, SELECT only. It does not touch any `pos_*` DDL.
- **Decision:** the earlier plan to revoke EXECUTE-from-PUBLIC on every `public` function
  is NOT applied blindly: zoomy-pos owns those functions and may rely on that grant.
  Instead a `db_pre_request` hook makes every request as `coop_chat_ro` run in a read-only
  transaction (a callable write function then fails), and a read-only audit query lists
  what the role can execute. The revoke/grant sweep is a separate optional file that needs
  zoomy-pos sign-off.
- Known limit: the hook stops writes, not reads through a callable read function. Layer 4
  (the HTTP guard) blocks `/rpc` in the app; the sweep closes it in the database.
- `src/chat/read/mint-jwt.ts` mints a 5-minute HS256 token (`node:crypto`, no new
  dependency) from `CHAT_RO_JWT_SECRET`; `ro_role` mode fails closed (503) without it and
  never reads the service-role key. Optional `CHAT_RO_APIKEY` is sent as the `apikey`
  header (untested against the hosted gateway).
- Proved on a throwaway local Supabase in Docker (`scripts/coop-chat-ro-proof.mjs`, 53
  checks, idempotent, refuses non-local URLs), including: a SECURITY DEFINER write
  function was callable by the role until the hook, and fails with "read-only
  transaction" after it; service_role, anon and authenticated are unaffected.
  `test/chat-ro-local.integration.test.ts` (skipped unless pointed at a local stack)
  shows `ro_role` answers equal `guarded_service` answers and no customer value returns.
- Architecture scanner: the `.update(` ban gets one pinned exception for `createHmac().update()`
  in `mint-jwt.ts` only; the same call anywhere else still fails the build.

---

## 2026-10-01 — Talk to Data: read-only foundation for Ask Coop — `feat(chat)`

Ask Coop is being upgraded to answer from live POS data (design:
`../knowledge/architecture/2026-10-01-talk-to-data-design.md`). Before any data tool
exists, this lands the layers that make sure it can only **read**. Nothing changes for
users yet: `/api/chat` is not rewired, and the existing digest chat behaves as before.

- **Decision:** "no write tool exists" is one layer of nine, not the guarantee. The model
  reads text other people wrote (product names, notes), so each layer fails closed with
  its own test. This is a release gate for every Talk to Data deploy.
- `src/chat/tools.ts` frozen tool allowlist, `request-shape.ts` (no web, code or MCP
  tools, no forced tool choice), `audit.ts` (`chat_tool` / `chat_guard_trip` log lines).
- `src/chat/read/`: a typed read client (`select` only), an HTTP guard (GET/HEAD only,
  allowlisted relations, no `select=*`, no customer columns) and a fail-closed read mode
  (production returns 503 unless `CHAT_READ_MODE=ro_role`).
- `src/pos-orders-read.ts`: `readPosOrders(client)` extracted from `src/pos-sales.ts` so
  chat and the pages share one paged read with an **injected** client. Page behaviour is
  unchanged (fixture regression test, 1,352 items across two pages).
- `test/chat-architecture.test.ts` fails the build if chat code imports a write path or
  a full-power client. One documented legacy exception: the route's `getDigests` import,
  removed when the route is rewritten.
- Found while testing: the guard judged the raw path but took the host from the parsed
  URL, so `https://host\@evil/...` slipped past. Fixed by requiring both to agree; tests
  cover it.
- Spike findings behind this: `scripts/spikes/` (strict tools + thinking on Sonnet 5.5,
  and a SELECT-only database role through PostgREST). Layer 5, the database role, is the
  next feature and gates production.

---

## 2026-10-01 — Transactions: Event filter + per-sale event badge/reassign; events-page reassign removed — `feat(events)`

Follow-up to the multi-event feature. Reassigning a sale's event now lives only on
the Transactions tab (not the events page), and transactions can be filtered and
distinguished by event.

- **Event filter** (`transaction-filters.tsx`, `pos-sales-compute.ts`,
  `offline-orders`, orders `page.tsx`): a new `event` URL param (an event_id,
  'untagged', or 'all') applied server-side in `getPosOrdersPage`. The control
  shows only when the current scope has 2+ events, today's live events by default
  or the selected date range's events (`eventFilterScope`); default All.
- **Per-tile event badge** (`order-event-badge.tsx`): each transaction shows which
  event it's in; on a day with 2+ overlapping events the badge doubles as the
  reassign control (move to any overlapping event or Untagged, via
  `reassignOrderEventAction`). `eventsCoveringOrder` enforces the "proper
  conditions" (only interactive when the day is ambiguous).
- **Removed** the per-event "Reassign sales" block and the Untagged bucket from the
  events page (`offline-events.tsx`); correcting a sale's event is Transactions-only now.
- **Note:** a sale's event can now be changed from two surfaces (this badge, and the
  POS edit-sale sheet). It is last-write-wins with no version check, so a POS save
  that lands after a dashboard reassign can revert it, the same pattern as
  `pet_type` / `remarks` edits.

Staging-only. Tests: event filter / scope / covering-order units; full suite green
(362); `tsc` clean.

## 2026-10-01 — Inventory: filters inline, Filters button removed — `refactor(inventory)`

The Filters button and its modal hid Status and Location behind a click. Type
(Freeze-Dried only), Status and Location are now pill rows directly under Line, above
search, so every filter is visible and one tap. Dropped the modal, the "Applied"
chip row and the count badge, since the pills already show what is selected.
Added a "Show out of stock" switch beside search (default on, so nothing changes
until it is turned off). Off hides every product with status Out; turning it off
clears a selected Status: Out pill, and picking that pill turns the switch back on,
so the two can never contradict each other.

## 2026-10-01 — Inventory: Edit stock can set Office as well as Event — `feat(inventory)`

`set_product_stock` was hard-wired to the Event (sellable) pool, so Edit stock could
never correct Office back-stock. The dialog now has an Event / Office toggle (Event
by default), shows each location's count, and `setStockAction` takes a location.
It only sends `p_location` for Office, so the Event path still works against the
old 3-argument function. Office edits need `zoomy-pos/supabase/phase4_set_stock_location_2026-10-01.sql`,
which is written but **not applied** (it drops the 3-argument function, because a
defaulted 4th parameter would make 3-argument calls ambiguous).

## 2026-10-01 — Multi-event: same-day events, ambiguity-safe attribution, reassign control — `feat(events)`

Companion to the POS multi-event feature (`../zoomy-pos/CHANGELOG.md`). Coop can
now schedule overlapping / same-day events, and a sale tagged to the wrong event
can be moved from the dashboard.

- **DB (Staging RPCs)**: `upsert_pos_event` no longer raises on overlapping dates
  (the no-overlap guard is removed); `attribute_untagged_orders_to_event` only
  back-tags a sale on a day covered by exactly one event (ambiguous days are left
  untagged); new `set_pos_order_event(p_order_id, p_event_id)` powers reassign and
  is granted to `service_role` only (off the POS anon key).
- **Attribution** (`pos-sales-compute.ts`): `effectiveEventId` only date-attributes
  an untagged sale on an unambiguous (single-event) day; two or more covering
  events leave it untagged rather than guessing the later-starting one. Added
  `currentEventIds` (pin every live event) and `untaggedOnEventDays` (the Untagged
  bucket source).
- **Events page** (`offline-events`): pins all live events, not just one; a new
  "Untagged sales on event days" bucket and a per-event "Reassign sales" control
  (`event-reassign.tsx`) move an order to another event or untag it, through
  `reassignOrderEventAction`.
- **Form** (`event-form`): the overlap error is now a neutral "runs alongside"
  note and no longer blocks Save.

Staging-only. Tests: new multi-event attribution / pinning / untagged-bucket
units; full suite green (346); `tsc` clean.

## 2026-10-01 — Pagination audit: forecast + Lazada reads no longer truncate at 1000 — `fix(data)`

Workspace-wide audit of every Supabase read across the three repos for the
PostgREST `db-max-rows` (1000) silent-truncation class (the Units=0 bug,
2026-09-27). Ground-truthed against live prod row counts: `pos_stock_movements`
is at 1,596 (1,175 in the 60-day sale window) and `pos_order_items` at 1,352,
so the forecast reads were **already** silently truncating and under-counting
demand. Fixed the high-risk sites by reusing the existing `fetchAllRows`
paginator (`src/pos-fetch-paginate.ts`):

- **`src/pos-forecast-data.ts`** (`saleMovementsCached`) — the sale-ledger read
  that drives every forecast band now pages by `id` instead of a bare
  `.select()`. This was live-broken at 1,175 rows in the window.
- **`src/lazada-data.ts`** (`lazadaItemsCached`) — replaced a deceptive
  `.limit(50000)` that did **not** bound the read (PostgREST returns
  `min(limit, db-max-rows)` = 1000) with real pagination by `order_item_id`,
  keeping `ordered_at`-desc display order and the missing-table fail-soft.
- Sibling fix in the Coop backend (`zoomy-observability/src/observability/stock-check.js`)
  and the POS `stock-digest` edge function: the same sale-ledger read there now
  paginates too, so the low-stock email and morning digest stop forecasting on
  a truncated set.

**Hardening (same pass):** paginated every remaining unbounded list read in
`src/` so none can silently truncate as the data grows — `pos-data.ts`
(products/inventory/bundles/bundle_items), `pos-sales.ts` (name lookups +
`posEventsCached`), `pos-prize-data.ts` (`getOrdersWithPrizes`),
`pos-free-taste-data.ts`, `pos-location-data.ts`, `pos-product-detail.ts`
(per-SKU movements), all three `reprice-data.ts` reads, `data.ts` (digests),
`spin-leads.ts`, and `pos-stock-intake.ts` (name lookup) — each wrapped in
`fetchAllRows` with `.range()` + a stable unique `.order()` by the table PK.

**Regression guard:** added `scripts/check-pagination.mjs` (+ `check:pagination`
npm script and a `src/check-pagination.test.ts` so `vitest run` enforces it). It
fails CI on (A) any literal row limit > 1000 (which does NOT bypass the cap) and
(B) any `.from().select()` with no bound marker (`.range`/`.limit`/`.maybeSingle`/
`.single`/`count`/`head`). Genuinely-bounded reads carry a `// pagination-ok:`
note. Backend (`stock-check.js`) and the POS app got the same treatment + their
own guards. Durable long-term remedy for the ledger reads is still server-side
aggregation (an RPC/view returning per-product sums). Staging only; not promoted
to prod.

## 2026-09-30 — Inventory: right-click a row for the actions menu — `feat(inventory)`

The row actions (Move stock, Edit stock, Rename, Change price, List/Unlist…) sat
behind the ⋯ button in the last column, so editing stock meant scrolling the wide
table sideways first. Right-clicking anywhere on a desktop row now opens the same
`RowMenu` at the cursor (same items, same flip-above/clamp logic; the ⋯ still
works). Decision: reuse the one menu with a point anchor instead of adding a
second menu component, and leave the native browser menu alone on the mobile
cards (no ⋯ scroll problem there).

## 2026-09-30 — Offline Sales: "View all" product & bundle rankings — `feat(offline-sales)`

The overview's **Top products** and **Top bundles** cards stay capped at 5 but
now each carry a **View all** footer link to a new **Product rankings** page
(`/offline-sales/rankings`) — one page, two tabs (Products · Bundles), so both
links deep-link their tab via `?tab=`.

- **Decision — full-page rankings over a taller card.** More room than the card,
  so the list becomes a **sortable-column table** (Products: Product · Units ·
  Bundled · Revenue; Bundles: Bundle · Orders · Revenue). Any column header sorts
  (`aria-sort`, arrow); the **Revenue/Units** + **Top/Bottom** segmented toggles
  from the card carry over and share one sort state with the headers.
- **Controls:** name **search** (case-insensitive, per tab) and a **10 / 25 / 50
  per-page** selector (default 10) on top of numbered pagination.
- **Independent per-tab state** — each tab keeps its own sort, search, and page
  across tab switches (state lifted in `rankings-view.tsx`); only `?tab=` is in
  the URL, for the two deep-links.
- **Product rows link to `/inventory/[sku]`** (keyed by `product_id`); a delisted
  SKU still in historical orders renders as plain text (gated on catalog
  membership) so it never 404s. Bundles have no detail page → static rows.
- Additive and read-only: new `app/offline-sales/rankings/page.tsx` re-derives the
  **full** lists via `topProducts(orders, Infinity)` / `topBundles(orders,
  Infinity)`; the overview cards and `pos_*` schema are untouched. Pure helpers in
  `src/pos-rankings.ts` (`filterByName`, `sortRows`) with unit tests; `leafActive`
  already highlights *Offline Sales* for the new subpath (no nav change needed).

## 2026-09-28 — Event leads: what they bought + follow-up messages — `feat(leads)`

The spin-the-wheel and the POS share no id, so `src/lead-order-match.ts` links
each lead to the order they paid for **by time**. It considers orders within
±5 min on the same day, one order per lead, and settles near-ties with two
checks: the lead's pet species vs the order's dog/cat tag, and prize orders
going to the lead who won that prize. A match is *confident* only when no rival
order came within 2 cost-minutes.

Checked offline on a read-only snapshot of Sep 18–27 (257 leads, 353 orders)
against orders where the cashier typed the pet's name or a prize note: 18 of 19
confident matches were right, while unsure ones were about a coin flip. Result:
166 confident, 60 unsure, 31 with no order nearby. Of the 141 Instagram leads,
89 are confident.

- `/customers/leads` → **Contacts**: a **Bought** column listing every item
  (order time, total and gap on hover), with an *unsure* badge where it's a
  near-tie. An ⓘ beside the header explains the listed, *unsure* and blank
  entries and how a lead is matched.
- `/customers/leads` → **Follow-ups**: for a chosen day (default today, Manila),
  lists who is due the day-1 thank-you and the day-5 website-promo message.
  Messages are filled in from the pet's name and what was bought, with a Copy
  button. Confident matches only. It's a copy-and-paste list; nothing is sent.
- Computed on the fly from `pos_orders` + `spin_wheel_leads`; no new table,
  nothing written. A POS read failure leaves the contact list working.
- `scripts/export-lead-match-data.mjs`: a read-only snapshot for re-checking the
  matcher offline.

## 2026-09-28 — Spin-the-wheel v2: Instagram handles + pets — `feat(leads)`

The Sep 26–27 Modern Market booth changed what the wheel collects: **Contact** is
now an email *or* an Instagram handle, and a **Pet** column was added. Coop now
reads both layouts.

- `supabase/spin_wheel_leads_instagram.sql` (additive only) adds the `instagram`
  and `pet` columns and makes `email` nullable, with a check that every lead has
  an email or a handle. It also adds a unique key on `(instagram, collected_at)`.
  **Run on prod 2026-09-28.**
- `scripts/import-spin-leads.mjs` finds columns by header name instead of
  position, and now only inserts new rows (`ignoreDuplicates`), so re-importing
  a newer export never rewrites older rows. Prod import of the 263-row export:
  150 new (9 email, 141 handle), the 113 Sep 18–20 rows untouched.
- `/customers/leads` and the event card: an Email → Contact column (email or
  `@handle`), a Pet column when there is pet data, and "Copy N emails" copies
  only real emails. In All contacts, a handle-only lead is headed by its handle.

## 2026-09-28 — Shopee and Lazada follow custom dates — `feat(overview)`

**What.** A custom date range now recomputes Shopee and Lazada revenue, orders, AOV and
units from the digest's per-PH-day series (`digest.daily`, stamped by the batch from
Shopee's daily sales table and Lazada's order timestamps; `dailyRangeMetrics` in
`src/custom-range.ts`). A full-period range equals the period view (Sep 21–27: ₱91,156).
Ad spend / ROAS have no daily source, so under custom dates the chart says so instead
of drawing ₱0 bars. Rows archived before the series existed stay "full period only".
Marketplace top products stay full-period (labelled).

---

## 2026-09-28 — Periods show whenever there's sales data; Weekly / Monthly period groups — `fix(periods)`

**What.** A period is only "no data" when it has no sales from any channel (`hasNoSalesData`
in `src/week.ts`). The batch's `degraded` flag means "no PawPal chats scanned", and it was
blanking whole weeks (Sep 21–27) that had full Shopee/Lazada/website data. The home
verdict skips the chat-driven "no data — check the job" headline. The period switcher
groups rows under **Weekly** (≤ 8 days) and **Monthly**, the sub-line shows the length in
days, and the amber dot now means "no sales data". `fmtRange` reads timestamps as PHT
days with an exclusive PHT-midnight end, so Sep 20 16:00Z – Sep 27 16:00Z shows as
**Sep 21 – 27** (older UTC-midnight rows keep their labels). Tests: `test/week.test.ts`.

**Offline follows the period.** Compare Channels' Offline was every POS order to date
(₱214k for Sep 21–27); it is now filtered to the period's window, same as with a custom
range (Sep 21–27 → ₱81,370, the Sep 24–27 event days).

---

## 2026-09-28 — Custom dates within a reporting period on the Sales overview — `feat(overview)`

**What.** A **Custom dates** button beside the reporting-period switcher (Sales overview,
`/?channel=…`, only) narrows the view to PH days inside the selected period, via
`?from=YYYY-MM-DD&to=YYYY-MM-DD`. Days outside the period are disabled in the calendar
(`Calendar` gained optional `min`/`max`; default behaviour unchanged). Switching period
drops the range; the × clears it.

**Decision — only per-order channels follow the range.** The digest archive stores one
row of *whole-period totals*, so a sub-range can only be recomputed where we hold orders:
**Website** from live CRM orders (`getCrmOrders`, now carrying `lineItems`) and **Offline**
from POS orders. **Lazada and Shopee** exist here only as digest totals, so under custom
dates they are left out of the totals and chart (with a note) rather than mixing a
full-period figure into a range total. KPI deltas are hidden (no like-for-like prior for an
arbitrary range); recommended actions are labelled "based on the full period" (they are
written once per digest — recomputing means a new AI run).

**Reconciles with the digest.** `src/custom-range.ts` ports the batch's website formulas
(revenue = Σ `totalPrice`, AOV = revenue ÷ orders, units + top products from line items) and
clamps the range to the period, so selecting the whole period reproduces the digest window.
Checked against live data: full-period recompute matched `digest.comparison.website`
(revenue, orders, units) exactly on all 6 archived periods.

**Next.** Lazada needs the batch to persist per-day order rows; Shopee's Business Insights
exports are whole-window only (only `Order.all`, monthly, has per-order dates).

---

## 2026-09-27 — Fix Units = 0 / phantom "Bundle deals": paginate POS aggregation reads — `fix(offline-sales)`

**Bug.** The event detail (and any line-item aggregate) showed **Units = 0** and booked all
revenue as **"Bundle deals · priced as a set" (Itemized ₱0)** for the newest event, even though
the sales were correctly itemized in the DB. Not a data bug — a **fetch-truncation** bug.
`getPosOrders` (`src/pos-sales.ts`) pulled whole tables in single unbounded `.select()`s to
aggregate in JS; PostgREST silently caps each response at `db.max_rows` (**1000**). With
`pos_order_items` at 1264 rows, the last 264 (the newest sales — the live event's later days)
were dropped, so those orders got `items: []` → `Units = Σ qty = 0`, and `total − Σ line_total`
made every order register as a bundle.

**Fix (Option B).** Added `fetchAllRows(label, makePage)` — pages every bulk read in 1000-row
chunks (`.range(from, to)`), ordered by a unique key (`pos_orders.id`, `pos_order_items.id`,
`product_id`, `bundle_id`) so pages don't overlap/skip, until a short page ends it. Applied to
all four reads in `posOrdersCached` (orders were also nearing the cap at 493 rows). Header
metrics (revenue/orders/pet mix/payment split) were always correct and are unchanged.
Typecheck clean, 292 tests pass.

**TODO (Option A, deferred).** Paging only postpones the ceiling and still transfers all history
per render. Durable fix: move KPI / top-seller / bundle math into Postgres (RPC or SQL view
returning small aggregates) so row caps never apply. Tracked in-code at the `posOrdersCached`
comment (`src/pos-sales.ts`); add a regression test seeding >1000 item rows when picked up.

## 2026-09-27 — v1.4.0: ship to prod (locations, free taste, free item) — `chore(release)`

**Version 1.3.7 → 1.4.0.** Promotes the inventory location UI (Office/Event columns +
Location filter + totals, Move stock, receive-into-Office), Event-based forecast +
low-stock alerts, free taste (log + Sampling panel with undo), and the spin-a-wheel
free item (Prizes panel + Edit-order backfill + "Free item" badge on order tiles). Reads
the prod `pos_*` schema (migrated + verified: existing stock backfilled to Event). No
Coop table altered. Deploy note: prod Vercel is the co-worker's project (redeploy `main`;
confirm `SUPABASE_URL_ARCHIVE` points at prod).

## 2026-09-27 — "Free item won" badge on order tiles — `feat(offline-sales)`

The offline-sales order tiles (`/offline-sales/orders`) now show a "Free item" badge
(Gift icon, amber pill) when the order has a non-voided won free item, so an analyst
can spot prize orders at a glance. New server-only `getOrdersWithPrizes()` (distinct
client_uuids from non-voided `pos_order_prizes`), threaded to the order list. Read-only,
fail-soft. Typecheck clean, 292 tests pass.

## 2026-09-27 — Backfill won free items from the Edit-order modal — `feat(offline-sales)`

The Edit-order modal (offline-sales) now has a "Free items won" section for
backfilling spin-a-wheel prizes onto a past sale: it lists the order's existing
prizes with a remove (x, via void_order_prize) and an add control (add_order_prize).
The prize picker only offers products with Event on-hand and caps the quantity at
what's available, so a backfill deducts Event without going negative and you can't
pick an out-of-stock product. New `getOrderPrizeContext` read + action; reuses the
existing add/void prize actions. Independent of the edit Save. Typecheck clean; 292
tests pass.

## 2026-09-26 — Inventory filters: Line on top, search + Filters modal, applied chips — `feat(inventory)`

Reworked the filter bar so it stops cramming. Line (the primary filter) stays as
quick-tap pills on top. Below it, a full-width search input sits next to a **Filters**
button (with an active-count badge) that opens a modal holding the secondary filters
(Type when Freeze-Dried, Status, Location; live-apply, Reset/Done). Applied secondary
filters render as removable chips on their own line under the search, plus a Clear all,
so it's always clear what's active. Typecheck clean; 292 tests pass.

## 2026-09-26 — Sampling card back to per-product pills (with X undo) — `feat(inventory)`

Reverted the flat individual list (too long/repetitive) back to the compact
per-product pills. Each pill now carries a small X that undoes the product's most
recent free taste behind the same confirmation modal (restores the Event stock).
The data layer tracks each product's newest sample (`lastClientUuid`/`lastQty`) so
the pill can undo it directly. Typecheck clean; 292 tests pass.

## 2026-09-26 — Inventory UX polish: searchable pickers, Move Stock row action, column reorder — `feat(inventory)`

Usability follow-ups on the inventory + giveaway surfaces.

- **Searchable dropdowns.** New reusable `SearchableSelect` combobox (type to
  filter) replaces the long native `<select>` product/order pickers in Move stock,
  Log free taste, and the Prizes backfill (order + product).
- **Per-row "Move Stock".** The row menu's "Add to Office" is now **Move Stock**,
  opening the transfer modal preselected to that product (Office to Event, editable).
  Header "Add stock" is still how stock is received; "Edit stock" and "Undo last
  add" stay.
- **Column order.** Inventory table is now Product, Status, Price, **Office, Event**,
  Trend, This mo, Last mo, 3mo, Lasts, Suggested (Office/Event moved up next to Price).
- **Row menu icons.** Each action gained a leading icon (View detail, Move Stock,
  Edit stock, Undo last add, Rename, Change price, Unlist) so the longer menu scans
  faster.
- **Sampling undo.** Replaced the aggregate chips + wordy toggle with a recent list
  of individual free tastes, each with an X that opens a confirmation modal before
  reverting (restores the Event stock). Typecheck clean; 292 tests pass.

## 2026-09-26 — Per-location inventory view, Event-based forecast, free-taste undo — `feat(inventory)`

Follow-ups from POS feedback. Reads Staging views/RPCs; no prod change.

- **Office vs Event per product.** The inventory table now shows an **Event**
  (sellable) column and an **Office** (back-stock) column, plus a **Location**
  filter (All / In Event / In Office). The main Stock, status, and forecast are
  based on Event on-hand, so Office back-stock never masks a low sellable count.
  The per-row "Add stock" is now explicitly "Add to Office" (copy + optimistic
  update target the Office field); "Edit stock" (set exact) still targets Event.
- **Forecast and low-stock alerts use Event on-hand** (`pos-forecast-data.ts`,
  `pos-inventory-data.ts` read `getLocationStock`; the `stock-alert` edge function
  reads `pos_inventory_event`). Falls back to the global sum when the per-location
  read is empty, so nothing regresses.
- **Revert a free taste.** The Sampling card gains a recent list with an Undo per
  row (`void_free_taste` restores the Event stock) for misclicks.
- Free tastes and prizes remain excluded from sales, units, revenue, and forecast
  velocity (verified). Typecheck clean; 292 dashboard tests pass.

## 2026-09-26 — Free taste: log action + sampling summary — `feat(inventory)`

- **Log a free taste** (`free-taste-button.tsx`): pick a product, packs opened, an
  optional note; `recordFreeTasteAction` → `record_free_taste` RPC deducts the
  Event pool and logs it as sampling (separate from sales). Shows Event on-hand and
  warns when opening against low stock. This is the online / backfill path; the POS
  logs most free tastes live.
- **Sampling summary** on the Inventory (All products) tab: total units and count
  over the last 30 days, an "opened vs low stock" flag, and the top sampled
  products. New `src/pos-free-taste-actions.ts` + `src/pos-free-taste-data.ts`
  (reads `pos_free_tastes`). Mirrors the incumbent modal system; typecheck clean.

## 2026-09-26 — Inventory locations: Move stock + receive into Office — `feat(inventory)`

Surfaces the new Office/Event location split on the Inventory page (Stratpoint /
offline scope). Reads the new Staging views; no prod change. BoxMe online scope is
untouched (still the existing stub).

- **Move stock modal** (`transfer-stock-button.tsx`) transfers a product between
  Office and Event via the `transfer_stock` RPC. Shows on-hand at both locations,
  previews the resulting counts, caps the quantity at the source on-hand (the RPC
  enforces it too), and defaults to the Office to Event direction with a swap.
- **Add stock now picks a destination** (`add-stock-button.tsx`): Office
  back-stock by default, or Event (immediately sellable). Wired through
  `addStockAction(lines, location)`.
- **Toolbar shows Office / Event totals** at a glance.
- New `src/pos-transfer-actions.ts` (transfer server action) and
  `src/pos-location-data.ts` (reads `pos_inventory_by_location`). All new UI
  mirrors the incumbent stock-intake modal system (portal, steppers, footer) per
  the design skills. Typecheck clean.

## 2026-09-26 — v1.3.7: PWA home-screen icon + mobile polish — `fix(pwa,mobile)`

**Version bumped to 1.3.7** (patch; was 1.3.6). Fixes from on-device (iPhone 15)
review of the installed PWA and mobile web.

- **Home-screen icon was a plain white "C" instead of the Coop mark.** `apple-icon`
  and the `/pwa-icon/[size]` route both rendered the brand tile by embedding an SVG
  as an `<img>` data-URI inside `next/og` `ImageResponse` — satori renders those
  unreliably, so the route silently failed and iOS fell back to a generated
  white-tile-with-first-letter icon. Both now draw the tile with **native satori
  elements** (a `#3F6E56` green `<div>` + the cream `#F7F5EF` "c" arc as an inline
  `<svg>`), matching the web favicon (`app/icon.svg`). Verified: `/apple-icon`,
  `/pwa-icon/192`, and `/pwa-icon/512?maskable=1` all return valid PNGs. (iOS caches
  the old icon — users must remove and re-add to Home Screen to see the new one.)
- **Bottom tab bar icons enlarged** on mobile (22px → 26px, labels 10px → 11px) —
  they read as too small on iPhone 15.
- **Offline Sales "Top products" toggles no longer clip off-screen.** The `Panel`
  header now wraps (`flex-wrap`), so the Revenue/Units + Top/Bottom segmented
  controls drop below the title on narrow screens instead of overflowing.
- **Channel-compare metric selector** (6 nowrap metrics) now scrolls horizontally
  on mobile inside an `overflow-x-auto` wrapper with a `min-w` grid, keeping the
  sliding indicator aligned instead of clipping labels / pushing page width.
- **Lazada mobile product card** metric grid goes `grid-cols-2` on phones
  (`min-[420px]:grid-cols-4`) so the four stats aren't cramped.
- **Event-analytics top-sellers toggle row** made `flex-wrap` (defensive).

## 2026-09-26 — v1.3.6: Events search + filters + pagination, clearer status — `feat(events)`

**Version bumped to 1.3.6** (patch; was 1.3.5). The Events page grew long as offline
events accumulated, so it now has a proper browse toolbar and clearer status:

- **Search** across event name, venue, city, and organizer (case-insensitive).
- **When filter** (All / Upcoming / Happening / Done) and **Sort** (Recent / Oldest /
  Top ₱), as segmented pills matching the house style.
- **Pagination** at 6 events per page (client-side — each card computes its own
  analytics, so a server slice would starve them). The live event stays pinned to
  the top of page 1; the result count and an empty "no matches" state round it out.
- **Status badge is now time-derived, not the raw `status` field.** A past bazaar
  read a misleading "Active"; it now reads **"Done" in grey**. States are Happening
  now (green), Upcoming (outlined), and Done (grey).
- New pure helpers `eventTimeState` / `eventMatchesQuery` / `filterAndSortEvents`
  (unit-tested) drive both the filter and the badge.

## 2026-09-26 — v1.3.5: full-width compare-days lines — `feat(offline-sales)`

**Version bumped to 1.3.5** (patch; was 1.3.4). In the "Compare days" chart, a day
whose sales started later or ended earlier drew a shorter line, so days didn't span
the same x-axis. Now every completed day runs edge to edge: flat ₱0 before its first
sale and held flat at the day total after its last. The latest (possibly still
selling) day is deliberately left to end at its real last sale, so it's never
flat-lined into the future. Two regression tests added. `eventDayPacingSeries` only.

## 2026-09-25 — v1.3.4: sticky top bar on scroll — `fix(nav)`

**Version bumped to 1.3.4** (patch; was 1.3.3). The top bar was `relative`, so it
scrolled away while the drawer rail (which is `sticky top-14`) stayed pinned,
leaving the rail floating under an empty gap. Made the header `sticky top-0 z-30`
so it stays pinned flush above the rail on scroll. CSS-only.

## 2026-09-25 — v1.3.3: compare-chart hour fix + Transactions nav tab — `chore(release)`

**Version bumped to 1.3.3** (patch; was 1.3.2). Two changes, promoted
`develop → staging → main`:

- **Fix: compare-days chart was off by one hour.** `eventDayPacingSeries` plotted
  each hour bucket at the hour's *start* while holding the cumulative through the
  hour's *end*, so a 9:37 sale read as "₱1,200 at 9 AM". Points now sit on the
  clock-hour mark they actually represent (cumulative *by* that mark, inclusive), so
  the 9:37 sale correctly reads "₱0 by 9 AM, ₱1,200 by 10 AM"; a day starts from a
  ₱0 baseline and off-hour last sales are rounded up so the day total is never
  dropped. Added a regression test for the off-hour case (the gap that hid this).
- **Feat: Transactions tab in the drawer nav.** New "Transactions" entry under
  Overview (between Offline Sales and Events, `ReceiptText` icon) linking to the
  ALL TRANSACTIONS list at `/offline-sales/orders`. Added to the mobile "More" sheet
  too, and the active-state carve-out so Offline Sales / Transactions / Events don't
  all highlight at once.

## 2026-09-25 — v1.3.2: drop redundant "so far" in compare tooltip — `chore(release)`

**Version bumped to 1.3.2** (patch; was 1.3.1). Follow-up to 1.3.1: the per-day
"Compare days" tooltip dropped the trailing "so far" on each row — the "By 9 AM"
header and the running-total caption already convey it. Wording-only.

## 2026-09-25 — v1.3.1: sales-analytics refinements to prod — `chore(release)`

**Version bumped to 1.3.1** (patch; was 1.3.0). Ships the analytics refinements
below (low-end sort, event Top-seller toggles, clearer compare chart). UI-only, no
schema/data change; promoted `develop → staging → main`. POS stays at 1.2.4.

## 2026-09-25 — Sales analytics: low-end sort, event toggles, clearer compare chart — `feat(offline-sales)`

Three refinements to the offline-sales analytics, driven by owner feedback:

- **Revenue/Units + Top/Bottom on the Events "Top sellers".** The per-event
  analytics (`event-analytics.tsx`) gains the same Revenue/Units metric toggle the
  main "Top products" card already had, plus a new **Top/Bottom** toggle to surface
  the lowest sellers ("kulelat"). The list ranks the full product set and slices the
  top or bottom 5; the header retitles to "Lowest sellers" in Bottom mode.
- **Low-end sort on the main Top products too.** Same Top/Bottom control added to
  the Offline Sales overview card for consistency. The page now passes the full
  ranked product lists (was top-5 only) so the client can show either end. The
  bundle reconciliation footer ("matching Revenue above") shows only in the Top view,
  since it's a whole-of-total note.
- **Clearer "Compare days" chart.** The per-day lines are cumulative running totals,
  but the Y-axis said the ambiguous "Revenue that day". Renamed to **"Cumulative
  revenue"** (matching the Combined chart), the tooltip now reads **"By 9 AM"** with
  **"₱1,200 so far"** per day, and a one-line caption explains the lines are running
  totals from the day's open. No data/logic change, wording only.
- **New shared `SegmentedControl`** (`segmented-control.tsx`) dedupes the pill toggle
  markup now used across both cards.

## 2026-09-24 — v1.3.0: staging bundle to prod (Next 16 · PWA · mobile · perf) — `chore(release)`

**Version bumped to 1.3.0** (was 1.2.6). First *minor* since 1.2.0 — not a
single-feature patch but the whole staging line promoted to prod in one cut-over:
a framework major plus several new capability surfaces. Dashboard-only; **POS
unchanged at 1.2.3**.

**Why a clean minor, and why now.** Prod (`main`) had drifted: our co-worker
merged his Lazada + Customers hub + website-CRM work *straight onto the old
Next-14 `main`* (PRs #65–68) without a version bump, while our entire staging
line moved to Next 16. Rather than backfill a throwaway version for that
out-of-band drop, this release supersedes it — `main` fast-forwards to `staging`,
which already carries his features **re-integrated onto Next 16** (`99fe5c8`), so
the two lines reconcile in one move. `origin/main` is an ancestor of
`origin/staging`, so the promotion is a clean fast-forward — no conflicts.

Rolls up everything since 1.2.6:

- **Next.js 14 → 16 major upgrade** — clears the outstanding critical/high
  advisories; paired with an `npm audit` pass (js-yaml, qs). Validated on staging
  (typecheck clean, build 19/19 pages).
- **PWA** — installable manifest + `next/og` icons, Serwist service worker
  (static-shell precache only).
- **Mobile-responsive overhaul** — responsive app shell (bottom tab bar + "More"
  sheet below `md`), tables→cards for Inventory and CRM, per-page padding/chart-height
  passes (offline-sales, inventory/home, repricer, Business Health phase 1 + 2),
  Ask-coop FAB hidden below `md`, and the mobile treatment of the merged
  Lazada/Customers hub.
- **Performance** — Recharts code-split off four route groups (overview/tabs,
  offline sales, event analytics, Business Health), Newsreader trimmed to weight
  400, digest read cached (`unstable_cache`, revalidate 300), splash once-per-session
  + fast content reveal.
- **Customers hub (reconciled)** — Lazada exports, Spin-the-wheel leads, and the
  website-CRM proxy unified under one Customers tab with real data (no more mock),
  now riding the Next-16 base.

**Prod DB — already in place, nothing applied this release.** The tables the
bundle reads (`lazada_orders` 584 rows, `lazada_uploads` 1, `spin_wheel_leads`
113) were created on prod (`qkxbwzdxhwcbwgriwipi`) during the co-worker's earlier
drop; verified present before cut-over. Website CRM is a live proxy over the CRM
Worker (no table). This promotion is code-only.

**Deploy trigger sits with the co-worker.** The prod Vercel project is his, not
ours — `main` is pushed here, but he owns the deploy and must be looped in given
this is a framework major. Pre-deploy checks on his side: the CRM Worker URL env
var is set (his Lazada/CRM drop already needed it) and `SUPABASE_URL_ARCHIVE`
still points at prod.

---

## 2026-09-21 — Mobile responsive, phase 2 · Business Health — `feat(mobile)`

Closes the health-view items deferred earlier. All `max-md:`-only; desktop
byte-identical.

- **Padding** — the wrapper `px-6` and its coupled `-mx-6` full-bleed sticky header
  now shrink together under `md` (`max-md:px-4` + `max-md:-mx-4 max-md:px-4`), so the
  scroll-condense header stays aligned edge-to-edge.
- **Chart heights** — the two tall charts (QRR-by-month 420px, buyer-mix 320px) now
  size from a CSS container (`h-[420px] max-md:h-[320px]` / `h-[320px] max-md:h-[260px]`
  with `ResponsiveContainer height="100%"`) instead of a fixed prop — the reviewer's
  sanctioned CSS-container approach, no JS width branching. Desktop keeps the exact
  same heights. Other charts (`charts.tsx`, 200–220px) were already width-responsive
  and modest, so left alone.

Verified: `typecheck` clean, build 19/19 pages.

---

## 2026-09-24 — Mobile: optimize the Lazada + Customers features — `feat(mobile)`

Applies the mobile treatment to the coworker's newly-merged features (Lazada exports,
merged Customers/contacts hub, CRM filters). Same additive `max-md:` / `md:hidden`
pattern — desktop byte-identical.

- **Lazada** (`lazada-view.tsx`) — both tables get a `md:hidden` card view (Customers:
  name/phone/city + spend/orders/pay; Orders-by-product: product + orders/buyers/
  items/revenue) beside the `max-md:hidden` desktop table. Page padding + the search
  field tighten under `md` (drop-zone padding preserved).
- **Customers hub** (`contacts-view.tsx`) — the merged contacts table gets a card view
  (headline + reach details + source pills + orders/spend/city/last-seen), padding and
  search responsive.
- **Mobile nav** (`dashboard-shell.tsx`) — dropped the now-redundant `/crm` "Website
  CRM" entry from the More sheet: `/crm` `permanentRedirect`s into the Customers hub,
  which is already a More-sheet item (with the top-bar source switcher for its lists).
- **CRM filters** — the coworker's new status/fulfillment/tier filter bar is already
  `flex flex-wrap`, so it wraps cleanly on mobile; no change needed.

Verified on the merged Next 16 base: typecheck clean, 286 tests, build green (all
`/lazada` + `/customers/*` routes).

---

## 2026-09-24 — Fix: hide Ask-coop FAB on mobile — `fix(mobile)`

The floating "Ask coop" button (`CoopFab`, `fixed bottom-4 left-3`) is designed to
sit in the desktop nav rail's bottom-left corner. On mobile the rail is hidden and
the new bottom tab bar occupies that space, so the FAB landed on top of the "Home"
tab. Added `max-md:hidden` — the header's `AskCoopPill` (top-right) is the mobile
entry point, so the FAB is redundant there. Desktop unchanged.

---

## 2026-09-21 — Perf: code-split Recharts off Business Health — `perf` (closes #64)

The last chart route. `health-view.tsx` had two Recharts charts inline in an
800-line view, with `CHANNEL_ACCENT`/`CHANNELS`/`shortMonth`/`hexToRgb` shared
between the charts and non-chart UI (channel cards, segmented control, cohort
table) — so a clean split needed a neutral shared module first.

- **`health-view-shared.ts`** (Recharts-free) — the four shared constants, so the
  parent imports them without pulling the Recharts chunk.
- **`health-view-chart.tsx`** — `TrendView` (QRR-by-month ComposedChart) moved whole,
  the buyer-mix BarChart extracted from `HeatmapView` as `BuyerMixChart` (takes
  `data`/`rgb`/`accent` — `rgb` also colours the heatmap cells, so it stays computed
  in the parent), plus the chart-only `TrendTooltip`/`TrendLegend`/`niceScale`/
  `MixTooltip`. Both lazy-loaded via `next/dynamic` (`ssr:false`, height-matched
  skeletons matching the earlier `max-md:` chart heights).
- Parent drops its `recharts` import entirely; verified no static `recharts`
  reference remains in the `/health` chunks (`ComposedChart` now only in async chunks).

Verified: typecheck clean, 201 tests, build green, `/health` 307s (protected) and
`/signin` renders.

**Recharts code-split complete — all 10 chart routes done.** Every route that renders
a chart now loads Recharts (~110 kB gz) as an async chunk after first paint; the
chart routes dropped ~110–117 kB of initial JS each (e.g. `/inventory` 302→185,
`/` 252→135, `/offline-sales` 247→136, `/offline-sales/events` 253→138).

---

## 2026-09-21 — Next.js 14 → 16 upgrade (security) — `chore(deps)` (issue #63)

Upgrades Next.js **14.2.35 → 16.3.5**, clearing the critical + high npm-audit
advisories that were pinned to Next 14 and its bundled postcss (RCE via image
optimizer, RSC DoS, middleware/rewrite SSRF & cache poisoning, postcss XSS). Stays
on **React 18.3** — Next 16 supports React 18.2+, so no React 19 migration needed;
`next-auth@5-beta` and `@serwist/next` both already allow Next 16.

Migration performed:
- **Async request APIs** — ran `@next/codemod next-async-request-api`. `params` /
  `searchParams` are now `Promise`s, awaited at the top of the 8 page files + the
  `pwa-icon` route handler. Logic otherwise unchanged.
- **`revalidateTag`** — Next 16 requires a cacheLife profile as the 2nd arg. Migrated
  the ~25 on-demand invalidation calls in the POS Server Actions to
  `revalidateTag(tag, 'max')` (the documented drop-in; preserves the existing
  `unstable_cache` tag behavior with SWR). They still pair with `revalidatePath` for
  the immediately-viewed routes, so read-your-writes is intact. (`unstable_cache`
  remains supported in 16, now deprecated.)
- **Builder** — Next 16 defaults to Turbopack, which Serwist's webpack-based SW
  injection doesn't support yet, so `dev`/`build` scripts pin `--webpack`.
- **tsconfig** — Next 16 auto-set `jsx: react-jsx` and added `.next/dev/types` (our
  `app/sw.ts` exclusion preserved).

Verified: `typecheck` clean, **201 tests pass**, production build green (all routes),
service worker still generated + served, `/signin` renders, protected routes 307 to
sign-in, manifest/icons public.

**Remaining / follow-ups:** audit now shows 2 high, both `browserslist` (build-time,
transitive via `@serwist/next`; exploit needs an untrusted `browserslist-stats.json`
we don't use — negligible; only "fix" is a Serwist downgrade). The `middleware` file
convention is deprecated in 16 in favor of `proxy` (still functional; codemod exists)
— left as a separate follow-up. **Staging only — needs sign-off + a full manual pass
before prod given it's a major framework bump.**

---

## 2026-09-21 — Perf: code-split Recharts off Event analytics — `perf`

`event-analytics.tsx` (route `/offline-sales/events`) imported Recharts directly for
its two charts (the cumulative-revenue AreaChart + the multi-day pacing LineChart).
Moved both — and the chart-only helpers (`pesoTick`, `axisLabelStyle`, `todLabel`,
`dayLineStyle`, `DAY_COLORS`, `chartConfig`) — into a new `event-analytics-chart.tsx`
exposing one `EventRevenueChart` (it internally switches AreaChart ⇄ pacing on
compare mode), lazy-loaded via `next/dynamic`. `dayShort` was duplicated (the parent
still uses it for the day toggle) so the parent never statically imports the Recharts
module.

- **`/offline-sales/events`: 253 kB → 138 kB** First Load JS (−115). Typecheck clean.

Recharts split now covers **9 of 10 chart routes**. Only `/health` remains (issue #64)
— its two charts are inline in an 800-line view and share `CHANNEL_ACCENT`/`CHANNELS`
with non-chart code, so it needs a small neutral shared-constants module first.

---

## 2026-09-21 — Perf: code-split Recharts off Offline Sales — `perf`

Continues the Recharts split. `offline-sales.tsx` imported Recharts directly for its
one chart (`MethodStackChart`). Moved that chart + its tooltip into a new
`offline-sales-chart.tsx` and lazy-load it via `next/dynamic` (`ssr:false`, skeleton).

- **`/offline-sales`: 247 kB → 136 kB** First Load JS (−111). Typecheck clean, build 19/19.

**Remaining (tracked, not rushed):** `/offline-sales/events` (253 kB) and `/health`
(227 kB) still import Recharts directly, but their charts are entangled with shared
local helpers (`dayShort` is used by non-chart code; `pesoTick`/`axisLabelStyle` feed
two charts; health's charts are inline in an 800-line render). A clean split means
relocating those helpers across the recharts/non-recharts boundary — deferred to its
own pass to avoid a rushed regression. Seams documented in the tracking issue.

Total Recharts split so far: **8 of 10 chart routes** de-Recharted (all tab/overview
routes + Offline Sales), ~−110 kB First Load JS each.

---

## 2026-09-21 — Perf: code-split Recharts off tab/overview routes — `perf`

Measured with the build's First-Load-JS table + chunk inspection: Recharts is a
single **383 kB (uncompressed, ~110 kB gz) chunk** that rode in the initial JS of
~10 routes (`repricer` 106 kB / `inventory/[sku]` 113 kB have no charts, confirming
Recharts was the delta). Root cause: `tabs.tsx` and `sections.tsx` statically import
`./charts` (Recharts), and every Tab/overview route renders them.

- New `components/analyst/charts-lazy.tsx` re-exports the four charts via
  `next/dynamic` (`ssr: false`, height-matched skeleton → no CLS). `tabs.tsx` and
  `sections.tsx` now import from it, so the whole Recharts graph moves to an async
  chunk fetched after first paint.

**Measured First Load JS drop (~−117 kB each):**

| Route | Before | After |
|---|---:|---:|
| `/` | 252 kB | 135 kB |
| `/crm` `/customers` `/settings` `/traffic` | 247–248 kB | 131 kB |
| `/inventory` | 302 kB | 185 kB |
| `/offline-sales/orders` | 301 kB | 184 kB |

Typecheck clean, build 19/19. `/health`, `/offline-sales`, `/offline-sales/events`
still import Recharts directly and are handled next.

---

## 2026-09-21 — Perf: trim Newsreader font weights — `perf`

`Newsreader` (`--font-serif`) was loaded at 4 weights (300/400/500/600) with both
normal and italic. Audit found every `font-serif` usage is `font-normal` (400) and
there is **no serif italic** anywhere (body italics are Inter). Trimmed to
`weight: ['400'], style: ['normal']` in `layout.tsx` — drops ~6 unused self-hosted
woff2 files from the load. Typecheck clean, build 19/19. (The pre-existing "font
override values for Newsreader" next/font warning is unrelated — it's on HEAD too.)

**Deferred — Recharts code-split (measure first):** Recharts (~100 kB+) rides in the
initial JS of chart routes (inventory 302, offline-sales/orders 301, events 266,
health 226 kB). A real split means `next/dynamic` around the chart subtrees in
`charts.tsx`/`health-view`/`offline-sales`/`event-analytics` with SSR skeletons — a
genuine refactor with an LCP tradeoff (charts pop in post-hydration). Worth doing,
but behind a `@next/bundle-analyzer` measurement to size the win and design the
skeletons; not rushed in here. The Serwist SW already precaches these chunks for
repeat visits.

---

## 2026-09-21 — Perf: cache the digest read (TTFB) — `perf`

`getDigests()` (`src/data.ts`) — read by the shell on **every** route — was
`noStore()`, so each page view paid a Supabase round-trip before the layout could
render. The digest archive is written weekly by the batch job (no in-app mutation),
so the per-request freshness wasn't worth the latency.

- Wrapped the Supabase read in `unstable_cache` (`revalidate: 300`, tag
  `digest-archive`); React `cache()` still de-dupes within a request. The shell now
  hits the network at most once per ~5 min instead of every request → lower TTFB on
  all routes. Masked rows only (no unmasked PII cached).
- A newly generated digest appears within 5 min; for instant, the batch job can
  `revalidateTag('digest-archive')` (noted in code for a future cross-repo hook).

Typecheck clean, build 19/19.

---

## 2026-09-21 — Perf: intro splash no longer blocks load — `perf`

Biggest perceived-load win. The intro splash was a fixed ~1.7–2.75s overlay on
**every** full load (hardcoded timers), and `.coop-app-in` held `<main>` at
`opacity: 0` until a **1.55s** animation-delay — so first contentful paint was
gated by animation, not the network.

- **Once per session** — `intro-splash.tsx` now records a `sessionStorage` flag; a
  pre-paint script in `layout.tsx` (beside the theme seed) adds `coop-splash-seen`
  to `<html>` on repeat loads so the overlay is `display:none` before first paint
  (no flash) and unmounts immediately (timers skipped).
- **Faster first show** — on the first load of a session the splash trigger drops
  1700ms → 600ms and the fade 1000ms → 500ms (gone by ~1.1s vs ~2.75s).
- **Content reveal** — `.coop-app-in` delay 1.55s → 0.15s, duration 0.85s → 0.5s, so
  the dashboard paints almost immediately instead of waiting out the splash.
  `prefers-reduced-motion` still disables all of it.

Net: perceived load drops by ~1.5–2s on first visit and the splash is gone entirely
on subsequent in-session loads. Typecheck clean, build 19/19. (TTFB + bundle wins
tracked separately as the next perf tiers.)

---

## 2026-09-21 — Dependency audit — `chore(security)`

Ran `npm audit`. None of the flagged issues came from the new Serwist deps.

- **Fixed (non-breaking, `npm audit fix`)** — `js-yaml` and `qs`, both transitive
  under the `shadcn` CLI (`cosmiconfig`, `@modelcontextprotocol/sdk → express`).
  Build/CLI-time only, not in the app's request path. Only `package-lock.json`
  changed; 9 → 4 advisories. Tests 201 pass, build 19/19.
- **Deferred (breaking)** — the remaining 4 (1 critical + 3 high) are all Next.js
  `14.2.35` and its bundled `postcss`; the only fix path is `next@16` (a major
  upgrade). Pre-existing, unrelated to this work, and several advisories are
  self-hosted-only / Vercel-mitigated. Flagged for a separate, tested upgrade —
  not bundled into the mobile/PWA work.
- Follow-up worth considering: `shadcn` sits in `dependencies` (it's a dev CLI) and
  is the sole source of the js-yaml/qs subtrees — moving it to `devDependencies` (or
  dropping it) would shrink the runtime dep surface.

---

## 2026-09-21 — PWA: service worker (Serwist) — `feat(pwa)`

Adds the offline/app-shell service worker, completing the PWA. Deliberately minimal
and **PII-safe**.

- **`app/sw.ts`** — a Serwist worker that precaches **only** Next's hashed static
  build assets (JS/CSS/fonts/icons — no customer data). **No runtime caching** of
  navigations, `/api`, or Supabase reads: this app is behind Google auth and renders
  PII, so authenticated responses must never touch the cache (leak risk on shared
  devices). Every non-precached request falls through to the network.
- **`next.config.mjs`** — wrapped with `@serwist/next` (`swSrc: app/sw.ts` →
  `public/sw.js`, `cacheOnNavigation: false`, `register: true`, disabled in dev).
  `serwist` + `@serwist/next` added to deps; generated `public/sw.js` is gitignored.
- **`middleware.ts`** — auth matcher also excludes `sw.js` so the worker script is
  publicly fetchable. `app/sw.ts` is excluded from the app `tsconfig` (Serwist bundles
  it; the `webworker` lib would clash with `dom`).

Verified on a production server: `/sw.js` serves as public `application/javascript`
(≈35 KB), the registration is wired into the client bundle (`serviceWorker.register`
→ `/sw.js`), the manifest is public, and protected pages still 307 to `/signin`
(auth intact). With this, Coop is a full PWA: installable, standalone, offline-shell,
and eligible for the automatic install prompt.

---

## 2026-09-21 — PWA: installable (manifest + icons) — `feat(pwa)`

Coop is now installable (Add to Home Screen → standalone window with Coop chrome).
No new dependencies and no binary raster tooling.

- **`app/manifest.ts`** — web manifest (name/short_name, `display: standalone`,
  `start_url`/`scope` `/`, Coop `theme_color`/`background_color`). Next links it
  automatically; inert on desktop.
- **`app/pwa-icon/[size]/route.tsx`** — 192/512 (+ `?maskable=1`) PNG icons rendered
  at request time by `next/og` (ImageResponse) from the existing brand mark
  (`#3F6E56` tile + cream "c"), so no PNG assets or `sharp`/ImageMagick needed.
- **`app/apple-icon.tsx`** — 180×180 iOS home-screen icon (iOS ignores the manifest
  for A2HS), full-bleed tile since iOS rounds corners itself.
- **`middleware.ts`** — the auth matcher now also excludes `manifest.webmanifest`,
  `pwa-icon`, `apple-icon`, `icon.svg`. A manifest that 302s to `/signin` isn't
  installable and browsers fetch icons without credentials; these carry no secrets.
  No app **page** changed protection.

Verified on a production server: `/manifest.webmanifest` serves public JSON and all
four icons return `image/png` (PNG magic `89504e47`, ~2.6–11 KB). Paired with the
phase-1 `viewport`/`themeColor`. **Still to come:** a Serwist service worker for
offline app-shell + the automatic install prompt (separate step — it adds a
dependency + build-config change and needs on-device testing; caching will be
static-shell-only, never the PII/auth data).

---

## 2026-09-21 — Mobile responsive, phase 2 · Offline Sales + padding pass — `feat(mobile)`

The three Offline Sales views (`offline-sales`, `offline-orders`, `offline-events`)
are already grid-based with responsive `md:grid-cols-*` and no tables, so they stack
on mobile as-is; they only needed page padding tightened under `md`. Same `max-md:`
padding applied to `inventory-view` and `home-landing`. All `max-md:`-only → desktop
byte-identical.

- `health-view` padding was left alone on purpose: its wrapper `px-6` is coupled to a
  `-mx-6` full-bleed sticky (scroll-condense) header, so changing one without the
  other would misalign it. Deferred to a dedicated pass.

Verified: `typecheck` clean, build 17/17 pages.

---

## 2026-09-21 — Mobile responsive, phase 2 · Repricer + Sales — `feat(mobile)`

Two more views, both invariance-safe (every change is `max-md:`-only, so ≥ `md`
is byte-identical).

- **Repricer** (`repricer-view.tsx`) — its four dense tables (currently-repriced
  with expandable history, changed, ready-to-reprice, and the history sub-table)
  keep their desktop layout and now scroll cleanly as a unit below `md`
  (`max-md:min-w-[…]` inside the existing `overflow-x-auto` wrappers) instead of
  cramming. Full card transforms were skipped here deliberately — the main table's
  row-expand + inline `InfoTip`s make cards high-effort for a low-traffic review
  page; scroll is the reviewer's sanctioned fallback. Page padding + the `text-[28px]`
  heading also tighten under `md`.
- **Sales / channel compare** (`channel-compare.tsx`) — already structurally mobile
  (no tables; the 2-col layout is `lg:`-gated so it stacks below `lg`; header and
  chips `flex-wrap`). Only the oversized `text-[2.6rem]` hero and page padding
  needed `max-md:` shrinking.

Note: `product-controls.tsx` was **not** touched — `/products` redirects to
`/inventory` and the `ProductControls` component is no longer rendered anywhere
(only referenced in comments), so it's effectively dead code.

Verified: `typecheck` clean, build 17/17 pages.

---

## 2026-09-21 — Mobile responsive, phase 2 · Inventory table — `feat(mobile)`

The inventory table (`components/analyst/inventory-table.tsx`) now has a mobile
card view. Same invariance rule — the desktop `Row`, the `<table>`, and its
`menuFor` state are **untouched**; the only edited line is the scroll wrapper,
which gained `max-md:hidden`.

- **Table → cards** — a new `md:hidden` `RowCard` renders each paged row as a card
  (name/SKU + `⋯` menu on top, status pill + editable price, then a 3-col grid of
  This mo/Last mo/3 mo/Stock/Lasts/Suggested). Reuses the same `RowMenu`, edit,
  add-stock and edit-stock dialogs as the desktop row.
- **Portal safety** — the card list uses its **own** `cardMenuFor` state, not the
  table's `menuFor`. Because `RowMenu` portals to `<body>`, sharing state would let
  the `display:none` breakpoint render a stray menu at (0,0) on the visible side;
  independent state means the hidden side's menu can never open.

Verified: `typecheck` clean, build 17/17 pages.

---

## 2026-09-21 — Mobile responsive, phase 2 · CRM view — `feat(mobile)`

Phase 2 (per-view content density) begins with the freshly-merged Website CRM
page (`components/analyst/crm-view.tsx`). Same invariance rule as phase 1: every
change is additive (`max-md:`/`max-sm:` class or a `md:hidden` sibling), so the
desktop view (≥ `md`) is byte-identical — the four touched classNames only gained
suffixes; nothing was deleted or lowered.

- **Table → cards** — the desktop table is now `max-md:hidden`; below `md` the same
  rows render as scannable cards (one layout per tab: carts, orders, customers)
  with the primary field + status/badge on top, the money figure emphasised, and
  the rest as a compact label/value grid. Reuses the exact same `shown` slice, so
  pagination/search/order match the table.
- **Padding & search** — page padding tightens under `md` (`max-md:p-4`,
  `max-md:space-y-6`); the search field fills the toolbar row on the narrowest
  screens (`max-sm:`) instead of overflowing. The three KPI grids were already
  responsive (`sm:`/`lg:`), so they were left alone.

Verified: `typecheck` clean, build 17/17 pages (`/crm` compiles). Stat grids and
the desktop table unchanged at `md`+.

---

## 2026-09-21 — Mobile responsive, phase 1 (shell) — `feat(mobile)`

First increment of the mobile-responsive pass. **Constraint held throughout: the
desktop view (≥ `md`/768px) must render byte-identically** — so every change is
additive (a `max-md:`/`max-sm:` class, a `md:hidden` sibling, or new state with a
deterministic `false` SSR default). A regression reviewer audited the plan against
the code first; the diff was then audited to confirm no existing desktop-governing
utility was deleted or changed in value.

- **`app/layout.tsx`** — added a `viewport` export (`width=device-width`,
  `initialScale=1`, `viewport-fit=cover`, light/dark `themeColor`). No fixed width
  or `maximum-scale`, so desktop zoom/a11y unchanged; `themeColor`/`viewport-fit`
  are inert on desktop.
- **`components/analyst/dashboard-shell.tsx`** — below `md` the left rail is hidden
  (`max-md:hidden`) and replaced by a **fixed bottom tab bar** (Home · Sales ·
  Inventory · Offline · More) plus a slide-up **"More" sheet** (Business Health,
  Events, Customers, Website CRM, Traffic, Repricer, Settings + account/sign-out).
  Highlight logic reuses `leafActive` so it matches the rail. `<main>` gets `max-md:`
  bottom padding (bar height + safe-area) so content clears the bar; the decorative
  Zoomy brand switcher is `max-sm:hidden` to stop header overflow. Motion per Emil:
  the frequent tab bar only transitions color + press-scale; the occasional sheet
  gets the iOS drawer curve; `motion-reduce` respected.

Verified: `typecheck` clean, 186 tests pass, production build 16/16 pages. Scrolling
scope for Business Health (`#coop-scroll`) unchanged — `<main>` still owns scroll at
all breakpoints. **Deferred to phase 2:** per-view content density (table→card
transforms, chart label density, typography) and the PWA layer (manifest, icons,
service worker).

## 2026-09-24 — All contacts: the three lists merged — `feat(customers)`

`/customers/all` is the hub's new landing view: one row per PERSON across the
website CRM, the booth leads and the Lazada export. First live run — 388 raw
records collapse to **379 people**.

**Why a union-find** (`src/contacts-merge.ts`): the three lists have different
identities. The CRM knows an email, a booth lead knows both, and a Lazada buyer
has **no email at all** — the export never carries one, so a phone number is its
only identity. Matching on email alone would keep every marketplace buyer
permanently separate from their website account. A person is therefore matched
on EITHER key, and a record that bridges two groups (a lead carrying the
website's email and the marketplace's phone) joins them.

Phone matching normalises to the last 10 digits, because the same number arrives
as `09171234567`, `+639171234567`, `639171234567` or `9171234567` depending on
which system typed it.

**Layout choices**, so a merged row is never confusing:
- Source chips (Web / Booth / Lazada) on every row — provenance is visible, not
  inferred. Filtering by list, including "In 2+ lists", uses the same vocabulary.
- Tiles lead with reachability (email / SMS), which is why anyone opens this.
- Contact, email and mobile share one cell: "who is this and how do I reach
  them" is one question.
- Orders and spend are summed across lists, stated in the table footer.

Field precedence follows what each list knows best: the website for names and
tiers, Lazada for the shipping city, any list for contact details.

---

## 2026-09-23 — One Customers hub for every contact list — `feat(customers)`

The three contact lists now live under the **Customers** tab, and the top bar's
reporting-period pill is replaced there by a **source switcher**: Website CRM ·
Event lead contacts · Lazada contacts. A digest week never applied to these —
they are live lists, not a windowed report — so the slot now carries something
that does.

- `/crm` → `/customers/website-crm`, `/lazada` → `/customers/lazada`, both old
  paths kept as permanent redirects so existing links still land.
- **New** `/customers/leads`: every spin-the-wheel lead across events, reusing
  the event page's `LeadCapture` block. With no single event to divide by, its
  "leads per order" stat reads '—'; the per-event slice stays on the event page.
- `/customers` redirects to the CRM, the busiest of the three.
- The nav rail goes back to one **Customers** tab (the separate Website CRM and
  Lazada entries folded in).

**Superseded:** the digest-derived "Customers — who to reach out to" view that
`/customers` used to render. `CustomersTab` is still exported from
`components/analyst/tabs.tsx` if it should come back as a fourth source.

---

## 2026-09-23 — Compact Lazada header — `refactor(lazada)`

The drop zone became an **Import export** button under Refresh, and the amber
PII banner is gone. Both were permanent blocks above the numbers people open the
page to read, for an action taken about once a month. Dropping a file still
works — the whole page is the drop target now, and it outlines while you drag.
The consent wording moved to the button's tooltip, so the reminder still meets
whoever is about to upload.

---

## 2026-09-23 — Lazada customer exports — `feat(lazada)`

The storefront admin's Lazada page moves to Coop, upload and all. Unlike the
CRM (a live proxy over a Worker), this feature **owns data**: `lazada_orders` +
`lazada_uploads` lived in the STOREFRONT Supabase project, which Coop has no
credentials for, so they are created in the shared archive project alongside
`pos_*`. Nothing to migrate — the storefront's prod project never had the table.

- **Transforms ported verbatim** to `src/lazada-export.ts` /
  `-client.ts` (JS → TS, logic untouched) together with their 62 tests, which
  pass unchanged. The rollup stays un-materialised: items collapse by phone at
  read time, as documented in `supabase/lazada_orders.sql`.
- **Upload is a server action** (`src/lazada-actions.ts`). The browser parses the
  `.xlsx` with ExcelJS (dynamically imported, ~900KB off the initial bundle) and
  posts normalised rows; the server upserts on `order_item_id` in chunks of 400,
  so re-uploading the same export — or two overlapping windows — converges
  instead of double-counting. A successful import revalidates the `lazada-orders`
  tag, so the table reflects it immediately.
- `lazada_uploads` is best-effort and optional: the orders are already saved, so
  a missing ledger never reports a good import as failed. It keeps counts only —
  the "13 buyers excluded" figure is knowable at parse time and nowhere else,
  and storing the aggregate keeps the answer without retaining the PII of buyers
  this list will never contact.
- The money columns are typed optional, mirroring the storefront's defensive
  `select *`: an install predating them must still render.

Adds one dependency: `exceljs`.

---

## 2026-09-21 — CRM refresh control, no reporting period — `feat(crm)`

**Refresh beside the title**, with the last read time next to it. The shared
`RefreshControl` gained an optional `beforeRefresh` hook, because the CRM's
readers sit behind a 60s server cache: `router.refresh()` alone would re-render
the same figures while the label reset to "just now" — a refresh that claims to
have worked and did nothing. The button now invalidates the `crm-live` cache tag
(`src/crm-actions.ts`) first, so it genuinely goes back to the Worker. Cache
window and tag moved to `src/crm-cache.ts`, mirroring `pos-cache.ts`.

**The reporting-period pill is hidden on /crm.** The CRM's figures are all-time
or rolling 7-day, read from the live engine; a digest week sitting above them
implied a scope the numbers do not have. Added to the same `showPeriod`
exclusion list as Inventory and Offline Sales.

---

## 2026-09-21 — CRM table filters — `feat(crm)`

Each CRM table gets the filters its storefront-admin counterpart has, so an
admin can reach a subset without scrolling 6 pages: carts by **Progress /
Status / RETURN30**, orders by **Payment / Fulfillment / Reviewed**, customers
by **Tier / Bought**. Filter sets are per-table and survive tab switches; any
change resets to page 1, and a Clear appears only when something is narrowed.

Progress needs Shopify's raw checkout payload, which the reader deliberately
drops at the boundary — so the stage is now derived **server-side** in
`crm-data.ts` and only the label (`Email` / `Shipping` / `Payment`) crosses to
the browser, never the shopper's address. It is also a new table column and CSV
field. As on the storefront, `Shipping` is the furthest step Shopify exposes:
payment-form engagement lives in its secure iframe and is never persisted
unless the payment completes.

---

## 2026-09-21 — Website CRM page (live proxy) — `feat`

New `/crm` tab: website customers, orders and cart recovery, read **live** from the
Zoomy CRM Worker — the same API the storefront admin at
`zoomyforpets.com/admin/crm` reads. Chosen over archiving into Supabase because
the Worker is the system of record (Shopify webhooks land there), so a copy could
disagree with the storefront; `src/crm-data.ts` caches reads for 60s the way
`pos-data.ts` does and fails soft, so an unreachable Worker empties the page
instead of breaking the route.

Two supporting changes in `zoomy-crm`: a **read-only token**
(`CRM_API_READ_TOKEN`) that opens `/api` but not `/admin` — the full token can
start a real customer email batch, which a Vercel app should never hold — and a
new `GET /api/membership-config` serving the Platinum threshold from the Shopify
metafield, so the threshold shown here cannot drift from the storefront's.

Deliberately **read-only**: reminder and win-back sends stay in the storefront
admin. Numbers verified against the storefront admin on the same data (totals,
revenue, tiers and recovery all matched).

---

## 2026-09-21 — v1.2.6: spin-the-wheel leads to prod — `chore(release)`

**Version bumped to 1.2.6** (was 1.2.5). Ships the Lead capture block below, plus
its contacts filters and pagination. The `spin_wheel_leads` table was created on
prod (`qkxbwzdxhwcbwgriwipi`) from `supabase/spin_wheel_leads.sql` and seeded with
the Sep 18–20 export (113 rows, 108 inside the event window) via
`scripts/import-spin-leads.mjs` — additive only, nothing existing touched. No POS
app change; this is dashboard-only.

---

## 2026-09-21 — Contacts filters + pagination — `feat`

The contact list gained a prize filter, a collection-date filter, and the shared
`Pagination` component in place of "Show all N". The copy-emails button follows
the filters, so a segmented follow-up list (one prize, one day) is two clicks and
a copy. Filters scope the table only — the stat tiles and prize bars stay on the
event totals so the summary holds still while the list is sliced.

Lead **analytics** (capture-over-time, per-day capture rate, wheel-fairness check)
were scoped and deliberately deferred — the data supports them, but nothing was
built. Worth noting the one finding from that pass: Sep 19 was the biggest order
day (50 orders) but the worst capture rate (0.64 leads/order vs 0.87 and 0.82),
which reads as the wheel being unmanned at peak.

---

## 2026-09-21 — Spin-the-wheel leads on the event card — `feat`

The storefront's Spin the Wheel booth game (`zoomyforpets.com/admin/spin-wheel`)
collected 113 leads at the Sep 18–20 bazaar. Those now show up in Coop as a
**Lead capture** block inside each event card's analytics on `/offline-sales/events`:
lead count, how many left a mobile number, leads per order, the prize payout
tally, and the contact table (with a copy-all-emails button for follow-up).

**Why it sits on the event card, not its own page.** The leads' collection days
(Sep 18/19/20 — 26/32/50) line up exactly with *The Gourmet Pet Pantry* event, so
they are booth data, not a separate channel. They scope to the same day pills as
the sales blocks, so picking "Sep 19" narrows sales *and* leads together. The five
stray rows in the export (three June/July test entries, two with no event tag)
fall outside every event's dates and are simply never shown.

**Where the data lives.** `spin_wheel_leads` (new table, `supabase/spin_wheel_leads.sql`)
in the shared archive project, read service-role like `pos_*`. The storefront's own
spin-wheel table sits in the **storefront** Supabase project, which Coop has no
credentials for (confirmed 404 against `SUPABASE_URL_ARCHIVE`), so finished events
are imported from the admin's CSV export with `scripts/import-spin-leads.mjs`
(upserts on `email + collected_at`, so re-running an export is a no-op). The CSV
itself is **never committed** — this repo is public and the export is raw contact
data; `.gitignore` blocks it. RLS is on with no policies, so the anon key sees nothing.

PH timestamps in the export have no timezone, so `parsePhTimestamp` pins them to
`+08:00` rather than trusting server-local time — Vercel runs UTC, which would
have slid every evening lead back a day.

---

## 2026-09-18 — v1.2.5: pet-type editing to prod — `chore(release)`

**Version bumped to 1.2.5** (was 1.2.4). Ships the pet-type edit control below, and
the `edit_pos_order` RPC's `pet_type` patch was applied to the Coop prod DB. Paired
with POS 1.2.3.

## 2026-09-18 — Edit an order's pet type from Coop — `feat(orders)`

The offline-orders edit modal gains a Pet type control (Dog / Cat / Both, click the
active chip to clear back to untagged), matching the POS cart chips. It threads
`pet_type` through `editOrderAction` into the shared `edit_pos_order` RPC, which now
patches `pet_type` (same partial-patch pattern as payment method / handle; `''`
clears to untagged). Colors match the Pet mix legend. Paired with the POS-side edit
in `../zoomy-pos`. Verified end-to-end on Staging (set + clear, total preserved).

## 2026-09-18 — v1.2.4: event Top sellers bundle breakdown to prod — `chore(release)`

**Version bumped to 1.2.4** (dashboard only). Promotes the event Top sellers bundle
breakdown + reconciliation below. Presentational only — no schema or data-layer
change, consistent with features-only production promotion (no stock/product sync).

## 2026-09-18 — Event Top sellers: bundle breakdown + reconciliation — `feat(events)`

The per-event **Top sellers** list now mirrors the Offline Sales "Top products"
card. Each product shows a `{n} individual · {n} bundled` breakdown under its name
(individual = total units minus bundle-picked units), so it's clear how many units
moved on their own vs. inside a bundle. Below the list, a **Bundle deals** row
(order count + set price) plus the reconciliation line "Itemized … plus bundles …
matching Revenue above" ties the itemized per-product total back to the event's
Revenue KPI. Purely presentational — reuses the existing `topProducts` (`bundledUnits`
was already computed) and `bundleSalesSummary` helpers, scoped to the event's orders
(and the selected day). No schema or data-layer change.

## 2026-09-17 — v1.2.3: distinct per-day colors to prod — `chore(release)`

**Version bumped to 1.2.3** (dashboard only; POS unchanged at 1.2.2). Ships the
per-day color fix below. Distinct hues for up to 7 days before the earlier-day
palette repeats; latest day always the ochre accent.

## 2026-09-17 — Compare-days chart: distinct color per day — `fix(events)`

Earlier days were all drawn from one gray at different opacities, so a 3-day event
read as basically two colors. Each earlier day now gets its own distinct hue (cool
palette that holds up on light + dark); the latest/live day stays on the ochre accent
and thicker line so "today" still stands out. Legend + tooltip pick up the new colors.

## 2026-09-17 — v1.2.2: ship compare-days event chart to prod — `chore(release)`

**Version bumped to 1.2.2** (was 1.2.0). Promotes the event "Revenue over time"
compare-days overlay (per-day pacing on one hourly-sampled chart) and the low-stock
email STAGING tagging to prod. POS bumped to 1.2.2 in lockstep.

## 2026-09-17 — Compare-days chart: hourly hover points — `fix(events)`

Follow-up to the compare-days overlay. The lines were plotted at each order's exact
minute, so hovering jumped between sparse times (10 AM, then 3 PM) and the tooltip
could only resolve the day that owned that minute. `eventDayPacingSeries` now samples
on an even **hourly grid** across the event window: each hour holds every day's running
total through that hour's end (null outside a day's own selling hours). Hovering now
steps hour by hour and shows every active day's pace at that clock hour. Tests updated.

## 2026-09-17 — Event revenue: compare each day's pace on one chart — `feat(events)`

The event detail "Revenue over time" chart gets a **Combined / Compare days** toggle
(multi-day events only, on "All days"). Combined keeps the familiar single cumulative
line. Compare days overlays one line per event day, each resetting to ₱0 and aligned by
**time of day**, so you can see at a glance whether today is pacing ahead of or behind
the previous days at the same clock time.

- The latest (usually live) day draws in the ochre accent (`--chart-4`); earlier days
  recede into graduated muted gray, oldest faintest. A small legend labels each day and
  marks the latest.
- New pure helpers in `pos-sales-compute.ts`: `manilaMinuteOfDay` (time-of-day in Manila
  minutes) and `eventDayPacingSeries` (per-day intraday cumulative, aligned by time of
  day, voided excluded, each day resetting). Covered by unit tests.
- Single-day events are unchanged; the toggle only appears when two or more days have sales.

## 2026-09-17 — v1.2.0: align with POS prod promotion — `chore(release)`

**Version bumped to 1.2.0** (`package.json`; was 1.1.0) in lockstep with the POS
app, marking the prod cutover of the shared `pos_*` features the dashboard reads
and writes: events/cash/pet-tag, Coop stock intake, stock-forecast config, order
edit/void, and low-stock email alerts. No dashboard code change in this bump; the
schema promotion is driven from `../zoomy-pos/supabase/prod_promotion_2026-09-17.sql`
(prod `qkxbwzdxhwcbwgriwipi`, additive-only, existing sales data untouched). Prod
deploy of `main` is the co-worker's Vercel project.

## 2026-09-16 — Stock Forecast (Phase 4): low-stock email alerts — `feat(alerts)`

The email half of the Stock Forecast. Immediate alerts are **event-driven**; the
daily digest is a scheduled recap. Alert code lives in `zoomy-observability`
(job + Edge Function); this dashboard's role is capturing recipients (below) and
being the deep-link target. Verified end-to-end on Staging (real POS sale ->
email in seconds, to two captured recipients).

- **Immediate alerts are instant, not polled.** A DB trigger on
  `pos_stock_movements` calls a Supabase Edge Function (`stock-alert`) via
  `pg_net` the moment a sale crosses a product into low/out. The function
  recomputes that product's band, dedupes against `pos_stock_alert_log` (fire
  once per crossing, escalate low->out, resolve on recovery), and emails via
  Resend. Trigger is fail-soft + async, so alerting can never block or break a
  POS sale. Resend key is a **function secret**, never in the DB.
- **Daily digest** stays on the GitHub Actions cron (08:00 Manila) as the full
  recap + surge-shortfall summary. The old hourly cron was removed (the trigger
  replaces it).
- **Recipients** = captured dashboard sign-ins (`pos_dashboard_users`) unioned
  with an `EMAIL_TO` fallback. **Environments** emulated with suffixed secrets
  (`*_STAGING` / `*_PRODUCTION`) since native GitHub Environments need a paid
  plan on this private repo; production leg scaffolded but dormant.
- **Verified on Staging:** a live POS sale of Yoghurt Cubes fired the low email,
  then out (escalation) at 0; Cat Grass Cubes fired low then auto-resolved on
  restock. All via the trigger, no manual calls. Poppins email template (system
  fallback in Gmail), no em/en dashes.

## 2026-09-17 — Bundles: create + edit scope from Coop — `feat(inventory)`

Coop could co-edit a bundle's emoji, name, price, and listing, but not its
**scope** (which product lines it covers and the "Buy any N" count), and couldn't
**create** one at all. Both added, reusing the existing `apply_pos_bundle` RPC and a
direct `pos_bundles` update, so **no schema change**.

- **Edit scope** (`setBundleScopeAction`): the scope summary on each Buy-Any-N row
  ("Buy any 3 · Freeze Dried, Meaty Treats, Tasty Treats") is now a click target
  that opens a scope editor, pick count + eligible-line chips. Writes `pick_count` +
  `line_categories`; the POS mirrors it on its next catalog pull.
- **New bundle** (`createBundleAction`): a header button opens a create dialog
  (name, emoji, price, pick count, eligible lines) that mints a bundle_id and calls
  `apply_pos_bundle`. Buy-Any-N only for now (fixed item-list bundles stay POS-built).
- Emoji, name, price, and listing stay inline-editable in the row as before.
- Copy updated to reflect that bundles can now be created in Coop too. tsc clean,
  183 tests green, build compiles, design detector clean.

## 2026-09-17 — Cache the hot pos_* reads (faster navigation) — `perf(pos)`

Navigations felt slow because every page is dynamic and every data reader called
`noStore()`, so each navigation **and every Next link prefetch** re-ran the full
Supabase query set (the `getPosOrders` whale fetches all orders + items + products
+ bundles). The trace was dominated by RSC round-trips waiting on those queries
(and inflated further by a Fast 4G devtools throttle).

- **Short-lived Data Cache with tag invalidation.** The heavy readers
  (`getPosProducts`, `getPosBundles`, `getPosOrders`, `getPosOrdersPage`,
  `getPosEvents`, `getSaleMovements`) are wrapped in `unstable_cache` with a **30 s**
  revalidate and coarse tags (`pos-orders` / `pos-catalog` / `pos-events`), replacing
  `noStore()`. Repeat navigations and prefetches now serve cached data instead of
  re-querying.
- **Writes stay instant.** Every mutation action (`revalidateTag`) busts the
  relevant tag, so a Coop edit shows immediately; POS-originated writes (new sales,
  POS stock/event edits) heal within the 30 s window. New shared config in
  `src/pos-cache.ts`.
- **Not changed on purpose:** `getPosOrders` is *not* bounded to a recent window,
  because YoY / vs-last-year / "all time" need full history. Pages stay
  `force-dynamic` (the data cache is the win); making routes themselves cacheable is
  a possible later step.
- **Infra note (separate):** if the Vercel function region differs from the Supabase
  region, each DB round-trip pays cross-region latency, worth matching them.
- tsc clean, 183 tests, build compiles.

## 2026-09-17 — Fix row ⋯ menu clipping on bottom rows — `fix(inventory)`

The per-row actions menu was absolutely positioned inside the table's
`overflow-x-auto` container (which also clips vertically), so on the last rows it
was cut off at the card's edge. Render it in a **portal with fixed positioning**
anchored to the ⋯ button instead: it escapes the overflow container and **flips
above the button** when there isn't room below. Closes on outside-click, scroll, or
resize. Two-pass measure so it never flashes in the wrong spot. tsc clean, 183 tests.

## 2026-09-17 — Edit stock (set to an exact count) + traceable history — `feat(inventory)`

Add an **Edit stock** action alongside Add stock: set a product's on-hand to an
absolute number, not just add. No schema change (the `set_product_stock` RPC and
`setStockAction` already existed, just unwired from the revamped page).

- **Edit stock** in the row ⋯ menu opens a dialog prefilled with the current count;
  saving writes the exact on-hand via `set_product_stock`, which logs one `recount`
  movement carrying the signed delta (previous vs new).
- **Traceable Stock history.** The detail page's Stock history is now built from the
  movement ledger (adds, reversals, **and edits**), reconstructing the running
  on-hand so an edit reads **"Edited stock  50 → 45  (−5)"** — previous, new, and
  difference — with who and when. `getProductDetail` returns a `history` list; the
  chart's delivery markers now read the same ledger.
- **Audit "who".** `setStockAction` now stamps the signed-in Coop user (like
  add-stock) instead of a constant, so edits are attributable.
- Verified on Staging: a 50 -> 45 edit logged a `recount` of −5 by the actor; ledger
  sum equals on-hand (reconstruction is exact). tsc clean, 183 tests, build + detector clean.

## 2026-09-17 — Forecast cover reads "selling days", not "events" — `fix(inventory)`

PO feedback: "~23 events" in the Lasts column is unintuitive (and "event" collides
with the bazaar `pos_events` concept). Since the unit is really event-*days* (the
Fri/Sat/Sun the store sells), relabel it to **"selling days"** everywhere it means
cover. **Pure wording change, no math or config conversion** (a selling day is an
event-day, so ~23 stays ~23 and stored settings are unchanged).

- Lasts column badge, detail-chart footer, and the settings hints (Target cover,
  Early warning) now say "selling days". Lead time stays plain "days" (real
  calendar lead time). The low-stock email's "event-day sell through" line updated
  to match (`zoomy-observability`).
- **Left alone (correctly):** bazaar "events" wording, the Events page/nav, and
  internal names (`coverEventDays`, `EVENT_WEEKDAYS`) — those mean an actual bazaar.
- The engine stays event-day based (sales cluster on weekends; a per-calendar-day
  rate would be wrong). tsc clean, 183 tests, build compiles.

## 2026-09-17 — vs-last-year as "same month last year" bars — `fix(inventory)`

The vs-last-year overlay was a muted dashed line; the PO mockup wants **grey bars**
("Same month last year") behind each month's bar. Replaced the line with a grey bar
per month (`soldLastYear`), drawn behind this year's solid/dashed bar and a touch
wider so a **hoverable sliver** always peeks out even where they overlap. Hovering
it shows **"JUN last year / 40 pcs sold"**. Added the matching **legend entry**
(shown only when the toggle is on). tsc clean, 183 tests, build + detector clean.

## 2026-09-17 — Product detail chart rebuilt to the PO mockup — `feat(inventory)`

Replaced the single overlaid recharts chart with a bespoke two-panel SVG built to
the PO's mockup (`components/analyst/stock-sales-chart.tsx`). Recharts dropped from
this route (First Load JS 222 kB to 111 kB).

- **Window: last 3 real + next 3 forecast months** (was 6 real + 3). A dotted
  "forecast" divider splits them; the current month is boxed on the axis.
- **Top panel: pieces sold** as bars (solid = real, dashed hollow = forecast) with a
  connecting line (solid then dashed) and value labels (`34`, `~32`). Forecast now
  follows last year's monthly pattern when data exists, else recent pace.
- **Bottom panel: stock on hand** as a blue line + area, with delivery ▲ markers
  (`+qty`, from `receipt` movements), hollow forecast circles, a "last counted ~N
  wks ago" note (from `recount` movements), and a red "runs out" marker.
- **Rich hover tooltips** per element: real/forecast sold, real/projected stock
  points, and deliveries ("Delivery May 20 / 62 pcs arrived").
- **vs last year toggle** overlays last year's sold as a muted comparison line;
  **greyed and non-clickable when the product has no last-year data** (so on Staging,
  which has no 2025 history, it's disabled).
- **"Counts matched the register" footer** derived from `recount` deltas over the
  last 3 months (hidden when the product was never counted).
- Data layer (`pos-product-detail.ts`) reworked for the 3+3 window, per-month
  deliveries, last-year series, and the count-reconciliation facts. Light + dark via
  theme tokens. tsc clean, 183 tests green, build compiles; design detector clean.

## 2026-09-17 — Inventory rows are fully clickable — `feat(inventory)`

The whole product row now opens the detail page (not just the name), with a subtle
hover highlight so it reads as clickable. `onClick` on the `<tr>` routes to
`/inventory/[sku]`; `cursor-pointer` + `hover:bg-muted/50`. The inner controls keep
their own behavior via `stopPropagation` — the name link (still a real anchor for
open-in-new-tab / keyboard), the editable Price, the ⋯ button, and the ⋯ menu.

## 2026-09-17 — Event attribution: persist to DB + overlap UX — `feat(events)`

Follow-ups to the read-time attribution below, so the DB (and the POS app) agree,
and so date clashes are caught earlier and more clearly.

- **Persist the fold-in** (`attribute_untagged_orders_to_event` RPC, mirrored to
  `pos_schema.sql`): saving an event now stamps `event_id` onto untagged sales whose
  Manila date falls in its range, in the DB. **Fills blanks only** (never re-tags a
  POS-stamped sale, never un-stamps), idempotent, SECURITY DEFINER granted to
  `service_role` (Coop-only; the POS never calls it). Wired into `upsertEventAction`
  (best-effort after the event saves) + revalidates `/inventory`. Verified on
  Staging: "Sample Event" attaches 1 then 0 (15 -> 16 tagged). The read-time resolver
  still backs Coop's own views; this makes the stored data match.
- **Overlap handling, upgraded** (was: generic error only on Save):
  - **Names the culprit** — the message now reads *Those dates overlap "Bazaar A"
    (Sep 17 to Sep 18)* instead of a generic line, both live and from the server
    guard (parsed from the RPC's `check_violation`).
  - **Live inline warning** — `overlappingEvent` (same rule as the DB guard) flags a
    clash the moment the dates are entered, shows an amber warning, and disables Save
    before it ever hits the server. Events passed into `EventForm` from the events view.

## 2026-09-17 — Retroactive event attribution (automatic, read-time) — `feat(events)`

Answers "a sale was logged on a normal day; the team later decides that day was
part of an event — does Coop count it?" Now: **yes, automatically.** Before, a
sale's `event_id` was frozen by the POS at checkout and no dashboard path could
change it, so extending an event's dates never reached already-logged sales.

- **Fill-the-blanks resolver** (`pos-sales-compute.ts`): `effectiveEventId` /
  `resolveOrderEvents`. A POS-stamped `event_id` stays **authoritative**; only an
  **untagged** (null) sale is attributed — by its Manila date landing inside a
  dated event's `starts_on..ends_on` (single-bound = that one day, later-starting
  wins on overlap — same rule as `featuredEvent` / the POS's `pickEventForDate`).
  Decisions locked with the PO: automatic (no confirm gate), POS tag wins / dates
  only fill blanks, silent (totals just widen).
- **Read-time only, Coop-side.** Nothing writes `pos_orders.event_id`; the DB row
  and the POS app still show the original stamp. Applied where Coop groups by
  event/venue: the **Events dashboard** (`/offline-sales/events` rollups + per-event
  analytics) and the **Inventory venue filter**. The forecast is unaffected (it
  keys off the Fri/Sat/Sun event-day calendar, not per-order `event_id`). The
  "No venue (walk-in)" bucket shrinks accordingly. **No schema change, no POS change.**
- **Caveat:** cash reconciliation on a multi-day event can look off if opening/
  closing cash was recorded for only some of the days now in range.
- **Verified:** 6 new unit tests (182 total, all green), tsc clean, build compiles.
  On Staging, "Sample Event" (Sep 15-16) picks up 1 previously-untagged sale
  (15 -> 16 orders), confirming the fold-in against real data.

## 2026-09-17 — Numbered pagination + inventory polish — `feat(inventory)`

- **Bundles → its own tab.** It was buried under *Summary* beneath the forecast
  settings, reading as unrelated. Now `All products · Bundles · Summary`, so the
  bundle catalog is a separate concern.
- **Lasts pill no longer wraps.** The cover badge ("~26.4 events") wrapped and
  clipped its background in the narrow column; `whitespace-nowrap` on the badge +
  cell keeps it on one line.
- **Numbered pager `‹ [1] [2] [3] … ›`.** New shared `components/analyst/pagination.tsx`
  — clickable page numbers (jump straight to a page) with `…` ellipses (always
  first/last + current±1) and prev/next arrows disabled at the ends. Works both
  URL-driven (server tables, renders `<Link>`) and client-state-driven (renders
  `<button>`). Keyboard-focusable, `aria-current` on the active page.
  - **Inventory table** now paginates client-side (12/page) with a "Showing X–Y of
    Z" line; page snaps back to 1 on any filter/search/sort change and clamps when
    a filter shrinks the set.
  - **Offline Sales → Orders** retrofitted from arrow-only ("Previous / Next /
    Page X of Y") to the same numbered pager (still `?page=N` server-driven, 10/page).
    Removed the file-local `PageLink` helper.

## 2026-09-17 — Inventory revamp Phase 2b: year-over-year comparison — `feat(inventory)`

Closes the last doable Phase 1 deferral: same-month-last-year context, so a busy
month reads against its own seasonality, not just the trailing three. Pure
frontend + compute, no schema change; both data layers already load full order
history so the baseline is a free lookup.

- **Compute** (`pos-inventory-compute.ts`, +4 tests): `monthKeyOffset` /
  `monthKeyLabel` (YYYY-MM math + a "Sep '25" label), `soldInMonth` (units for one
  arbitrary Manila month, venue-filterable, same counting rules as the 3-month
  rollup), and `yoyDeltaPct` — **null when last year sold zero** so we never show a
  fake "+100% from nothing".
- **Table** (`inventory-table.tsx`): a small ▲/▼ **"…% YoY"** under the *This month*
  number (green up / red down), with a hover title spelling out `vs Sep '25: 38`.
- **Detail** (`/inventory/[sku]`): a **Year-over-year** strip under the KPIs —
  `this month 50 vs Sep '25 38  ▲32%`.
- **Fail-soft / dormant on Staging.** Shown only when a real baseline exists;
  Staging currently has just 2026-09 data (no 2025-09), so it renders nothing until
  12 months accrue — verified against the DB. Active path covered by unit tests.
- **Verified:** typecheck clean, **176 tests** green (+4), build compiles
  `/inventory` (12.7 kB), `/inventory/[sku]` (5.02 kB).

## 2026-09-17 — Inventory revamp Phase 2: forecast overlay + per-row stock — `feat(inventory)`

Closes the two deferrals from Phase 1's ⋯ — the detail chart now looks forward,
and stock is addable/undoable per row without leaving the table. Pure frontend:
no schema change, reusing the existing `add_pos_stock` / `void_last_stock_add`
RPCs (Phase 3) and the movement ledger the chart already reads.

- **Forward forecast on the detail chart** (`pos-product-detail.ts` +
  `product-detail.tsx`): the six real months now extend three months out. Monthly
  **pace** = mean of the months that actually sold (recent burst, not diluted by
  dead months); stock runs down from today's on-hand if nothing is ordered. Drawn
  as **dashed** forecast bars (hollow) + a **dashed projected-stock line**, seeded
  at the last real point so it connects. A red **"Runs out ~<month>"** label
  appears when the projection hits zero.
- **Per-row Add stock + Undo** (`inventory-table.tsx`): the ⋯ menu gains **Add
  stock** (a small qty popover calling `addStockAction([{sku, qty}])`, optimistic
  on-hand bump + `router.refresh()`) and **Undo last add** (`voidLastAddAction`).
  The header **Add stock** action stays for batch adds; this is the single-SKU
  path. Demo-mode guarded, logged to the stock ledger like the header flow.
- **Verified:** typecheck clean, **172 tests** green, production build compiles
  `/inventory` (12.5 kB), `/inventory/[sku]` (4.82 kB).

## 2026-09-17 — Inventory revamp Phase 1: merge Products + Inventory — `feat(inventory)`

Merges the Products and Inventory pages into one, restyled after the PO's mockup.
Plan + 13 locked decisions + a regression review are in the artifact and
`../COOP_INTEGRATION_PLAN.md`. On `feat/inventory-revamp`; Staging-verified data.

- **One page, two tabs.** `/inventory` now hosts **All products** (the merged
  table) and **Summary**. The `Products` nav item is removed and `/products`
  redirects in (D9). No feature is lost.
- **All products table** (`inventory-table.tsx`): Product · Status · editable Price ·
  Trend · This mo / Last mo / 3mo · Stock Qty · Lasts · Suggested · ⋯. **Sortable
  columns**, default **Category** order (Freeze Dried + subcategories first,
  matching the filter pills; uncategorized sorts last — guardrail 4). Line/Status
  filters + search. Catalog edits (rename, reprice, list/unlist) live in a per-row
  **⋯ menu** reusing the existing server actions (D5); price edits log to
  `pos_price_changes` so past sales keep their price (D6).
- **Summary tab** (`inventory-summary.tsx`): status counts, the interactive
  next-event surge planner, stock forecast settings, and bundle controls.
- **Channel + venue.** Stratpoint (Offline) / BoxMe (Online) segment; a **venue
  dropdown** (from `pos_events.venue`) scopes the monthly-sold columns. The
  **Online scope keeps** the existing marketplace analytics and **adds** a BoxMe
  stub (D13). The `channel` param keeps `offline`/`online` as aliases (D12), so the
  low-stock email CTA + Offline Sales "View all" links work with **zero cross-repo
  change** (guardrail 1).
- **Per-product detail** `/inventory/[sku]` (`product-detail.tsx`): KPI cards, a
  six-month **sales + stock chart** (recharts; green bars = units sold, blue line =
  end-of-month Stock Qty reconstructed from the movement ledger), sold-by-month
  table, and stock history.
- **New compute** `src/pos-inventory-compute.ts` (monthly rollup, venue filter,
  category sort — 9 unit tests) + data layers `pos-inventory-data.ts` /
  `pos-product-detail.ts` (fail-soft). Guardrails 2 (nav-chrome exclusion) + 3
  (repoint 15 `revalidatePath('/products')` → `/inventory`) wired. Dead
  `inventory-forecast.tsx` removed.
- **Verified:** typecheck clean, **172 tests** green (+9), production build compiles
  `/inventory` (12.1 kB), `/inventory/[sku]` (4.72 kB), `/products` (redirect);
  monthly-sold numbers reconciled against real Staging orders.
- **Deferred (Phase 2/3):** the forward-looking forecast overlay on the detail
  chart, real BoxMe online stock, last-year comparison, and per-row Add-stock/Undo
  in the ⋯ menu (Add stock stays a header action; Undo lives on the detail history).

## 2026-09-16 — Capture dashboard sign-ins for alert recipients — `feat(auth)`

Supports the low-stock email (in `zoomy-observability`): the alert needs to reach
the people who use Coop, but Google SSO stores no user list (JWT sessions, no DB
adapter). So we now record each sign-in.

- **`auth.ts` `events.signIn`** upserts the signer's email into a new
  `pos_dashboard_users` table (Staging; service-role only; mirrored to
  `../zoomy-pos/supabase/pos_schema.sql`). Fail-soft: a logging hiccup never blocks
  login. Uses a direct PostgREST upsert with the archive service-role key (no
  server-only import, so the edge middleware bundle stays clean). The upsert sends
  only `{email, last_seen}`, so `first_seen` is preserved across logins (verified on
  Staging). The email job unions this list with its `EMAIL_TO` fallback.
- Typecheck + build clean (middleware unaffected).

## 2026-09-16 — Stock Forecast (Phase 3): Add stock + history + undo — `feat(inventory)`

Adds a first-class, traceable way to receive stock into Coop, with a stock-in
history and a one-click undo. Additive schema on Staging (mirrored to
`../zoomy-pos/supabase/pos_schema.sql`, **not on prod**). Landed on `develop`.

- **Schema (Staging):** two new SECURITY DEFINER RPCs — `add_pos_stock(p_lines, p_by)`
  receives several products in **one transaction** (all-or-nothing, Q18), each line a
  `receipt` movement stamped with the signed-in Coop user; `void_last_stock_add(sku,
  p_by)` reverses a product's latest receipt with an **offsetting `add-void` row**
  (history preserved, clamped to what's still on hand — Q20). `receive_lot` untouched;
  advisor shows only the same expected SECURITY DEFINER WARN as the other pos_* RPCs.
- **Add-stock form** (`add-stock-button.tsx`): a button on **both** the Inventory
  forecast and Products. Click **Add product** → a line with its own product picker
  (chosen products drop out of the other lines' menus — no duplicates); qty takes
  numbers-only keyboard input plus −20/−10/−5/−1 / +1/+5/+10/+20 quick-steps.
  **Update** commits the batch all-or-nothing via `addStockAction`.
- **Stock history** (`stock-history.tsx`, Q19): a **global panel** under the forecast
  (recent adds: product · +qty · who · when) and a **per-product drawer** opened by
  clicking any forecast row (that SKU's adds, running total, and **Undo last add** on
  the most recent receipt). Reads `pos_stock_movements` (receipt / add-void); stock-ins
  only.
- **Data layer:** `src/pos-stock-intake.ts` (fail-soft receipts reader + mock) and
  `src/pos-stock-intake-actions.ts` (`addStockAction` all-or-nothing, `voidLastAddAction`;
  actor = signed-in Coop email, revalidates inventory/products/offline-sales).
- **Verified on Staging:** batch add of 2 lines (atomic — a bad SKU rolled the whole
  batch back), the actor recorded on each receipt, void posted the offsetting row and
  restored on-hand, and the history query returns real receipts with names. All test
  artifacts cleaned up. Typecheck clean, **163 tests green**, build compiles `/inventory`
  (7.79 kB) + `/products` (12.6 kB).
- **Deferred:** the low-stock email job (`run-stock-check.mjs` + Resend + cron) is the
  next phase — separate repo (`zoomy-observability`), needs a Resend key + cron config.

## 2026-09-16 — Stock Forecast (Phase 2): configurable + surge planner — `feat(inventory)`

Makes the forecast configurable and adds the next-event surge planner. Additive
schema on Staging (mirrored into `../zoomy-pos/supabase/pos_schema.sql`, **not on
prod**). Landed on `develop`.

- **Schema (Staging):** two new `pos_settings` keys — `stock_forecast_config`
  (threshold, per-SKU `threshold_overrides`, target cover, lead time, early-warning,
  velocity mode, event days) and `next_event_plan` (event-this-weekend, global
  multiplier, per-category + per-product overrides) — each with a SECURITY DEFINER
  upsert RPC (`set_pos_stock_config` / `set_pos_next_event_plan`), same anon-grant
  posture as `set_pos_daily_target`. Advisor: no new findings.
- **Config is live, threshold 10 is now editable.** `src/pos-stock-settings.ts`
  reads both keys **fail-soft to the Phase-1 defaults**; `getStockForecast` feeds
  the config into the compute so bands/reorder honor it. A **Stock forecast
  settings** panel on the Products page (`stock-settings-form.tsx`) edits the global
  threshold + cover/lead/early-warning via `set_pos_stock_config`.
- **Next-event surge planner** on the Offline forecast: an "event this weekend?"
  check (off → forecasts the next weekend) + an expected-volume **× multiplier**,
  and a per-product **Next event · needs** column — the multiplier pre-fills each
  cell, or type a product's absolute expected units (amber = manually set). Shows
  **"N products won't sustain · restock by <date>"**. Recomputed **client-side** for
  instant what-if; each committed change persists via `set_pos_next_event_plan`
  (actor = signed-in Coop email, Q22).
- **Compute** `src/pos-forecast-compute.ts` gains `effectiveThreshold` (per-SKU),
  `effectiveMultiplier` (category vs global), `nextEventDay` (this vs next weekend),
  and `computeSurge`. **8 new unit tests** (overrides, multiplier resolution,
  weekend roll, shortfall/sustain) — **163 tests green**.
- **Verified on Staging:** config + plan with a per-SKU threshold override, category
  multiplier, and per-product absolute all round-trip in the exact parser shape;
  seed defaults restored after. Typecheck clean, production build compiles
  `/inventory` (4.8 kB) + `/products` (11.1 kB).
- **Deferred:** per-product low-threshold override has a UI-less data path for now
  (RPC + compute support it; the global panel covers the main ask). Add-stock form +
  history + email is Phase 3.

## 2026-09-16 — Stock Forecast (Phase 1): Offline scope on `/inventory` — `feat(inventory)`

First slice of the Stock Forecast feature (full plan + 22 PO decisions in
`../COOP_INTEGRATION_PLAN.md` and the plan artifact). **Dashboard-only, no schema
change** — reads existing `pos_*` data. Landed on `develop`.

- **`/inventory` gains an All / Online / Offline channel toggle.** Default landing
  is **All** (Q8); **Online** keeps the existing marketplace/digest `InventoryTab`
  untouched (Q7); **Offline** is the new forecast. `?channel=offline` deep-links
  straight to it (used by the Offline Sales snapshot).
- **Offline stock forecast** (`components/analyst/inventory-forecast.tsx`): per-SKU
  on-hand, **event-aware** sold/day (÷ distinct selling days, not calendar days),
  **event-day** cover, weekend-snapped run-out, suggested reorder + "reorder by",
  and **Healthy / Low / Out** status (Q16 — Critical dropped). Line + (Freeze-Dried)
  subcategory filter pills mirroring the Products page.
- **Pure engine** `src/pos-forecast-compute.ts` (unit-tested, 11 cases) — the same
  module the low-stock email will reuse in Phase 3. Config (threshold 10, 14-day
  cover, 3-day lead, Fri/Sat/Sun) is constants this phase; Phase 2 makes it
  `pos_settings`-backed.
- **Data layer** `src/pos-forecast-data.ts` reads `pos_stock_movements`
  (`reason='sale'`, trailing 60 days) → velocity; **fail-soft** (any read error
  renders an empty state, never 500s); deterministic mock when the Supabase env is
  unset.
- **Offline Sales page**: the low-signal **"Recently synced"** panel is replaced by
  a **Stock snapshot** (most-urgent SKUs, worst-first, + `18 healthy · N low · N out`
  line) with a **View all →** to `/inventory?channel=offline`.
- **Verified on Staging** against real `pos_stock_movements`: the compute reproduces
  a sane mix (2 out · 2 low · 26 healthy of 30), velocity/cover math matches the
  TypeScript exactly. Typecheck clean, **155 tests green**, production build compiles
  `/inventory` (2.6 kB) and `/offline-sales`.
- **Deferred to later phases:** the surge planner + configurable settings (Phase 2),
  Add-stock form + history + low-stock email (Phase 3), real Online inventory +
  prod promotion (Phase 4). Near-expiry stays deferred (Q13).

## 2026-09-15 — Offline Sales: Pet mix + Events — `feat(offline-sales)`

- **Pet mix card on the Offline Sales home.** New card directly below the KPI row
  showing a 4-way split (Dog / Cat / Both / Untagged) with revenue and order count
  per segment, rendered as a revenue-proportional split bar plus a legend. It reads
  from the same range- and payment-method-filtered orders the KPIs use, so it
  reacts to the method toggle client-side. Colors are deliberately distinct from
  the ochre accent and the payment-method hues (dog = blue, cat = purple,
  both = green, untagged = neutral). Empty/all-zero renders a friendly note.
  Reason: the owner wanted to see which pet drives sales at a glance.
- **Events view + scheduler.** New `/offline-sales/events` page (linked from the
  home header) listing `pos_events` with per-event sales rollups (revenue, orders)
  and a cash reconciliation line (opening float + cash sales = expected till;
  over/short once a closed event's counted cash is recorded). Friendly empty state
  when no events exist. `event_id` (null = normal non-event day) and `pet_type`
  were added to the `pos_orders` read/type; new `getPosEvents()` read and `PosEvent`
  type.
- **Coop event scheduling form** (added later 2026-09-15). "New event" +
  per-event "Edit" open an inline form (name, venue, city, organizer, start/end
  dates, opening cash, note; edit adds status + counted-cash), writing through the
  new `upsertEventAction` / `closeEventAction` server actions over the
  `upsert_pos_event` / `close_pos_event` RPCs. This is the primary way Coop
  schedules a bazaar's dates so the POS auto-detects and tags that day's sales.
  Overlapping date ranges are rejected (the RPC's guard; surfaced as a plain
  "those dates overlap another event" message). Date fields: the whole field
  opens the native picker on click (`showPicker`), and the picker icon follows
  dark mode (`color-scheme`) so it isn't black-on-black.
- **Payment filter shows all methods, only enabled ones filter.** The Offline
  Sales payment dropdown now lists every known method: those with sales in range
  ("enabled") at the top and clickable, the rest greyed, unclickable, and tagged
  "No sales", separated by a divider. New pure helper `paymentMethodOptions`
  (enabled-first, canonical order), unit-tested.
- **Sales over time card no longer stretches empty.** The two-column rows
  (Sales/Top, Recent orders/Recently synced) top-align (`items-start`) so a
  shorter card keeps its natural height instead of stretching to match the taller
  column and leaving dead space below.
- **Offline Sales layout: breathing room + 2-column top.** The event spotlight
  (left) and the daily-goal card (right) now sit side by side in a two-column row
  (stacked on mobile). The event card is a proper vertical tile (status icon +
  "All events" on top, event identity anchored at the bottom) so it fills its
  column height cleanly instead of floating centered. The daily-goal card gets the
  same fill-height treatment (header pinned at top, metrics anchored at the bottom)
  so the two tiles read as a balanced pair. Bumped section rhythm
  throughout (page padding, header, KPI/pet/panel gaps) so the increasingly dense
  page reads more comfortably. The per-event analytics panel also got looser
  spacing (section gaps, KPI cards, legends, top-sellers rows, taller trend).
- **Event spotlight on the Offline Sales home.** Replaced the small "Events"
  button with a banner card that shows the event running today ("Happening now"),
  else the next upcoming one, else an empty "No events scheduled" prompt. The
  whole card links to the Events page. New pure helper `featuredEvent(events,
  todayKey)` (current, else nearest upcoming, else null), unit-tested.
- **Events page: live spotlight + per-event analytics.** The event running today
  floats to the top as a "Happening now" spotlight (ring accent, analytics
  expanded). Every other event card is collapsed to its summary + cash line with
  a "Show analytics" toggle. Analytics per event: headline KPIs (revenue, orders,
  units, avg basket), an aesthetic cumulative-revenue trend line (area chart),
  a payment split, the pet mix, and top sellers. New pure helpers
  `paymentBreakdown` and `eventRevenueSeries` (both exclude voided), unit-tested;
  the panel reuses `computeKpis` / `petMix` / `topProducts` scoped to the event.
  The trend chart now has labelled X ("Order time") and Y ("Cumulative revenue",
  with peso ticks) axes. The cash reconciliation block clarifies that card /
  e-wallet sales settle separately and aren't in the till, so "expected in till"
  (opening + cash-method sales) reads distinctly from total revenue.
- **Per-event day granularity.** Multi-day events get a day toggle on their
  analytics (default "All days", then one pill per event day). The selected day
  scopes every metric: KPIs, trend, payment split, pet mix, and top sellers (by
  the order's Manila day). Single-day events show no toggle. New pure helper
  `datesInRange`, unit-tested. The event header total and cash reconciliation
  stay event-level (opening float is one per-event value).
- **Events in the drawer nav.** Added an "Events" tab under the Overview group,
  right below Offline Sales (both the expanded accordion and the collapsed
  flyout). Active detection split so `/offline-sales` and `/offline-sales/events`
  never both highlight: Offline Sales owns its page + non-events subpaths, Events
  owns the events subtree, so the highlight transfers to Events when opened from
  the Offline Sales "Events" button. The Overview group stays active/open on the
  events page.
- **Data layer + pure helpers.** `petMix(orders)` and `eventRollups(events, orders)`
  added to `pos-sales-compute` (both exclude voided sales); unit-tested (6 new
  cases). Mock path updated: mock orders carry `pet_type`/`event_id` and two
  `MOCK_POS_EVENTS` (one active, one closed) so both features render in mock mode.
  Additive only, no schema changes here (the `pos_events` table, the two new
  `pos_orders` columns, and the `upsert_pos_event`/`close_pos_event` RPCs shipped
  to Staging separately). **Staging only.**

## 2026-09-14 — Offline Sales: Top products + Top bundles share one column — `style(offline-sales)`

- **Merged the standalone full-width "Top bundles" card into the right column**,
  stacked directly under Top products. The overview second row is now cleanly two
  columns: Sales over time (left) and the Top products / Top bundles stack (right).
- **One Revenue/Units toggle drives both.** Lifted the toggle into a shared
  `TopSellersColumn`; switching it re-ranks products and bundles together. In Units
  mode bundles rank by orders (their unit analog: one order == one bundle sold) and
  emphasize the orders figure; in Revenue mode they rank by revenue. No data or
  totals changed, purely layout + the shared control. **Staging only.**

## 2026-09-14 — Offline Sales: bundles show pre-populated on edit (no empty prompt) — `fix(offline-sales)`

- **On first load, the editor shows the order's real content** — two bundles show
  as two, each with its picks already filled, never an empty "Select bundle…"
  prompt. Each `bundle_group` reconstructs as its own bundle (no merging); a group
  with no header is auto-identified by matching its pick quantity to a bundle's
  `pick_count`, and any unattributed premium is defaulted onto the ₱0 bundles (a
  matched bundle takes its list price first, the remainder lands on the first).
- **Custom (unlinked) bundles are now valid and saveable** — a group that matches
  no bundle keeps its picks + an editable price and no longer blocks Save or forces
  a selection. The RPC stores it via a **custom-bundle premium line** (both ids
  null, tied to the group); the `pos_order_items` check constraint was relaxed to
  allow that third line shape. A bundle selector still lets you link it to a real
  bundle to get its rules.
- **Sales always record a bundle header now** (`buildBundleOrderItems`): a
  resolvable Coop id makes a linked header, an unresolvable one a custom premium
  line — so a bundle's price + grouping are never lost to an orphan group again.
- **Staging only — not promoted to prod.**

## 2026-09-14 — Offline Sales: legacy bundle orders edit as bundles — `fix(offline-sales)`

- **A pre-grouping bundle sale now opens as a bundle, not loose ₱0 rows.** When an
  order carries a bundle premium (its total exceeds the entry sum) with ₱0 picks,
  `orderToEntries` folds those picks into a bundle card carrying the premium as its
  price (so it shows ₱570, not ₱0), auto-linked to the bundle whose `pick_count`
  matches the pick quantity. Editing then shows only that bundle's picks, and
  **saving self-heals the order into the proper grouped shape**.
- **Pick options are restricted to the bundle's eligible categories** (already the
  rule for grouped bundles; now applies to folded legacy ones too). Each bundle
  card has a **bundle selector** to link/relink; an unlinked bundle blocks Save
  until you choose which bundle it is.
- Corrected a stale Staging `pick_count` on "Buy Any 4" (was 3) so it enforces and
  auto-matches as 4. **Staging only — not promoted to prod.**

## 2026-09-14 — Offline Sales: bundle-aware order editing — `feat(offline-sales)`

- **Bundles are editable again (correctly).** The Edit action is back on every
  non-voided order, including bundles. The editor shows an order as entries:
  individual items and bundle groups. A "Buy Any N" bundle renders N pick slots
  restricted to its eligible categories with a live `X / N` counter and an
  editable price; a fixed bundle shows its components with an editable price. You
  can add items or add a bundle to any order, and Save is blocked until each
  bundle meets its rule. This supersedes the 2026-09-14 fix that hid Edit for
  bundles.
- **Enforced server-side.** Saving calls the reworked `edit_pos_order`, which
  takes structured entries, checks each bundle's pick_count + pick eligibility,
  re-derives stock FEFO, and recomputes the total (`Σ item totals + Σ bundle
  prices`) — rejecting an invalid or voided order before anything mutates.
- **Reconstruction.** Orders now carry `bundle_group` on their lines; the new
  tested `orderToEntries` rebuilds groups from it (a legacy fixed-bundle header
  becomes a bundle with no picks; orphan picks degrade to loose items). The
  Orders page fetches active bundle definitions + product categories for the
  editor.
- **Schema (Staging, mirrored in `../zoomy-pos/supabase/pos_schema.sql`):**
  `pos_order_items.bundle_group`; `edit_pos_order` takes `p_entries`;
  `apply_pos_order` persists `bundle_group`. **Staging only — not promoted to prod.**

## 2026-09-14 — Offline Sales: don't corrupt bundles on edit + show line subtotals — `fix(offline-sales)`

- **Fix: bundle orders were editable and editing them wiped the bundle price.**
  A "Buy Any N for ₱X" sale records its picks as ₱0 component lines with the ₱X
  premium living only on the order total. The old Edit guard looked for a line
  with no `product_id` (a `bundle_id` line) to spot a bundle, but the POS never
  writes one, so the guard never fired and bundle orders showed an Edit button.
  Editing recomputes the total from the line totals, which zeroed the premium
  (e.g. a ₱570 "Cat Grass Cubes ×4" became ₱0). Now bundles are detected the
  reliable way, `total > Σ product-line totals` (new tested `isBundleOrder`), and
  the Edit action is hidden for them (matching the POS). To change a bundle, void
  it and re-ring.
- **Line subtotals in the edit modal.** Each item row now shows a read-only
  `qty × unit price` subtotal, so a ×2 line at ₱210 visibly reads ₱420 instead of
  looking like it ignored the quantity. The ₱ field stays the editable unit price
  (auto-filled from the catalog on pick).
- **Data repair (Staging):** restored the one bundle order a buggy edit had
  corrupted (back to ₱570 / ×4) and corrected its cat-grass stock.
- **Staging only — not promoted to prod.**

## 2026-09-14 — Offline Sales: unvoid a voided order (Staging only) — `feat(offline-sales)`

- **Voided orders now show an Unvoid action** in the Orders table
  (`/offline-sales/orders`), the inverse of Void. It confirms first, then calls
  the shared `unvoid_pos_order` RPC (restores the order to completed and re-applies
  its inventory FEFO server-side), and revalidates the Orders and Offline Sales
  views so the sale returns to the KPIs, payment-method breakdown, and stock.
- **Online-only.** Rejects an order that isn't voided; errors surface inline.
  Void's confirm copy updated ("You can unvoid it later") now that it's reversible.
- **Schema (Staging, mirrored in `../zoomy-pos/supabase/pos_schema.sql`):** new
  `unvoid_pos_order(text)`; `void_pos_order`'s audit now reverses the full net
  footprint so repeated void↔unvoid cycles stay ledger-consistent.
  **Staging only — not promoted to prod.**

## 2026-09-14 — Offline Sales: edit an order in place (Staging only) — `feat(offline-sales)`

- **The Orders table (`/offline-sales/orders`) now has an Edit action per order.**
  A modal lets you change the payment method, IG handle, and the product lines
  (pick a catalog product, set qty and unit price, add/remove lines) with a live
  running total. Saving calls the shared `edit_pos_order` RPC, which reverses and
  re-applies inventory and recomputes the total server-side, then revalidates the
  Orders and Offline Sales views so KPIs, the payment-method breakdown, and stock
  all reflect the change.
- **Guards mirror the POS:** voided orders show no Edit action (terminal);
  **bundle/component-only orders are not editable** (Edit is hidden when any line
  has a null `product_id`). An order line whose product has since been unlisted
  still shows its product in the picker (labeled "(unlisted)") instead of a blank
  select, so editing it doesn't silently drop the line.
- **Data plumbing:** `PosOrder` gained `client_uuid`, `customer_handle`, and
  `edited_at`; the Orders view surfaces an "edited" marker on changed orders. New
  `editOrderAction` server action + `PosCatalogItem` slim catalog fetched on the
  Orders page.
- **Staging only — not promoted to prod.** The `edit_pos_order` / `void_pos_order`
  schema changes live on Staging Supabase (mirrored in
  `../zoomy-pos/supabase/pos_schema.sql`); prod is unchanged.

## 2026-09-12 — Offline Sales: Manila "Today" fix + payment-method breakdown — `feat(offline-sales)`

- **Fix: "Today" (and the sales chart's day buckets) now use Asia/Manila (UTC+8)**
  instead of UTC. Previously, after Manila midnight the "Today" KPI kept showing
  the previous day's sales until 8 AM (e.g. ₱51,482 while the Daily target, which
  was already Manila-based, showed ₱0). `rangeStart('today')` and `salesByDay` now
  bucket by the Manila calendar day, so the KPIs match the Daily target and how an
  owner thinks of a bazaar day. (`manilaDayStart` moved into `pos-sales-compute`
  and is shared; 7d/30d are rolling windows, effectively unchanged.)
- **New color-coded payment-method dropdown** (top-left of the header, default
  "All payment options"). Picking a method makes the four KPI cards (Revenue /
  Orders / Units / Oversells) show **that method's** numbers. Only methods present
  in the current range are listed. Colors match the transaction badges (Cash green,
  QRPH violet, GCash blue, Maya teal, Card amber, BPI rose, Bank slate).
- **"Sales over time" is now a stacked bar chart by payment method.** Default shows
  every method in full color; selecting one **highlights its segments and greys the
  rest** (still visible). Hovering a day shows a **mini tooltip** with each payment
  option's amount, plus a color legend under the chart. New `orderMethod`,
  `presentMethods`, `salesByDayAndMethod` in `pos-sales-compute`; the breakdown is
  computed client-side from the range's orders so switching is instant.
- Verified: typecheck clean, 118 tests pass (+4), production build green;
  Manila-vs-UTC "today" gap confirmed against Staging (₱51,482 UTC vs ₱0 Manila).

## 2026-09-12 — Top products: sort by revenue or units (pill toggle) — `feat(offline-sales)`

- **Top products can now be ranked by units sold**, not just revenue. A small
  Revenue/Units pill in the panel header toggles the sort instantly (client-side,
  no reload); the active metric's column is emphasized. Both lists are computed
  server-side so "top by units" is the true top 5 by units, not the revenue top 5
  re-ordered. `topProducts` gained a `sortBy` argument; the Bundle deals
  reconciliation row is unaffected by the toggle.
- Verified: typecheck clean, 114 tests pass (+1), production build green.

## 2026-09-11 — Top bundles panel + reads real bundle lines (Phase 5 Surface F, step 3, Staging only) — `feat(offline-sales)`

- **New "Top bundles" panel** on `/offline-sales` — bundles ranked by revenue
  (name, orders, revenue), fed by real `bundle_id` order lines now that the POS
  records them (see the POS changelog, step 2). Appears once bundle sales flow
  through the updated POS; hidden when there are none.
- **Order reads now resolve bundles.** `getPosOrders` / `getPosOrdersPage` select
  `bundle_id` and join `pos_bundles` for the name, so bundle lines show the bundle
  name instead of "Unknown" in the orders list; `PosOrderLine` gained `bundle_id`.
- **Reconciliation is now era-proof.** `bundleSalesSummary` sums itemized revenue
  from **product lines only**, so `bundleRevenue = total − product-line revenue`
  is correct whether bundle money sits on a real bundle line (new sales) or only
  on the order header (pre-fix / offline-retried sales). New `topBundles` compute.
- Pre-fix and offline-retried bundle sales carry no `bundle_id`, so they stay in
  the "Bundle deals" reconciling total but are not listed by name in "Top bundles"
  (documented in the panel's info tip). No backfill.
- Verified: typecheck clean, 113 tests pass (+3), production build green. A mock
  "Buy Any 4" sale was added so the panel renders in mock mode.

## 2026-09-11 — Honest bundle reporting in Top products (Phase 5 Surface F, Staging only) — `feat(offline-sales)`

- **Fixes a misleading "Top products" panel.** A row like "Cat Grass Cubes,
  9 units, ₱850" looked wrong. Root cause (verified on prod, read-only):
  "Buy Any N" bundles are recorded as ₱0 component line items with the bundle
  price sitting only on the order header, so per-product **units** count bundle
  picks while per-product **revenue** (`Σ line_total`) excludes them. The two
  columns were on different bases, and the panel summed to far less than the
  Revenue KPI (on prod, ₱6,300 of a ₱17,130 total; the ₱10,830 gap = 19 bundles).
- **Presentation-only fix (no schema or write-path change, dashboard is
  read-only).** `topProducts` now also reports `bundledUnits` (units from ₱0
  lines), and a new `bundleSalesSummary` reconciles itemized product revenue with
  the KPI (`itemizedRevenue + bundleRevenue = totalRevenue`, by construction).
  The panel now: carries an info tip that the money column is itemized only;
  annotates rows whose units include bundle picks ("N of these units were
  bundled"); and adds a **"Bundle deals"** row plus a reconciliation line so the
  panel ties back to Revenue.
- **Heuristic + scope.** A ₱0 line is treated as a bundle pick (true on prod
  today; genuine freebies would be misattributed until the write path is fixed).
  **Not** backfilling the historical ₱0-component orders, and **rejected**
  splitting a bundle's price across its picks (fabricates a false-precise figure).
  The root-cause POS write-path fix (emit a real `bundle_id` line) and a future
  "Top bundles" panel are deferred follow-ups. Full RCA + sequencing in
  `COOP_INTEGRATION_PLAN.md` ("RCA + FIX" block).
- Verified: typecheck clean, 110 tests pass (+3), production build green, and the
  reconciliation invariant confirmed against live Staging data.

## 2026-09-11 — Gamified daily-target health bar (Phase 5 Surface E, Staging only) — `feat(offline-sales)`

- **New "Daily target" health bar** showing **today's POS revenue vs an owner-set
  peso goal**, with a fill that escalates red → amber → lime → emerald as the day
  closes on the target, a `%`, and a `₱X of ₱Y · ₱Z to go` readout. **Full bar
  (with an inline goal editor)** sits atop `/offline-sales`; a **compact,
  read-only strip** leads the home landing. v1 is progress + color tiers only
  (no milestones, streaks, or levels).
- **"Today" is the Asia/Manila calendar day** (resets at local midnight), computed
  in a new `src/pos-target-compute.ts` module. This is deliberately independent of
  the Offline Sales range tabs, which still use UTC, so the bar and the "Today"
  tab can differ for sales between 00:00 and 08:00 Manila (accepted for v1).
- **Editable target, DB-backed.** New additive `pos_settings` table (key/value) +
  `set_pos_daily_target` RPC on Staging (RLS on, anon-read policy; writes flow
  through the SECURITY DEFINER RPC like every other `pos_*` write). Seeded at
  ₱5,000. `set_pos_daily_target` is the only new schema; the four Coop tables and
  the ten existing `pos_*` tables are untouched. `zoomy-pos/supabase/pos_schema.sql`
  mirrors it. **Not applied to prod.**
- **Fail-soft by construction.** Both page reads wrap the target/progress fetch in
  try/catch → `null` → the bar is simply omitted, so a missing or failing
  `pos_settings` can never 500 a page that otherwise renders (matches the offline
  isolation already used on the home Overview). `pos-sales-compute.ts` and
  `getPosOrders` are reused (not modified); the landing shares the React-cached
  orders fetch, adding no extra query.
- New files: `src/pos-target-types.ts`, `src/pos-target-compute.ts`,
  `src/pos-target.ts`, `src/pos-target-actions.ts`,
  `components/analyst/daily-target-bar.tsx`. Verified: typecheck clean, 107 tests
  pass (+11 for the Manila-day boundary, tiers, and overflow math), production
  build green, and the target read/write round-tripped live against Staging.

## 2026-09-11 — Offline Sales: IG handle, color-coded methods, void + restock — `feat(offline-sales)`

- **IG / furbaby handle** now shows on each transaction (a 🐾 chip) when set.
  Requires the cross-repo change: `pos_orders` gained a `customer_handle`
  column, `apply_pos_order` persists it, and the POS pushes it (see the POS
  changelog). Only appears on sales made *after* that ships — past synced sales
  have none. Remarks were already displayed; both now read clearly.
- **Payment method badges are color-coded** (`paymentMethodBadgeClass`): Cash
  green, QRPH violet, GCash blue, Maya teal, Card amber, BPI rose, Bank slate —
  muted tints, readable in both light and dark themes.
- **Void a sale from Coop** (new `voidOrderAction` → the shared `void_pos_order`
  RPC), with a confirm. **Voiding now restocks**: `void_pos_order` was
  redefined to reverse the sale's FEFO inventory decrements (add each qty back
  to the lot it came from) and log compensating stock movements — idempotent, so
  a re-void never double-restocks. This applies to POS-side voids too, since
  both call the same RPC (previously no void restored stock anywhere).
- Verified end-to-end against Staging in a real browser: a sale decremented
  stock, the in-app Void restored it exactly, and the row flipped to voided.
  `tsc`, 96 tests, and the production build all pass.

## 2026-09-10 (develop only — not yet promoted to staging)

### Product Controls: breathing room in the header and table — `fix(products)`
- The header row (product count + description, "Updated Xs ago" + Refresh +
  New product) had no gap between the two sides — at some viewport widths the
  description text ran right up against "Updated just now". Switched to
  `flex-wrap` with an explicit gap (matching the pattern already used on the
  Offline Sales header), so the two sides always keep a clear gap and wrap
  onto their own line on narrow viewports instead of colliding.
- The 8-column table (SKU/Emoji/Name/Line/Category+Subcategory/Price/Stock/
  Listed) was being squeezed by the page's `max-w-5xl` container: Name wrapped
  onto 3+ lines and the Listed toggle sat flush against the card's right edge
  with no margin. Widened Product Controls (and Bundles below it, kept in
  sync so the two sections still line up) to `max-w-6xl`, gave the table and
  its Name column sensible minimum widths, and added extra right padding on
  the Listed column. At typical desktop widths this now fits with real
  breathing room and no horizontal scroll; on genuinely narrow viewports the
  existing `overflow-x-auto` still scrolls the table horizontally instead of
  squishing columns unreadable. Verified in a real browser at 1897px (no
  scroll, comfortable spacing) and 900px (table correctly scrolls).

### Live Refresh + filters on Product Controls — `feat(products)`
- Product Controls (and the Bundles section below it) previously only showed
  what was loaded on the initial page request — a POS-side edit (reprice,
  stock, listing) wasn't visible until a full browser reload. Added the same
  `RefreshControl` pattern the Offline Sales transactions page already uses:
  a button that calls `router.refresh()` to re-fetch server data in place,
  with an "Updated Xs/mins ago" label. `BundleControls` gained the matching
  `useEffect` re-sync (it was missing one, so a refresh silently wouldn't
  have updated it) so one Refresh button covers both sections.
- Added a filter bar above the Product Controls table: a name/SKU search,
  Category pills (mirroring the POS's own tabs), a Subcategory pill row
  (Freeze Dried only), a Listed/Unlisted status pill, and a stock-range
  popover. Unlike the transactions filter bar (which is URL-param-driven
  because it's server-paginated), this is local component state — the whole
  catalog is already loaded in one request, so narrowing it is a pure
  in-memory filter with no extra round-trip. New `src/pos-product-filter.ts`
  holds the pure filter logic + types (unit tested, 12 new tests) and
  `components/analyst/product-filters.tsx` holds the UI, both following the
  existing `pos-sales-compute.ts` / `transaction-filters.tsx` split.

### QRPH payment label + filter — `feat(offline-sales)`
- Added **QRPH** to `paymentMethodLabel` and `ORDER_METHOD_FILTERS`, matching
  the new POS payment method (a generic QR tap). Old GCash/Maya/Card records
  are unaffected — this only adds a label/filter for the new value going
  forward.

### Chopsticks + ice cube added to the emoji palette — `feat(products)`
- Added 🥢 and 🧊 to `PRODUCT_EMOJIS` in `pos-format.ts`, matching the POS's
  palette (`constants/emoji.ts`).

## 2026-09-09 (develop only — not yet promoted to staging)

### Bundles section on Product Controls — `feat(bundles)`
- Added a **Bundles** component under Product Controls that reads the bundles
  synced from the POS (`pos_bundles`): shows each bundle's emoji (tap-only
  picker), name, type (Buy Any N / Fixed), price, listed toggle, and delete.
  Editing writes to `pos_bundles` (emoji/name/price/active via direct update,
  delete via the shared RPC) so changes mirror back to every POS device.
  Bundle creation stays in the POS. Added `getPosBundles`, `PosBundleRow`, the
  bundle actions, mock bundles, and 🍐 to the emoji palette.

## 2026-09-09

### Emoji picker is tap-only (no typing) — `fix(products)`
- The emoji column and New Product field were plain text inputs — you can't type
  an emoji on a desktop keyboard. Replaced both with a **tap-only picker**
  (`EmojiPicker`): a popover with a curated emoji grid, a live preview, and a
  backspace; tap up to 3. Curated set lives in `pos-format.ts`.

### Product Controls: emoji on create + edit — `feat(products)`
- Product Controls gains an **Emoji** column (editable inline, 1 to 3 emoji) and
  an emoji field on the New Product form. Written directly to the new
  `pos_products.emoji` column (service role). The POS reads it to seed a new
  tile; existing POS emoji edits are preserved on sync.
- Added `clampEmoji` / `parseEmoji` helpers (grapheme-aware, capped at 3) and a
  `setEmojiAction`. `PosProductRow` + reads + mock carry the emoji.

### Design critique follow-ups: edit safety, tile consistency, home & footer — `feat(ui)`
Acting on the Impeccable UI critique (30/40; "authored, not slop") — four of the
five priority fixes (compare-view overload deferred):
- **P0 · Product Controls edit safety.** Price/unlist edits no longer apply
  silently. Each row now flashes a **"Saved"** chip on success, unlisting asks
  for **inline confirmation** first (it hides a product from the POS), an
  **Undo toast** reverses an unlist, and edit **errors anchor under the offending
  row** instead of a single bar at the top of the table. Decision: match the
  repricer's existing reassurance (confirm/undo/guardrails) on the one surface
  that writes to a live catalog.
- **P1 · One canonical metric tile.** Added `components/analyst/metric.tsx`
  (`Metric`, `metricValueClass`, `MetricDelta`) and pointed the six divergent KPI
  dialects (`KpiTile`, `FigureTiles`, `CombinedKpis`, offline `Kpi`, repricer
  `StatCard`, and the home stat) at it, so every value renders in the house serif
  face. Removed the now-dead `Delta` in `sections.tsx`. Fixes the inconsistency
  that dragged heuristic #4 (Consistency) to 2/4.
- **P3 · Home leads with the verdict.** `home-landing.tsx` now opens with the
  real synthesized `digest.headline` (not a generic "Coop Intelligence" panel),
  retired the `animate-ping` live-dot and the `Sparkles` "AI analyst" bullets —
  the only AI-slop signifiers the critique flagged.
- **P3 · Health footer is no longer a text wall.** The trailing 200-word "how
  it's calculated" prose on Business Health is now a collapsed
  **`<details>` disclosure**, so the view resolves on its charts/cards, not a wall
  of caveats. (The other two views' "footers" were already one-liners.)

Verified: `tsc --noEmit` clean, 84 tests pass, Impeccable detector clean on all
changed files. No schema/data changes. Deferred: P2 (channel-compare overload).

### Offline Sales: status (voided) filter — `feat(offline-sales)`
- Added a **Status** filter (All / Completed / Voided) to the transactions bar,
  so you can show voided sales only. Applies server-side alongside the other
  filters (count + rows), URL-driven, and is cleared by "Clear filters".

### Offline Sales: refresh control + last-loaded time — `feat(offline-sales)`
- Added a **Refresh** control on the Offline Sales overview and the orders
  subpage. It re-fetches the server data in place via `router.refresh()` (no
  full page reload, spins while pending) and shows a relative **"Updated …"**
  timestamp of when the data was last loaded (stamped server-side per render).

### Reflect POS voids + remarks — `feat(offline-sales)`
- Read `status` / `remarks` from `pos_orders`. **Voided sales are excluded from
  revenue and every aggregation** (KPIs, daily sales, top products, and the
  offline Business Health / Compare Channels metrics that derive from them).
- Voided orders still appear in the orders list and Recent orders panel, shown
  **struck-through with a "voided" badge**; a POS **remark** renders inline
  under the order.
- **Decision:** a void means the sale didn't count, so it drops out of Coop
  revenue; it stays visible (struck-through) for audit.

### Offline Sales: cap "Recent orders" at 5 — `fix(offline-sales)`
- The "Recent orders" panel on the Offline Sales overview listed up to 12 rows,
  making it very long. Capped it at 5 (the full history is behind "View all").

### Offline Sales: date-range calendar picker — `feat(offline-sales)`
- Replaced the Today/7d/30d date presets with a **date-range calendar popover**
  on the All-transactions list (two-pick inclusive range, future days disabled,
  Apply/Reset). Added a themed `Calendar` primitive.
- **Timezone fix:** picked calendar days convert to absolute instants in the
  viewer's timezone (start-of-day → end-of-day) before hitting the URL, so a
  range matches the local times shown in the list (e.g. a Philippine morning
  sale that is the previous day in UTC). Verified with `TZ=Asia/Manila`.
- **Decision:** custom themed calendar rather than native `<input type=date>`
  (renders unthemed on dark UI) or a date library (unneeded dependency).

## 2026-09-08

### Offline Sales: filter + paginate transactions — `feat(offline-sales)`
- Added a filter bar above the "All transactions" list: payment-method pills
  (All / Cash / GCash / Maya / Card), a date filter, and a **price range**
  popover (two-thumb Base UI slider + min/max inputs).
- Filters live in the URL and apply **server-side to both the count and the row
  query**, so pagination stays correct; the pager preserves active filters.
- **Page size set to 10**, newest first (was 25).
- **Decision:** URL-search-param filters (shareable, refresh-safe) matching the
  existing pill pattern; added a `RangeSlider` primitive on `@base-ui/react`.

### Surface the POS payment method — `feat(offline-sales)`
- Read `payment_method` from `pos_orders` and show a method badge next to each
  transaction on the Offline Sales orders list (null legacy rows read as Cash).
  Depends on the POS-side `pos_orders.payment_method` column (see the POS
  changelog).

## 2026-09-07

### Product controls + navigation — `feat(products)` / `feat(nav)` / `feat(brand)`
- Product controls: editable stock, product-line dropdown, new-product stock
  field, and Category/Subcategory controls (Coop drives the POS tab).
- Navigation: expandable drawer nav with labels; Overview accordion with a
  collapsed-rail flyout submenu and a rest-state chevron affordance; Business
  Health back button; centered rail toggle; snappier interactions.
- Added the Coop favicon.

### Offline reporting (Phase 5) — `feat(offline-reporting)`
- Offline (POS) sales data layer + aggregation helpers; Offline Sales page;
  stock-alerts card; Offline channel card on Overview; Offline as a 4th Business
  Health channel; Offline in the Overview Compare Channels chart (shown by
  default); paginated transactions subpage. Regression-review findings
  addressed; em-dashes removed from UI copy per review.

---

_Earlier history predates this changelog; see the git log._
