-- BHR-06 one-off: the plan workbook holds TARGETS only (knowledge/lessons/plan-workbook-is-targets-only.md). The private loader once prefilled three
-- workbook values as ACTUALS (opening stock and opening customers, tagged 'workbook'; the Sep'26 bridge funding, tagged 'owner'). They are plan assumptions,
-- so this deletes every plan_actuals row still carrying either tag. An admin save always clears the tag, so a value an admin typed or corrected is never touched.
-- A closed month is locked: its row is kept and named in a NOTICE (unlock it with a reason, then clear the cell). Each removal is logged in plan_actuals_log
-- (action 'clear', actor 'cleanup', the old value) in the same transaction, under the same per-month lock the RPCs take. Idempotent: a second run removes nothing.
-- Apply by hand per environment AFTER supabase/plan_report.sql (which drops the prefill RPC), then reload the page. Never prints a value.
do $$
declare
  r record;
  removed int := 0;
  kept int := 0;
begin
  for r in select month, metric, amount_php from public.plan_actuals where source in ('workbook', 'owner') order by month, metric loop
    perform pg_advisory_xact_lock(hashtext('plan_month:' || r.month::text));
    if exists (select 1 from public.plan_month_closes where month = r.month) then
      kept := kept + 1;
      raise notice 'kept % % : the month is closed, unlock it with a reason and clear the cell', r.month, r.metric;
      continue;
    end if;
    delete from public.plan_actuals where month = r.month and metric = r.metric and source in ('workbook', 'owner');
    insert into public.plan_actuals_log (actor, month, metric, action, old_value, new_value, reason)
      values ('cleanup', r.month, r.metric, 'clear', r.amount_php, null, 'workbook prefill removed: the plan workbook holds targets only (BHR-06)');
    removed := removed + 1;
  end loop;
  raise notice 'workbook prefills removed: %, kept in closed months: %', removed, kept;
end $$;

drop function if exists public.plan_seed_actual(date, text, numeric, text, text);
