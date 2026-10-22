-- shopee_import.sql: OWNED BY zoomy-observability-dashboard (the Shopee import pipeline, src/shopee-import/).
-- Applied BY HAND in the archive project's SQL editor (local Docker first, then staging; PROD with the co-worker's OK).
-- Service role only: RLS on, no policies. Idempotent. Plan: knowledge/tasks/2026-10-22-shopee-import-data-engineering-plan.md.
--
-- Model (append-only): every import is a row in import_runs; the figures it brings are rows in
-- marketplace_daily_observations tagged with the import. NOTHING is updated or deleted by an import.
-- What the app reads is a VIEW: for each (day, channel) the figures of the newest ACCEPTED import.
-- plan = insert a 'staged' run plus its observations (inert: the view ignores them); apply = flip the run to
-- 'accepted' (one statement, atomic); undo = flip it to 'superseded' and the view falls back by itself.

create table if not exists public.import_runs (
  import_id        uuid primary key default gen_random_uuid(),
  report_type      text not null check (report_type in ('sales_overview', 'product_overview', 'traffic', 'sku_detail', 'ads')),
  channel          text not null default 'shopee' check (channel in ('shopee', 'lazada')),
  period_from      date not null,                       -- first PH day the file covers
  period_to        date not null,                       -- last PH day it covers
  source_filename  text not null,
  sha256           text not null,                       -- of the file as received
  exported_at      timestamptz,                         -- when Shopee produced the file, when the file says so
  row_count        integer not null default 0,
  status           text not null default 'staged' check (status in ('staged', 'accepted', 'rejected', 'superseded')),
  checks           jsonb not null default '{}'::jsonb,  -- the gate results and, for a rejected file, the reasons
  plan             jsonb,                               -- the preview shown to the person, and the figures it was made against (apply refuses if those moved)
  note             text,                                -- the reason for a restate or an undo
  restated         boolean not null default false,
  imported_by      text,
  imported_at      timestamptz not null default now(),
  accepted_at      timestamptz,
  raw_path         text                                 -- storage object of the original file, once stored
);
-- A file can be planned again and again (each plan is a new staged run) but accepted only once.
create unique index if not exists import_runs_accepted_file_uq on public.import_runs (report_type, channel, sha256) where status = 'accepted';
create index if not exists import_runs_status_idx on public.import_runs (status, period_from);

create table if not exists public.marketplace_daily_observations (
  import_id          uuid    not null references public.import_runs (import_id),
  day                date    not null,                  -- PH calendar day
  channel            text    not null check (channel in ('shopee', 'lazada')),
  sales_placed       numeric(12, 2) not null,
  sales_confirmed    numeric(12, 2) not null,
  orders_placed      integer not null,
  orders_confirmed   integer not null,
  units_placed       integer not null,
  units_confirmed    integer not null,
  buyers_placed      integer,
  buyers_confirmed   integer,
  visitors           integer,
  primary key (import_id, day, channel)
);
create index if not exists marketplace_daily_observations_day_idx on public.marketplace_daily_observations (day, channel);

-- The earlier plain table marketplace_daily_sales (backend PR #47) was never filled. It is replaced by a view of the
-- same name and columns, so the Sales page reader and the Ask Coop view keep working unchanged. Refuses to drop a
-- table that has rows.
drop view if exists public.coop_chat_marketplace_daily;
do $$
begin
  if exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'marketplace_daily_sales' and table_type = 'BASE TABLE') then
    if (select count(*) from public.marketplace_daily_sales) > 0 then
      raise exception 'marketplace_daily_sales has rows: not dropping it. Move them first.';
    end if;
    drop table public.marketplace_daily_sales;
  end if;
end $$;

create or replace view public.marketplace_daily_sales as
  select distinct on (o.day, o.channel)
    o.day,
    o.channel,
    o.sales_confirmed                                  as revenue,        -- the basis for totals (what the digests use)
    o.orders_confirmed                                 as orders,
    o.units_confirmed                                  as units,
    (r.period_from::timestamp at time zone 'Asia/Manila')                          as window_from,  -- the import's own dates
    ((r.period_to + 1)::timestamp at time zone 'Asia/Manila')                      as window_to,
    r.accepted_at                                      as captured_at,
    o.sales_placed, o.orders_placed, o.units_placed,
    o.buyers_placed, o.buyers_confirmed, o.visitors,
    r.import_id,
    (o.day > (now() at time zone 'Asia/Manila')::date - 28) as provisional     -- recent days may still be restated
  from public.marketplace_daily_observations o
  join public.import_runs r using (import_id)
  where r.status = 'accepted'
  order by o.day, o.channel, r.exported_at desc nulls last, r.accepted_at desc;

-- Ask Coop's one door to the daily figures (see supabase/coop_chat_marketplace_daily.sql): recreated over the view.
create or replace view public.coop_chat_marketplace_daily as
  select day, channel, revenue, orders, units, window_from, window_to, captured_at
  from public.marketplace_daily_sales;
revoke all on public.coop_chat_marketplace_daily from public, anon, authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'coop_chat_ro') then
    grant select on public.coop_chat_marketplace_daily to coop_chat_ro;
  end if;
end $$;

-- RLS on with NO policies = service role only. The views run as their owner.
alter table public.import_runs enable row level security;
alter table public.marketplace_daily_observations enable row level security;
revoke all on public.marketplace_daily_sales from anon, authenticated;

notify pgrst, 'reload schema';
