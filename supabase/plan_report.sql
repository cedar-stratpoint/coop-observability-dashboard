-- Business Health Report (plan vs actual): tables (BHR-01) and the write RPCs (typed lines BHR-03; close and unlock BHR-04; target edit as a new plan version BHR-05).
-- Run by hand per environment in the Supabase SQL editor, then supabase/plan_actual_parts.sql and supabase/plan_part_targets.sql. The targets are loaded privately by scripts/seed-plan-from-workbook.mjs (the repo is public and holds no plan figure). Idempotent.
-- Design: knowledge/best-practices/plan-versions-and-locked-actuals.md. Money is stored in pesos.
-- RLS is ON with NO policies on every table: only the service role (Coop server-side) gets through. Never add an anon policy.

-- A plan version is an append-only snapshot: a target edit inserts a new version, nothing is updated in place.
create table if not exists public.plan_versions (
  id          bigint generated always as identity primary key,
  label       text not null unique,
  reason      text,
  created_by  text,
  created_at  timestamptz not null default now()
);

-- Targets for one version, one row per (month, metric). `value` is pesos for money, a ratio for percentages (0.65 = 65%), a plain number otherwise.
create table if not exists public.plan_targets (
  plan_version bigint not null references public.plan_versions(id) on delete restrict,
  month        date   not null,                 -- first day of the month
  metric       text   not null,
  value        numeric not null,
  note         text,
  primary key (plan_version, month, metric),
  check (month = date_trunc('month', month)::date)
);

-- Typed monthly lines (BHR-03): the workbook's input rows (overhead, COGS, fees, fulfilment, event costs, ad spends, stock bought, funding, one-time payments, ROAS). Empty until an admin types them.
create table if not exists public.plan_actuals (
  month       date not null,
  metric      text not null,
  amount_php  numeric not null,
  updated_by  text,
  updated_at  timestamptz not null default now(),
  primary key (month, metric),
  check (month = date_trunc('month', month)::date)
);

-- Provenance of a PREFILLED cell: 'workbook' = a fact from the Cedar Tree workbook, 'owner' = also confirmed by the owner. Null = typed by an admin (an admin save always clears it).
alter table public.plan_actuals add column if not exists source text check (source in ('workbook', 'owner'));

-- A closed month is a row, not a flag (BHR-04). It remembers the plan version it closed under and a snapshot of the GMV actuals,
-- because GMV is computed at read time. The version cannot be deleted while a closed month points at it.
create table if not exists public.plan_month_closes (
  month         date primary key,
  plan_version  bigint not null references public.plan_versions(id) on delete restrict,
  closed_by     text not null,
  closed_at     timestamptz not null default now(),
  gmv_snapshot  jsonb not null default '{}'::jsonb,
  check (month = date_trunc('month', month)::date)
);

-- Change log (BHR-03/04): written in the same transaction as the change, by the RPCs.
create table if not exists public.plan_actuals_log (
  id         bigint generated always as identity primary key,
  at         timestamptz not null default now(),
  actor      text not null,
  month      date,
  metric     text,
  action     text not null,
  old_value  numeric,
  new_value  numeric,
  reason     text
);
create index if not exists plan_actuals_log_month_idx on public.plan_actuals_log (month, at desc);

-- BHR-05 first shipped a free-form dated-entries ledger (plan_dated_entries). The workbook has one monthly number per row instead (rows 87, 88, 89 and the
-- stock bought), so those are now typed lines in plan_actuals (see plan_set_actual below) and the ledger is dropped. It held no real data. Idempotent.
drop table if exists public.plan_dated_entries;

alter table public.plan_versions      enable row level security;
alter table public.plan_targets       enable row level security;
alter table public.plan_actuals       enable row level security;
alter table public.plan_month_closes  enable row level security;
alter table public.plan_actuals_log   enable row level security;

