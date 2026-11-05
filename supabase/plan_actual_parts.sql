-- Business Health Report: the BREAKDOWN of the three consolidated typed lines (Fixed overhead, COGS, Content and other).
-- Run by hand per environment AFTER supabase/plan_report.sql. Idempotent: running it twice changes nothing.
-- Design: the cell still stores ONE number, the sum, in plan_actuals (so the grid, the derived margins, the cash chain, the close gate and the
-- workbook-equality test read the total exactly as before). The parts live beside it in plan_actual_parts, one row per part.
-- Stale-parts rule: a total typed directly (plan_set_actual) never touches the parts; the reader treats parts as valid only while they still sum
-- to the total (src/plan-parts.ts consistentParts), so the modal can never show parts that do not add up. Clearing the cell deletes its parts (FK cascade).
-- RLS ON, no policies, no privileges for anon / authenticated: service role only, like every plan table.

create table if not exists public.plan_actual_parts (
  month       date    not null,
  metric      text    not null check (metric in ('overhead', 'cogs', 'content_other')),
  part        text    not null,
  amount_php  numeric not null check (amount_php >= 0),
  updated_by  text,
  updated_at  timestamptz not null default now(),
  primary key (month, metric, part),
  foreign key (month, metric) references public.plan_actuals (month, metric) on delete cascade
);
alter table public.plan_actual_parts enable row level security;
revoke all on public.plan_actual_parts from anon, authenticated;

-- Save a breakdown: ONE transaction validates the parts, sums them, upserts the parent total in plan_actuals, replaces the parts, and writes the change log.
-- Same rules as plan_set_actual: service role only (the server action re-checks the editor), per-month advisory lock, compare-and-set on the TOTAL
-- (p_expected = the total the page last showed, null = the cell was empty -> 'stale_value'), a closed month is locked ('month_closed'), never negative.
-- p_parts is a json object {part: pesos} and must hold EVERY part of the line ('incomplete_parts'); a part that is not in the line is 'invalid_part'.
create or replace function public.plan_set_actual_parts(p_month date, p_line text, p_parts jsonb, p_expected numeric, p_by text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  want text[];
  k text;
  v numeric;
  total numeric := 0;
  cur numeric;
  ts timestamptz := now();
begin
  want := case p_line
    when 'overhead' then array['salaries','rent','accounting','tech','growth_consultant','rnd']
    when 'cogs' then array['marketplace_cogs','website_cogs','events_cogs']
    when 'content_other' then array['content_socials','other_spend']
  end;
  if want is null then raise exception 'invalid_line'; end if;
  if p_month is null or p_month <> date_trunc('month', p_month)::date then raise exception 'invalid_month'; end if;
  if p_parts is null or jsonb_typeof(p_parts) <> 'object' then raise exception 'incomplete_parts'; end if;
  for k in select jsonb_object_keys(p_parts) loop
    if not (k = any (want)) then raise exception 'invalid_part'; end if;
  end loop;
  foreach k in array want loop
    if jsonb_typeof(p_parts -> k) is distinct from 'number' then raise exception 'incomplete_parts'; end if;
    v := (p_parts ->> k)::numeric;
    if v < 0 then raise exception 'negative_cost'; end if;
    total := total + v;
  end loop;

  perform pg_advisory_xact_lock(hashtext('plan_month:' || p_month::text));
  if exists (select 1 from plan_month_closes where month = p_month) then raise exception 'month_closed'; end if;

  select amount_php into cur from plan_actuals where month = p_month and metric = p_line;
  if cur is distinct from p_expected then raise exception 'stale_value'; end if;

  insert into plan_actuals (month, metric, amount_php, updated_by, updated_at, source) values (p_month, p_line, total, p_by, ts, null)
  on conflict (month, metric) do update set amount_php = excluded.amount_php, updated_by = excluded.updated_by, updated_at = excluded.updated_at, source = null;
  delete from plan_actual_parts where month = p_month and metric = p_line;
  insert into plan_actual_parts (month, metric, part, amount_php, updated_by, updated_at)
    select p_month, p_line, e.key, e.value::numeric, p_by, ts from jsonb_each_text(p_parts) e;
  insert into plan_actuals_log (at, actor, month, metric, action, old_value, new_value, reason) values (ts, p_by, p_month, p_line, 'edit', cur, total, 'breakdown: ' || p_parts::text);
  return jsonb_build_object('changed', true, 'amount', total, 'updated_at', ts);
end;
$$;
revoke all on function public.plan_set_actual_parts(date, text, jsonb, numeric, text) from public, anon, authenticated;
grant execute on function public.plan_set_actual_parts(date, text, jsonb, numeric, text) to service_role;
