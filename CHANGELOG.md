# Changelog — Coop Dashboard

Notable changes to the Coop / BrandOS dashboard (`zoomy-observability-dashboard`).
The POS app has its own changelog in `../zoomy-pos/CHANGELOG.md`.

Conventions: work flows `feature → develop → staging` (never `main` without
sign-off); Conventional Commits; commits carry `Co-Authored-By: Claude` +
a `Claude-Session` trailer. Reads the shared Coop Supabase (Staging on the
`*-staging` deploy; PROD is the co-worker's project).

Dates are local working dates (GMT+8). Newest first.

## 2026-10-19 — v1.8.0: BoxMe (Online) inventory and Ask Coop online stock (prod release)
Minor bump (SemVer): a new feature, no breaking change; one manual SQL file on prod (below), no new env vars.

- **What:** promotes only the BoxMe work from staging, by cherry-pick, because staging and main have diverged (a full staging → main merge conflicts in 35 files). Ships the BoxMe channel on `/inventory?channel=online` and the BoxMe card on `/inventory/[sku]` (see the 2026-10-08 entry), plus Ask Coop's BoxMe answers through `query_metric`: `stock_on_hand` dimensions `online`, `all_channels`, `expiring_online` and `stock_cover` dimension `online`, each saying the last good sync time and saying first when the sync is stale, failed or not connected.
- **Left out on purpose:** `lookup_product` show `stock` (one product's stock as stat tiles, with BoxMe added). It builds on the staging-only "Ask Coop asks before it guesses" work (`clarify.ts`, `product-resolve.ts`) and `ede079a`, so it waits for the next full release.
- **Database (prod):** the `boxme_*` tables already exist on prod (zoomy-observability's `supabase/boxme_inventory.sql`, applied 2026-10-19) and are filled by its `boxme-sync` GitHub workflow, which now has a production leg. Still to apply by hand on prod: `supabase/coop_chat_boxme.sql` (chat views for `coop_chat_ro`), so Ask Coop can read BoxMe. Until then the chat says BoxMe is not connected, never 0.

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

## 2026-10-16 — v1.7.3: "Merged" posts to Google Chat for pull requests into main (prod release)
Patch bump (SemVer): a CI fix, no app change, no schema or env change.

- **What was missing:** `pr-gchat-notify.yml` on `main` only had the "New PR" job. The "Merged" job (who pressed merge, the author, the branches and the merge commit) lives on `develop` and `staging`, so a pull request into `main` (every release PR) never posted a "Merged" message. A `pull_request` workflow runs from the base branch, which is why only `main` was affected.
- **Fix:** `main` now carries the same `pr-gchat-notify.yml` as `develop` and `staging` (the workflow also runs on `closed` and the `merged` job fires only for a merged pull request, not one closed unmerged).
- *Housekeeping (not code):* the Actions secret `GCHAT_WEBHOOK_URL` posts to the Google Chat space `AAQAybivOZg`; the old repo variable of the same name points to a different space. If messages seem missing, look in that space.

## 2026-10-16 — v1.7.2: deploy notifications only for this repo's own Vercel project (prod release)
Patch bump (SemVer): a CI fix on top of v1.7.1, no app change, no schema or env change.

- **What was wrong:** two Vercel projects deploy this repo right now, the old `coop-brand-os` and the new `coop-observability-dashboard`, so each push makes two deployments. With v1.7.1 matching `Production*` by prefix, both would notify, and the old project's message links to the old site (`coop-brand-… .vercel.app`).
- **Fix:** `deploy-gchat-notify.yml` skips an environment named after another project (`… – coop-brand-os`) and notifies only for `… – <this repo's name>`, or a name with no project suffix. One message per deploy, linking to the right site.
- *Housekeeping (not code):* disconnect the old Vercel project from this repo (Settings > Git) once the new project has every env var (ANTHROPIC_API_KEY, EXPLORE_*, CRM_*, CHAT_READ_MODE, GOLDLINE_ANTHROPIC_API_KEY). Until then the old project keeps deploying and is simply not notified.

## 2026-10-16 — v1.7.1: deploy notifications reach Google Chat again (prod release)
Patch bump (SemVer): a CI fix, no app change, no schema or env change.

- **What broke:** after the repo move the "Deploy notify (Google Chat)" workflow skipped every production and staging deploy. Vercel now names the production environment `Production – coop-observability-dashboard` (the project is a suffix) and reports a staging deploy as `Preview` with the commit SHA as its ref; the workflow matched `Production` / `Staging` / ref `staging` exactly. The last production notification was 2026-10-16 00:53 UTC; the staging runs (Oct 14 to 15) were all skipped.
- **Fix:** `deploy-gchat-notify.yml` accepts `Production*` and `Staging*` by prefix, and treats a `Preview` deploy as Staging only when its SHA is the head of `staging`. A pull request's own Preview posts nothing. The Google Chat post is unchanged and reads the Actions secret `GCHAT_WEBHOOK_URL`.
- **Why it ships to `main`:** a `deployment_status` workflow runs from the default branch, so production notifications change only once this is on `main`.
- *Housekeeping (not code):* a repo variable named `GCHAT_WEBHOOK_URL` holds the full webhook URL in plain text; the workflow uses the secret of the same name, so the variable should be deleted (and the webhook rotated if needed).

## 2026-10-15 — v1.7.0: Goldline (Nichido) on Coop, multi-role access, env switcher (prod release)
Minor bump (SemVer): new features. **Needs database and env steps on prod before the merge** (below). Ships to `main` as one cherry-picked release (74 commits from staging, squashed); per-feature detail is in the staging CHANGELOG entries from 2026-10-05 to 2026-10-13.

- **Goldline Cosmetics (NICHIDO) as a second, walled-off company.** `companies` / `company_users` tenancy; a data-blind Coop Admin; Zoomy-only pages and Ask Coop are fenced so a Goldline viewer never sees Zoomy data.
- **Goldline pages:** Overview, Stores, Inventory board (counts + forecast + warehouse supply), product page (month by month), Stock forecast, Action Feed, Store health, Uploads.
- **Uploads:** POS sales CSV, and handwritten inventory-form PDFs read by Claude Vision (pages 1 to 5, page auto-detect), a confidence-first review workbench, multi-file batches with an all-or-nothing commit (`gl_commit_batch`), and a scan reader that learns each writer's handwriting from reviewed pages (learns from prod's own reviews; nothing carries over from Staging).
- **Multi-role access:** a person can hold several roles and switch views (header switcher with company wordmarks); Users & Roles console for Coop Admins; starting view per user.
  - **Sign-in is now membership-driven.** `ALLOWED_EMAILS` is no longer read: only someone with an active row in `company_users` can sign in.
- **Environment switcher (Staging ↔ Production)** for Coop Admin role holders, `/admin/environments`, public `/api/health`; on Production, Suspend and Remove access require typing PRODUCTION.
- **Polish:** sign-out confirmation; shared `ModalShell` so Zoomy inventory dialogs animate in and out; `prefers-reduced-motion` honored app-wide; scan lightbox fade; Goldline phone layouts.
- *Not included (staging only):* multi-event and the BoxMe online stock channel.
- *Before merging (prod DB, co-worker's project), apply in order:* `companies.sql` (seeds Zoomy access from `pos_dashboard_users`), `goldline.sql` (+ private `goldline-uploads` bucket), `multi_role.sql`, `company_user_prefs.sql`, `goldline_inventory_snapshots.sql`, `goldline_upload_batches.sql`, `goldline_supply.sql` (no sample warehouse data), `goldline_perf_indexes.sql`, `seed_goldline_catalog.sql`, `company_user_audit_env.sql`, plus `goldline_prod_gaps.sql` (`gl_uploads.error_detail` + the `goldline-uploads` bucket, which existed on Staging but in no file). Then check every current `ALLOWED_EMAILS` address has a `company_users` row, seed the Goldline company + its user and a Coop Admin, and set `GOLDLINE_ANTHROPIC_API_KEY` on the prod Vercel project (PDF extraction; CSV works without it).
- *Decision:* Goldline reads its **own** key, `GOLDLINE_ANTHROPIC_API_KEY`, separate from Ask Coop's `ANTHROPIC_API_KEY`, with **no fallback**, so Goldline usage is never billed to Ask Coop's key (the two keys are kept separate on purpose). Without it, PDFs are stored for manual review instead of being read.
- *Decision:* promoted by cherry-pick, not by merging staging, so staging-only multi-event and BoxMe stay off prod. Hand-resolved conflicts: chat route keeps the CRM import plus the tenant guard; inventory table takes `ModalShell` without the BoxMe status refactor.

## 2026-10-15 — v1.6.1: Ask Coop answers again on prod (prod release)
Patch bump (SemVer): a bug fix to v1.6.0; no new feature, no schema or env change.

- **What broke:** on prod every Ask Coop question failed ("Coop hit a problem answering that"). The API answered 400 "the compiled grammar is too large" before any token: Explore and the four website CRM tools together put 18 strict tools in one request (the staging config sent 14 and worked). Found by logging the 400 message (#195).
- **Fix:** `list_crm_orders`, `list_crm_customers` and `list_crm_checkouts` are sent with `strict: false`; `get_crm_metrics` and every other tool stay strict. A key the model leaves out takes its default (limit 25, offset 0, filters "all", group_by "none"); the dates have no default; an unknown key (a url, a method) is still refused before any read; the CRM client is still GET-only.
- **Measured:** probes against the live API at `max_tokens: 1`: base 11 and Explore 14 pass, base plus the four CRM tools (15) and all 18 fail; with the three list tools non-strict all 18 pass. `test/chat-tools-grammar.integration.test.ts` repeats this (skipped without an API key): run it before a deploy that touches `metrics-registry.ts`, `tool-defs.ts` or `crm/tools.ts`, because a new metric or dimension grows `query_metric`'s enums and uses up the headroom.
- Also logged: `chat_error` carries the first 300 characters of a 400's message (#195).

## 2026-10-15 — v1.6.0: Ask Coop trains 1-4 (prod release)
Minor bump (SemVer): new, backward-compatible Ask Coop features. Unlike v1.5.0 this release **needs a database and env step before it works on prod** (see below); the dashboard still builds and runs without it, with Explore and the CRM tools off.

- **Train 1, fast path:** the chat gets the open page and describes pasted dashboard links from a page map; Explore reads stock; the prompt is honest about what it can and cannot see.
- **Train 2, digest periods and charts:** period comparisons from the digest, with charts first.
- **Train 3, direct reads:** Explore reads every `public` table and view except secrets, tenant (`gl_*`, `company_*`) and token tables.
- **Train 4, website CRM tools:** `get_crm_metrics`, `list_crm_orders`, `list_crm_customers`, `list_crm_checkouts` (GET only).
- *Before enabling on prod (not part of this PR):* apply `supabase/coop_chat_explore.sql`, `coop_chat_stock.sql`, `coop_chat_explore_direct.sql`, `coop_chat_default_views.sql` by hand (the co-worker owns the prod project), run the checks files, then set `EXPLORE_DATABASE_URL`, `EXPLORE_MODE`, `EXPLORE_ALLOWED_EMAILS`, `CRM_API_URL`, `CRM_API_READ_TOKEN` on Vercel and redeploy. Train 3 on prod also waits for zoomy-pos to revoke PUBLIC execute on its write RPCs.
- Per-train detail is in the entries below.

## 2026-10-14 — v1.5.0: Transactions and Offline Sales redesign (prod release)
Minor bump (SemVer): new, backward-compatible UI features; no schema, API or env changes. It also rolls up the feature releases that reached prod since v1.4.1 without a bump (#160 event-scoped "View all products", #169 "Update leads", #176 Events redesign). Ships to `main` as one cherry-picked release; staging has had each piece since 2026-10-13/14.

- **Transactions (`/offline-sales/orders`):** full width, sales grouped by day (Today / Yesterday / date), cleaner rows with icon Edit/Void, "N transactions" count and "Showing X to Y of Z" pagination (`PageInfo.total`).
- **Transactions filters:** Method, Date, Price and Status are compact dropdown triggers (Hick's law); applied filters show as removable pills with Clear all; Date has quick ranges (Today, Yesterday, Last 7 days, Last 30 days).
- **Offline Sales (`/offline-sales`):** full-width responsive 12-column grid (hero row of event, daily goal and KPIs; chart beside pet mix; lists three across), roomier spacing, KPIs as one segmented card, range and payment option in one toolbar.
- **Calmer list panels:** soft toggles and tinted status chips instead of solid fills (shared `SegmentedControl`, so other toggles soften too); Top products / Top bundles show "% of revenue / units / bundle orders"; Recent orders lead with what sold; Stock health bar; Stock alert lanes; Free items won as cards with "Show all".
- **Free items won** names the event each prize was given at (order event tag, else the event covering its date) and links to it.
- *Prod adaptation:* prod has no multi-event, so the Transactions **Event filter and per-sale event badge are not included** (staging-only, PR a99bb4c). Everything else matches staging.
- Copy: no en/em dashes in the touched labels ("Oct 10 to Oct 17", "₱100 to ₱500").

## 2026-10-13 — Events redesign (prod release)
Promotes this session's Events work from staging to prod by cherry-pick (develop commits 6cca2a6, 3da0413, 1313657, cb55d27). Multi-event (same-day events) is **not** part of this release, so two pieces were adapted to prod's one-event-per-date rule.
- **Tile grid** on `/offline-sales/events` with a **Tiles / Table** toggle (remembered per browser), full page width, and an always-visible pager ("Showing X to Y of Z", Per page 12 / 24 / 48).
- **Per-event page** `/offline-sales/events/[eventId]`: header, Edit, cash reconciliation and the full analytics (always expanded). Event-scoped rankings go back to it.
- **New / Edit event as a slide-over** with grouped fields, one date-range calendar, ₱ float presets and per-field errors.
- **Color-coded status pills**: Happening now green, Upcoming blue, Done neutral.
- *Prod adaptations:* the live event pinned to the top comes from `featuredEvent` (one current event), not multi-event's `currentEventIds`. In the form, overlapping dates show a blocking warning and disable Create (prod's `upsert_pos_event` rejects overlaps), instead of staging's "runs alongside" note.

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

## 2026-10-06 — Explore status and a live probe in /api/chat/health
- Feature: `GET /api/chat/health` gains an additive `explore` object so a hosted deployment shows why Explore is on or off. `enabled` and `reason` come from `resolveExploreAccess` for the signed-in person (reason codes only, never the URL or list); flags `EXPLORE_MODE` (`on`), `EXPLORE_DATABASE_URL` (`set`, `length`, `roleOk`, hostname-only `host`, `kind` pooler/direct/loopback/other), `EXPLORE_ALLOWED_EMAILS` and `ALLOWED_EMAILS` (`set`, `count`). When enabled, `probe` runs one fixed statement (`current_user`, `transaction_read_only`, a count of `coop_explore_orders`) through the same read-only cursor envelope as the chat, capped at 5 s, and reports `{ok, role, readOnly, ms}` or a short code (`connection_refused`, `auth_failed`, `timeout`, `undefined_table`, `permission_denied`, ...), never driver text. No probe for non-allowed users; nothing cached or logged.
- Decision: the probe lives in `src/chat/explore/probe.ts` (pure, injected runner) and the real driver is reached only through `explore-setup.ts` (`exploreHealth`), so the architecture rule that only `client.ts` imports `postgres` and only `explore-setup.ts` imports `client.ts` still holds. `ExploreDbError` now carries the driver code (`sqlstate`, never text) so the probe can tell a wrong password from a closed port. Runbook: "Explore status in /api/chat/health".
- Test: `chat-explore-probe.test.ts` (fake runner) and `chat-explore-probe.integration.test.ts` (local Docker only, loopback guard first).

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
