-- BHR derived rows: cash, CAC, active customers and inventory coverage were typed monthly lines. The workbook computes all four by formula
-- (rows 90, 96, 113, 84), so Coop now derives them and plan_set_actual rejects them (plan_report.sql). Apply AFTER plan_report.sql.
-- Removes only the typed rows of those four metrics, each logged in plan_actuals_log (action 'clear', actor 'cleanup', the old value) under the same
-- per-month lock the RPCs take. A closed month is locked: its rows are kept and named in a NOTICE (the page no longer reads them). Idempotent: a second
-- run removes nothing. A closed month keeps its close row and GMV snapshot untouched. Never prints a value.
do $$
declare
  r record;
  removed int := 0;
  kept int := 0;
begin
  for r in select month, metric, amount_php from public.plan_actuals where metric in ('cash', 'cac', 'customers', 'coverage') order by month, metric loop
    perform pg_advisory_xact_lock(hashtext('plan_month:' || r.month::text));
    if exists (select 1 from public.plan_month_closes where month = r.month) then
      kept := kept + 1;
      raise notice 'kept % % : the month is closed (the value is no longer read)', r.month, r.metric;
      continue;
    end if;
    delete from public.plan_actuals where month = r.month and metric = r.metric;
    insert into public.plan_actuals_log (actor, month, metric, action, old_value, new_value, reason)
      values ('cleanup', r.month, r.metric, 'clear', r.amount_php, null, 'derived line removed: the workbook computes it by formula');
    removed := removed + 1;
  end loop;
  raise notice 'derived typed rows removed: %, kept in closed months: %', removed, kept;
end $$;
