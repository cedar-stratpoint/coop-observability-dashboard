-- F11 · Restock recommendations (Nichido project). Additive and safe to re-run.
-- Run on Nichido STAGING (Nichido-Supabase-Staging) first; PROD after review. Needs p3_forecast.sql.
--
-- Decided Oct 26 (meeting) and Oct 28:
--   • Send = last year's window − (on hand + on the way) + last year's safety months, 0 when
--     covered. The math is in src/goldline-restock.ts; this file only stores its result.
--   • A suggestion never exceeds the warehouse: when the stores together want more of an item
--     than warehouse_stock holds, each store's line is scaled down in proportion
--     (warehouse_short = true, raw_send keeps the uncapped number).
--   • A run is a snapshot, made by an admin, one per half month (cycle '2026-10-b'). Making
--     it again replaces the lines still pending and keeps every decided one.
--   • The owner approves as is, edits (remark), or rejects (remark). Score per store =
--     approved ÷ decided. Remarks are kept for later learning (not in v1).
--   • Only lines for in-scope stores with a counted form are saved. Stores held for no
--     count or out of scope are kept as totals in restock_runs.skipped (tens of thousands
--     of pairs otherwise, nearly all waiting for a first form).
--
--   restock_runs              one row per company and cycle.
--   recommendations           one row per run × store × item, with the working.
--   save_restock_run()        the run and its pending lines in one transaction.
--   decide_recommendations()  approve, edit, reject or undo, fenced to company and stores.

create table if not exists public.restock_runs (
  id             uuid primary key default gen_random_uuid(),
  company_id     text not null references public.companies(id) on delete cascade,
  cycle          text not null check (cycle ~ '^\d{4}-\d{2}-[ab]$'),
  run_date       date not null,
  months         text[] not null,        -- the months the run covers (YYYY-MM)
  last_year      text[] not null,        -- the same months a year earlier
  window_months  integer not null,
  safety_months  integer not null,
  skipped        jsonb not null default '{}'::jsonb, -- {"no_count": {"stores": n, "lines": n}, "out_of_scope": {…}}
  created_by     text,
  created_at     timestamptz not null default now(),
  updated_by     text,
  updated_at     timestamptz not null default now(),
  unique (company_id, cycle)
);
alter table public.restock_runs enable row level security;
revoke all on public.restock_runs from anon, authenticated;

create table if not exists public.recommendations (
  id                 uuid primary key default gen_random_uuid(),
  run_id             uuid not null references public.restock_runs(id) on delete cascade,
  company_id         text not null references public.companies(id) on delete cascade,
  store_code         text not null,
  item_code          text not null,
  ly_units           integer[] not null,  -- last year's units per window month
  need               integer,             -- their total (null when held for a missing month)
  safety             integer,
  on_hand            integer,             -- the store's latest count
  on_hand_period_end date,
  on_the_way         integer not null default 0,
  raw_send           integer,             -- before the warehouse cap
  suggested          integer,             -- Coop's number (null = check data first)
  warehouse_short    boolean not null default false,
  holds              text[] not null default '{}',
  decision           text not null default 'pending' check (decision in ('pending', 'approved', 'edited', 'rejected')),
  final_qty          integer check (final_qty is null or final_qty >= 0),
  remark             text,
  decided_by         text,
  decided_at         timestamptz,
  created_at         timestamptz not null default now(),
  unique (run_id, store_code, item_code),
  constraint recommendations_remark check (decision not in ('edited', 'rejected') or nullif(btrim(remark), '') is not null),
  constraint recommendations_decided check (decision = 'pending' or (final_qty is not null and decided_at is not null))
);
create index if not exists recommendations_run_idx on public.recommendations (company_id, run_id, decision);
create index if not exists recommendations_store_idx on public.recommendations (company_id, store_code, decided_at);
alter table public.recommendations enable row level security;
revoke all on public.recommendations from anon, authenticated;

-- Upsert the run by cycle, drop its pending lines, insert the fresh ones. A pair that was
-- already decided keeps its decision and its numbers (on conflict do nothing).
-- p_lines: [{store_code, item_code, ly_units, need, safety, on_hand, on_hand_period_end,
--            on_the_way, raw_send, suggested, warehouse_short, holds}, …]
create or replace function public.save_restock_run(
  p_company text, p_cycle text, p_run_date date, p_months text[], p_last_year text[],
  p_window integer, p_safety integer, p_skipped jsonb, p_lines jsonb, p_by text
) returns uuid
language plpgsql security invoker set search_path = public
as $$
declare
  v_id uuid;
