-- BHR-06 one-off (owner correction 2026-11-06): where the Business Plan sheet itemises a cost, Coop types each sheet row as its own line and computes
-- the total. Overhead = rows 33-38 (salaries, rent, accounting, tech, growth_consultant, rnd), COGS = rows 52-54 (marketplace_cogs, website_cogs,
-- events_cogs), content and other = rows 69-70 (content_socials, other_spend). The totals overhead, cogs and content_other are no longer typed
-- (plan_set_actual rejects them) and the breakdown modal and its RPC plan_set_actual_parts are retired.
-- This moves what was typed: a parent total whose saved breakdown (plan_actual_parts) has every part and adds up to it is split into one plan_actuals
-- row per part (logged 'edit', actor 'itemise'), then the parent row is deleted (logged 'clear'; its parts go with it, FK cascade). A total typed
-- WITHOUT a breakdown cannot be split: it is kept untouched (no longer read, so its rows and total wait) and named in a NOTICE so an admin types the rows.
-- A row already typed is never overwritten. Same per-month lock as the RPCs. Lossless, so it also runs in a closed month (the total is unchanged).
-- Idempotent: a second run finds nothing to split. Apply by hand per environment AFTER supabase/plan_report.sql and supabase/plan_actual_parts.sql.
-- Never prints a value.
--
-- CLOSED MONTHS (review M6): a kept total-only row in a CLOSED month leaves its total (row 39 / 55 / 71) waiting, and with it every later month's cash,
-- because a closed month cannot be retyped. This file does not unlock anything. Run the preflight below FIRST (read-only, counts only, no value). If it
-- returns more than 0, an admin unlocks each named month with a reason (the page's Unlock), types its itemised rows, and closes it again.
-- PREFLIGHT BEGIN
-- select count(distinct a.month) as closed_months, count(*) as total_only_rows
-- from public.plan_actuals a
-- join public.plan_month_closes c on c.month = a.month
-- where a.metric in ('overhead', 'cogs', 'content_other')
--   and not coalesce((
--     select count(*) = (case a.metric when 'overhead' then 6 when 'cogs' then 3 else 2 end) and sum(p.amount_php) = a.amount_php
--     from public.plan_actual_parts p where p.month = a.month and p.metric = a.metric), false);
-- PREFLIGHT END
-- To list them: same query with `select a.month, a.metric ... order by 1, 2` in place of the counts.
do $$
declare
  r record;
  want text[];
  have int;
  sum_parts numeric;
  split int := 0;
  kept int := 0;
begin
  for r in select month, metric, amount_php from public.plan_actuals where metric in ('overhead', 'cogs', 'content_other') order by month, metric loop
    want := case r.metric
      when 'overhead' then array['salaries','rent','accounting','tech','growth_consultant','rnd']
      when 'cogs' then array['marketplace_cogs','website_cogs','events_cogs']
      else array['content_socials','other_spend'] end;
    perform pg_advisory_xact_lock(hashtext('plan_month:' || r.month::text));
    select count(*), coalesce(sum(amount_php), 0) into have, sum_parts from public.plan_actual_parts
      where month = r.month and metric = r.metric and part = any (want);
    if have <> array_length(want, 1) or sum_parts <> r.amount_php
       or exists (select 1 from public.plan_actuals a where a.month = r.month and a.metric = any (want)) then
      kept := kept + 1;
      raise notice 'kept % % : typed as a total without a full breakdown (or its rows are already typed); type its itemised rows', r.month, r.metric;
      continue;
    end if;
    insert into public.plan_actuals (month, metric, amount_php, updated_by, updated_at)
      select p.month, p.part, p.amount_php, 'itemise', now() from public.plan_actual_parts p where p.month = r.month and p.metric = r.metric and p.part = any (want);
    insert into public.plan_actuals_log (actor, month, metric, action, old_value, new_value, reason)
      select 'itemise', p.month, p.part, 'edit', null, p.amount_php, 'itemised from the ' || r.metric || ' breakdown (BHR-06)' from public.plan_actual_parts p where p.month = r.month and p.metric = r.metric and p.part = any (want);
    delete from public.plan_actuals where month = r.month and metric = r.metric;
    insert into public.plan_actuals_log (actor, month, metric, action, old_value, new_value, reason)
      values ('itemise', r.month, r.metric, 'clear', r.amount_php, null, 'total now computed from its itemised rows (BHR-06)');
    split := split + 1;
  end loop;
  raise notice 'itemised totals: % split into their rows, % kept (type their rows)', split, kept;
end $$;

drop function if exists public.plan_set_actual_parts(date, text, jsonb, numeric, text);
