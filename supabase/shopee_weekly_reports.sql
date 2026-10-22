-- shopee_weekly_reports.sql: OWNED BY zoomy-observability-dashboard (the Shopee import pipeline, src/shopee-import/). Run AFTER shopee_import.sql.
-- Applied BY HAND in the archive project's SQL editor (local Docker first, then staging; PROD with the co-worker's OK).
-- Service role only: RLS on, no policies. Idempotent. Plan: knowledge/tasks/2026-10-22-shopee-import-data-engineering-plan.md.
--
-- The four reports besides the Sales Overview: weekly ads (per campaign), weekly SKU (per product and variation), daily traffic (All, PC, APP)
-- and the daily product funnel. Same append-only rule as the sales figures: every import is a row in import_runs, its figures are rows tagged
-- with the import, NOTHING is updated or deleted, and the app reads a VIEW of the newest ACCEPTED import per period (weekly reports) or per
-- day (daily reports). apply = one status flip, undo = flip back.

create table if not exists public.marketplace_ads_week_observations (
  import_id          uuid    not null references public.import_runs (import_id),
  seq                integer not null,                      -- row order in the file
  ad_name            text    not null,                      -- e.g. 'Shop GMV Max', or a product ad's name
  ads_type           text,
  status             text,
  impressions        integer not null default 0,
  clicks             integer not null default 0,
  conversions        integer not null default 0,
  direct_conversions integer not null default 0,
  items_sold         integer not null default 0,
  gmv                numeric(12, 2) not null default 0,     -- sales credited to the ads (what ROAS is made from)
  direct_gmv         numeric(12, 2) not null default 0,
  expense            numeric(12, 2) not null default 0,     -- ad spend
  primary key (import_id, seq)
);

create table if not exists public.marketplace_sku_week_observations (
  import_id          uuid    not null references public.import_runs (import_id),
  seq                integer not null,
  item_id            text    not null,
  product            text    not null,
  variation_id       text,                                  -- null on the product's own row, set on each variation row
  variation_name     text,
  sku                text,
  parent_sku         text,
  sales_placed       numeric(12, 2) not null default 0,
  sales_confirmed    numeric(12, 2) not null default 0,
  units_placed       integer not null default 0,
  units_confirmed    integer not null default 0,
  orders_placed      integer not null default 0,
  orders_confirmed   integer not null default 0,
  buyers_placed      integer not null default 0,
  buyers_confirmed   integer not null default 0,
  impressions        integer,
  clicks             integer,
  visitors           integer,
  page_views         integer,
  primary key (import_id, seq)
);

create table if not exists public.marketplace_traffic_day_observations (
  import_id          uuid    not null references public.import_runs (import_id),
  day                date    not null,                      -- PH calendar day
  platform           text    not null check (platform in ('all', 'pc', 'app')),
  page_views         integer not null,
  avg_page_views     numeric(8, 2),
  avg_time_seconds   integer,
  bounce_rate        numeric(6, 2),                         -- percent
  visitors           integer not null,
  new_visitors       integer,
  existing_visitors  integer,
  new_followers      integer,
  primary key (import_id, day, platform)
);

create table if not exists public.marketplace_funnel_day_observations (
  import_id             uuid    not null references public.import_runs (import_id),
  day                   date    not null,
  visitors              integer not null,
  page_views            integer not null,
  items_visited         integer,
  bounce_visitors       integer,
  bounce_rate           numeric(6, 2),
  search_clicks         integer,
  likes                 integer,
  add_to_cart_visitors  integer,
  add_to_cart_units     integer,
  buyers_placed         integer not null,
  units_placed          integer not null,
  sales_placed          numeric(12, 2) not null,
  buyers_confirmed      integer not null,
  units_confirmed       integer not null,
  sales_confirmed       numeric(12, 2) not null,
  primary key (import_id, day)
);

-- Weekly reports: one file is the whole week, so the app reads the rows of the newest accepted import for each (period_from, period_to).
create or replace view public.marketplace_ads_weekly as
  select r.period_from, r.period_to, r.accepted_at as captured_at, o.*
  from (
    select distinct on (period_from, period_to) import_id, period_from, period_to, accepted_at
    from public.import_runs
    where report_type = 'ads' and channel = 'shopee' and status = 'accepted'
    order by period_from, period_to, exported_at desc nulls last, accepted_at desc
  ) r
  join public.marketplace_ads_week_observations o using (import_id);

create or replace view public.marketplace_sku_weekly as
  select r.period_from, r.period_to, r.accepted_at as captured_at, o.*
  from (
    select distinct on (period_from, period_to) import_id, period_from, period_to, accepted_at
    from public.import_runs
    where report_type = 'sku_detail' and channel = 'shopee' and status = 'accepted'
    order by period_from, period_to, exported_at desc nulls last, accepted_at desc
  ) r
  join public.marketplace_sku_week_observations o using (import_id);

-- Daily reports: per day (and platform), the newest accepted import wins.
create or replace view public.marketplace_traffic_daily as
  select distinct on (o.day, o.platform) o.day, o.platform, o.page_views, o.avg_page_views, o.avg_time_seconds, o.bounce_rate, o.visitors,
         o.new_visitors, o.existing_visitors, o.new_followers, r.import_id, r.accepted_at as captured_at
  from public.marketplace_traffic_day_observations o
  join public.import_runs r using (import_id)
  where r.status = 'accepted' and r.channel = 'shopee'
  order by o.day, o.platform, r.exported_at desc nulls last, r.accepted_at desc;

create or replace view public.marketplace_funnel_daily as
  select distinct on (o.day) o.day, o.visitors, o.page_views, o.items_visited, o.bounce_visitors, o.bounce_rate, o.search_clicks, o.likes,
         o.add_to_cart_visitors, o.add_to_cart_units, o.buyers_placed, o.units_placed, o.sales_placed, o.buyers_confirmed, o.units_confirmed,
         o.sales_confirmed, r.import_id, r.accepted_at as captured_at
  from public.marketplace_funnel_day_observations o
  join public.import_runs r using (import_id)
  where r.status = 'accepted' and r.channel = 'shopee'
  order by o.day, r.exported_at desc nulls last, r.accepted_at desc;

-- RLS on with NO policies = service role only. The views run as their owner.
alter table public.marketplace_ads_week_observations enable row level security;
alter table public.marketplace_sku_week_observations enable row level security;
alter table public.marketplace_traffic_day_observations enable row level security;
alter table public.marketplace_funnel_day_observations enable row level security;
revoke all on public.marketplace_ads_weekly, public.marketplace_sku_weekly, public.marketplace_traffic_daily, public.marketplace_funnel_daily from anon, authenticated;

-- The original export files (shop totals only, never a per-order file) are kept in a PRIVATE bucket under <report type>/<sha256>.<ext>, so a
-- file can be re-read if a parser changes. Created only where the storage schema exists; the import carries on without it.
do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public) values ('shopee-imports', 'shopee-imports', false) on conflict (id) do nothing;
  end if;
end $$;

notify pgrst, 'reload schema';