-- Belt and braces on top of RLS: the anon and authenticated roles get no table privilege at all.
revoke all on public.plan_versions, public.plan_targets, public.plan_actuals, public.plan_month_closes, public.plan_actuals_log from anon, authenticated;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- BHR-03: save one typed monthly line. ONE function = ONE transaction: the change and its change-log row commit together or not at all.
-- SECURITY DEFINER and callable only by the service role: the server action (src/plan-actions.ts) re-reads the caller's memberships first.
-- Compare-and-set: the caller passes the value it last saw (p_expected, null = the cell was empty). Under a per-month advisory lock the
-- current value is compared; a different one means someone else saved first -> 'stale_value', nothing written. The lock also means a log
-- row can never carry a stale old value, however two admins interleave (BHR-04 close and unlock take the same lock).
-- p_amount null clears the cell (missing again). Only the workbook's INPUT rows are saved here: the 13 typed lines (overhead, bridge_funding = row 87,
-- liability_settlement = row 88, freight_onetime = row 89, inv_purchases_paid = the stock bought rows 41 / 82, cogs, platform_fees, fulfilment, event_costs,
-- ad_marketplace, ad_website, event_marketing, content_other), in pesos, never negative, plus the optional ROAS (a multiple; workbook row 9 is an input).
-- Cash, CAC, active customers and inventory coverage are formulas in the workbook, so they are DERIVED in the app and rejected here (invalid_line).
-- opening_cash (the bank balance at the start of the first plan month; the workbook has no such cell) is the one value that may be negative and is only accepted for the first plan month; derived cash starts from it.
-- opening_inventory (workbook row 44, pesos) and opening_customers (row 120, a count) are also first-month-only and never negative; a save by an admin clears the cell's prefill tag (source).
-- ROAS and opening cash are not required to close a month (plan_close_month counts the 13 lines), but a close locks them and an unlock logs them. CREATE OR REPLACE makes re-running this file safe. Errors are plain message codes the action maps to words.
create or replace function public.plan_set_actual(p_month date, p_metric text, p_amount numeric, p_expected numeric, p_by text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  cur numeric;
  had boolean;
  ts  timestamptz := now();
begin
  if p_metric is null or p_metric not in ('overhead','cogs','platform_fees','fulfilment','event_costs','ad_marketplace','ad_website','event_marketing','content_other','roas','bridge_funding','liability_settlement','freight_onetime','inv_purchases_paid','opening_cash','opening_inventory','opening_customers') then
    raise exception 'invalid_line';
  end if;
  if p_month is null or p_month <> date_trunc('month', p_month)::date then raise exception 'invalid_month'; end if;
  -- every line is a cost, a payment or an inflow: never negative. The one exception is the opening cash, a bank balance that can be overdrawn.
  if p_amount is not null and p_amount < 0 and p_metric <> 'opening_cash' then raise exception 'negative_cost'; end if;
  -- The opening cash is the balance at the start of the FIRST plan month, so it lives on that month only.
  if p_metric in ('opening_cash','opening_inventory','opening_customers') and p_month is distinct from (select min(month) from plan_targets) then raise exception 'invalid_line'; end if;

  perform pg_advisory_xact_lock(hashtext('plan_month:' || p_month::text));
  if exists (select 1 from plan_month_closes where month = p_month) then raise exception 'month_closed'; end if;

  select amount_php into cur from plan_actuals where month = p_month and metric = p_metric;
  had := found;
  if cur is distinct from p_expected then raise exception 'stale_value'; end if;
  if (not had and p_amount is null) or (had and cur = p_amount) then
    return jsonb_build_object('changed', false, 'amount', cur);
  end if;

  if p_amount is null then
    delete from plan_actuals where month = p_month and metric = p_metric;
  else
    insert into plan_actuals (month, metric, amount_php, updated_by, updated_at, source) values (p_month, p_metric, p_amount, p_by, ts, null)
    on conflict (month, metric) do update set amount_php = excluded.amount_php, updated_by = excluded.updated_by, updated_at = excluded.updated_at, source = null;
  end if;
  insert into plan_actuals_log (at, actor, month, metric, action, old_value, new_value) values (ts, p_by, p_month, p_metric, case when p_amount is null then 'clear' else 'edit' end, cur, p_amount);
  return jsonb_build_object('changed', true, 'amount', p_amount, 'updated_at', ts);
end;
$$;
revoke all on function public.plan_set_actual(date, text, numeric, numeric, text) from public, anon, authenticated;
grant execute on function public.plan_set_actual(date, text, numeric, numeric, text) to service_role;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- One-time workbook PREFILL of known actuals (scripts/seed-plan-from-workbook.mjs calls this). Actual data only, tagged with its source. It NEVER overwrites:
-- a cell that already has a value, a cell an admin has ever saved or cleared (any log row for the month and line, so a cleared prefill is not brought back), or a closed month.
-- Returns {seeded: false} in those cases, so running it twice changes nothing. Only the three prefillable lines are accepted; the opening balances only for the first plan month.
-- Service role only, like the other RPCs: a non-admin can reach no write path.
create or replace function public.plan_seed_actual(p_month date, p_metric text, p_amount numeric, p_source text, p_by text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare ts timestamptz := now();
begin
  if p_metric is null or p_metric not in ('opening_inventory','opening_customers','bridge_funding') then raise exception 'invalid_line'; end if;
  if p_source is null or p_source not in ('workbook','owner') then raise exception 'invalid_source'; end if;
  if p_month is null or p_month <> date_trunc('month', p_month)::date then raise exception 'invalid_month'; end if;
  if p_amount is null or p_amount < 0 then raise exception 'negative_cost'; end if;
  if p_metric in ('opening_inventory','opening_customers') and p_month is distinct from (select min(month) from plan_targets) then raise exception 'invalid_line'; end if;
  perform pg_advisory_xact_lock(hashtext('plan_month:' || p_month::text));
  if exists (select 1 from plan_month_closes where month = p_month)
     or exists (select 1 from plan_actuals where month = p_month and metric = p_metric)
     or exists (select 1 from plan_actuals_log where month = p_month and metric = p_metric) then
    return jsonb_build_object('seeded', false);
  end if;
  insert into plan_actuals (month, metric, amount_php, updated_by, updated_at, source) values (p_month, p_metric, p_amount, p_by, ts, p_source);
  insert into plan_actuals_log (at, actor, month, metric, action, new_value, reason) values (ts, p_by, p_month, p_metric, 'seed', p_amount, 'prefilled (' || p_source || ')');
  return jsonb_build_object('seeded', true, 'amount', p_amount);
end;
$$;
revoke all on function public.plan_seed_actual(date, text, numeric, text, text) from public, anon, authenticated;
grant execute on function public.plan_seed_actual(date, text, numeric, text, text) to service_role;

-- ---------------------------------------------------------------------------------------------------------------------------------
-- BHR-04: close a month, and unlock it with a reason. Same rules as plan_set_actual: one function = one transaction, the same per-month
-- advisory lock (so a close, an unlock and an edit of one month never interleave and no log row carries a stale value), service role only.
-- p_gmv is the month's GMV actuals the server action computed at close time ({gmv_events: {value, state}, ...}); it is stored with the close so
-- a closed month reads its GMV from the snapshot, never live. Closing needs all 13 typed lines to hold a value (a typed 0 counts). A re-close takes a
-- new snapshot and records the plan version current THEN. A close also needs every earlier plan month closed first ('earlier_month_open') and the month to be over (Manila) and all three GMV channels complete in p_gmv ('month_not_over', 'gmv_incomplete'). The month's lines are locked because plan_set_actual rejects a closed month.
create or replace function public.plan_close_month(p_month date, p_by text, p_gmv jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v bigint;
  n int;
  ts timestamptz := now();
begin
  if p_month is null or p_month <> date_trunc('month', p_month)::date then raise exception 'invalid_month'; end if;
  if p_gmv is null or jsonb_typeof(p_gmv) <> 'object' then raise exception 'invalid_snapshot'; end if;
  -- Close gate: the month must be OVER in Manila time (the current month and the future cannot be closed), and the snapshot the server action took must show all three
  -- GMV channels complete (state 'ok' with a number): a partial or empty channel would freeze an understated month.
  if p_month >= date_trunc('month', (now() at time zone 'Asia/Manila'))::date then raise exception 'month_not_over'; end if;
  if exists (
    select 1 from unnest(array['gmv_events','gmv_website','gmv_marketplace']) as ch
    where coalesce(p_gmv->ch->>'state', '') <> 'ok' or jsonb_typeof(p_gmv->ch->'value') is distinct from 'number'
  ) then raise exception 'gmv_incomplete'; end if;
  perform pg_advisory_xact_lock(hashtext('plan_month:' || p_month::text));
  if exists (select 1 from plan_month_closes where month = p_month) then raise exception 'already_closed'; end if;
  -- Oldest first: cash chains month to month, so no plan month before this one may still be open. Any earlier plan month is already over, so "earlier and not closed" is the whole test.
  if exists (select 1 from plan_targets t where t.month < p_month and not exists (select 1 from plan_month_closes c where c.month = t.month)) then raise exception 'earlier_month_open'; end if;
  select count(*) into n from plan_actuals
    where month = p_month and metric in ('overhead','bridge_funding','liability_settlement','freight_onetime','inv_purchases_paid','cogs','platform_fees','fulfilment','event_costs','ad_marketplace','ad_website','event_marketing','content_other');
  if n < 13 then raise exception 'month_incomplete'; end if;
  select max(id) into v from plan_versions;
  if v is null then raise exception 'no_plan_version'; end if;
  insert into plan_month_closes (month, plan_version, closed_by, closed_at, gmv_snapshot) values (p_month, v, p_by, ts, p_gmv);
  insert into plan_actuals_log (at, actor, month, action) values (ts, p_by, p_month, 'close');
  return jsonb_build_object('plan_version', v, 'closed_at', ts);
end;
$$;
revoke all on function public.plan_close_month(date, text, jsonb) from public, anon, authenticated;
grant execute on function public.plan_close_month(date, text, jsonb) to service_role;

-- Unlock needs a reason (blank is rejected). The close row is deleted and the log row written in the same transaction: if the log cannot be
-- written the month stays closed. The month then needs Close month again.
create or replace function public.plan_unlock_month(p_month date, p_reason text, p_by text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare ts timestamptz := now();
begin
  if p_reason is null or btrim(p_reason) = '' then raise exception 'reason_required'; end if;
  perform pg_advisory_xact_lock(hashtext('plan_month:' || p_month::text));
  if not exists (select 1 from plan_month_closes where month = p_month) then raise exception 'not_closed'; end if;
  insert into plan_actuals_log (at, actor, month, action, reason) values (ts, p_by, p_month, 'unlock', btrim(p_reason));
  delete from plan_month_closes where month = p_month;
  return jsonb_build_object('unlocked_at', ts);
end;
$$;
revoke all on function public.plan_unlock_month(date, text, text) from public, anon, authenticated;
grant execute on function public.plan_unlock_month(date, text, text) to service_role;


-- ---------------------------------------------------------------------------------------------------------------------------------
-- BHR-05: change future-month targets as a NEW plan version. Append-only: the newest version is copied, the edited cells replaced, and the
-- result inserted as a new version (who, when, reason). Old versions and their targets are never touched, so a closed month keeps being judged
-- against the version recorded at its close. p_changes is a json array of {month, metric, value} (pesos for money, a ratio for percentages).
-- Rules, all raised as plain codes: a reason is required; the caller must have seen the newest version (p_expected_version, else
-- 'stale_version'); a closed month and a month before the current Manila month are rejected; Total GMV is calculated, never typed (it is
-- re-summed from the three channels for every month touched); an unknown cell is rejected. One global advisory lock serialises two editors.
create or replace function public.plan_edit_targets(p_changes jsonb, p_reason text, p_by text, p_expected_version bigint)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  cur_ver bigint;
  new_ver bigint;
  ts timestamptz := now();
  this_month date := date_trunc('month', (now() at time zone 'Asia/Manila'))::date;
  c jsonb;
  m date;
  mt text;
  val numeric;
  n int := 0;
  touched date[] := '{}';
begin
  if p_reason is null or btrim(p_reason) = '' then raise exception 'reason_required'; end if;
  if p_changes is null or jsonb_typeof(p_changes) <> 'array' or jsonb_array_length(p_changes) = 0 then raise exception 'no_changes'; end if;

  perform pg_advisory_xact_lock(hashtext('plan_versions'));
  select max(id) into cur_ver from plan_versions;
  if cur_ver is null then raise exception 'no_plan_version'; end if;
  if p_expected_version is distinct from cur_ver then raise exception 'stale_version'; end if;

  -- Validate every change before writing anything.
  for c in select * from jsonb_array_elements(p_changes) loop
    if jsonb_typeof(c) <> 'object' or jsonb_typeof(c->'value') <> 'number' then raise exception 'invalid_change'; end if;
    mt := c->>'metric';
    val := (c->>'value')::numeric;
    begin m := (c->>'month')::date; exception when others then raise exception 'invalid_month'; end;
    if m is null or m <> date_trunc('month', m)::date then raise exception 'invalid_month'; end if;
    if mt = 'gmv_total' then raise exception 'calculated_target'; end if;
    -- Only workbook INPUT targets may be typed. Every derived or cost-line target (CM, EBITDA, cash, coverage, customers, CAC, the cost lines) is a workbook formula result: never typed.
    if mt not in ('gmv_events','gmv_website','gmv_marketplace','overhead','roas') then
      if exists (select 1 from plan_targets where plan_version = cur_ver and metric = mt) then raise exception 'derived_target'; end if;
    end if;
    if exists (select 1 from plan_month_closes where month = m) then raise exception 'month_closed'; end if;
    if m < this_month then raise exception 'past_month'; end if;
    if not exists (select 1 from plan_targets where plan_version = cur_ver and month = m and metric = mt) then raise exception 'unknown_target'; end if;
    if abs(val) > 1e12 then raise exception 'invalid_change'; end if;
    n := n + 1;
    touched := touched || m;
  end loop;

  new_ver := nextval(pg_get_serial_sequence('public.plan_versions', 'id'));
  insert into plan_versions (id, label, reason, created_by, created_at)
    overriding system value
    values (new_ver, 'v' || new_ver || ' ' || to_char(ts at time zone 'Asia/Manila', 'YYYY-MM-DD'), btrim(p_reason), p_by, ts);
  insert into plan_targets (plan_version, month, metric, value, note)
    select new_ver, month, metric, value, note from plan_targets where plan_version = cur_ver;
  for c in select * from jsonb_array_elements(p_changes) loop
    update plan_targets set value = (c->>'value')::numeric
      where plan_version = new_ver and month = (c->>'month')::date and metric = c->>'metric';
  end loop;
  -- Total GMV is the sum of its three channels, re-summed for each month touched.
  update plan_targets t set value = s.total
    from (select month, sum(value) as total from plan_targets
          where plan_version = new_ver and metric in ('gmv_events','gmv_website','gmv_marketplace') and month = any (touched) group by month) s
    where t.plan_version = new_ver and t.metric = 'gmv_total' and t.month = s.month;
  return jsonb_build_object('plan_version', new_ver, 'changes', n, 'created_at', ts);
end;
$$;
revoke all on function public.plan_edit_targets(jsonb, text, text, bigint) from public, anon, authenticated;
grant execute on function public.plan_edit_targets(jsonb, text, text, bigint) to service_role;