begin
  insert into restock_runs (company_id, cycle, run_date, months, last_year, window_months, safety_months, skipped, created_by, updated_by)
  values (p_company, p_cycle, p_run_date, p_months, p_last_year, p_window, p_safety, coalesce(p_skipped, '{}'::jsonb), p_by, p_by)
  on conflict (company_id, cycle) do update
    set run_date = excluded.run_date, months = excluded.months, last_year = excluded.last_year,
        window_months = excluded.window_months, safety_months = excluded.safety_months,
        skipped = excluded.skipped, updated_by = p_by, updated_at = now()
  returning id into v_id;

  delete from recommendations where run_id = v_id and decision = 'pending';

  insert into recommendations (run_id, company_id, store_code, item_code, ly_units, need, safety, on_hand,
                               on_hand_period_end, on_the_way, raw_send, suggested, warehouse_short, holds)
  select v_id, p_company, l.store_code, l.item_code,
         coalesce(array(select jsonb_array_elements_text(l.ly_units)::integer), '{}'),
         l.need, l.safety, l.on_hand, l.on_hand_period_end, coalesce(l.on_the_way, 0),
         l.raw_send, l.suggested, coalesce(l.warehouse_short, false),
         coalesce(array(select jsonb_array_elements_text(l.holds)), '{}')
  from jsonb_to_recordset(coalesce(p_lines, '[]'::jsonb)) as l(
    store_code text, item_code text, ly_units jsonb, need integer, safety integer, on_hand integer,
    on_hand_period_end date, on_the_way integer, raw_send integer, suggested integer,
    warehouse_short boolean, holds jsonb)
  on conflict (run_id, store_code, item_code) do nothing;

  return v_id;
end;
$$;
revoke all on function public.save_restock_run(text, text, date, text[], text[], integer, integer, jsonb, jsonb, text) from public, anon, authenticated;
grant execute on function public.save_restock_run(text, text, date, text[], text[], integer, integer, jsonb, jsonb, text) to service_role;

-- The owner's decision on lines with something to send (suggested > 0, no holds).
--   approved  final_qty = Coop's number (many lines at once)
--   edited    final_qty = p_qty, remark required; the same number as Coop's counts as approved
--   rejected  final_qty = 0, remark required
--   pending   undo: clears the decision
-- An edit can't ask for more than the warehouse holds. p_stores narrows to a store-scoped
-- role's stores (null = every store). Returns the number of lines changed.
create or replace function public.decide_recommendations(
  p_company text, p_ids uuid[], p_decision text, p_qty integer, p_remark text, p_by text, p_stores text[] default null
) returns integer
language plpgsql security invoker set search_path = public
as $$
declare
  v_remark text := nullif(btrim(coalesce(p_remark, '')), '');
  v_count  integer;
begin
  if p_decision not in ('approved', 'edited', 'rejected', 'pending') then raise exception 'bad_decision' using errcode = 'P0001'; end if;
  if p_decision in ('edited', 'rejected') and v_remark is null then raise exception 'remark_required' using errcode = 'P0001'; end if;
  if p_decision = 'edited' and (p_qty is null or p_qty < 0) then raise exception 'bad_qty' using errcode = 'P0001'; end if;
  if p_decision = 'edited' and coalesce(array_length(p_ids, 1), 0) <> 1 then raise exception 'edit_one' using errcode = 'P0001'; end if;
  if p_decision = 'edited' and exists (
    select 1 from recommendations r
    left join warehouse_stock w on w.company_id = r.company_id and w.item_code = r.item_code
    where r.company_id = p_company and r.id = any(p_ids) and p_qty > coalesce(w.on_hand, 0)
  ) then raise exception 'over_warehouse' using errcode = 'P0001'; end if;

  update recommendations r set
    decision   = case when p_decision = 'edited' and p_qty = r.suggested then 'approved' else p_decision end,
    final_qty  = case p_decision when 'approved' then r.suggested when 'edited' then p_qty when 'rejected' then 0 else null end,
    remark     = case when p_decision = 'pending' then null else v_remark end,
    decided_by = case when p_decision = 'pending' then null else p_by end,
    decided_at = case when p_decision = 'pending' then null else now() end
  where r.company_id = p_company
    and r.id = any(p_ids)
    and r.suggested > 0
    and r.holds = '{}'
    and (p_stores is null or r.store_code = any(p_stores));
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke all on function public.decide_recommendations(text, uuid[], text, integer, text, text, text[]) from public, anon, authenticated;
grant execute on function public.decide_recommendations(text, uuid[], text, integer, text, text, text[]) to service_role;
