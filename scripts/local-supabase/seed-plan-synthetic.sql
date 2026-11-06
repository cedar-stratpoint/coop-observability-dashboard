-- LOCAL ONLY, idempotent. A SYNTHETIC plan version (made-up numbers, label `vSynthetic`) so the plan integration tests (npm run test:plan-local) have a
-- plan to run against on a clean database. The real plan is never in the repo: load it privately with scripts/seed-plan-from-workbook.mjs.
-- 17 plan months (Aug 2026 to Dec 2027) for every target metric the page knows. Total GMV is the sum of its three channels.
insert into public.plan_versions (label, reason, created_by) values ('vSynthetic', 'synthetic local test plan (made-up numbers)', 'seed')
on conflict (label) do nothing;

insert into public.plan_targets (plan_version, month, metric, value, note)
select v.id, m.month::date, k.metric,
  case k.metric
    when 'gmv_events' then 1000 * m.n when 'gmv_website' then 500 * m.n when 'gmv_marketplace' then 2000 * m.n
    when 'gmv_total' then 3500 * m.n
    when 'overhead' then 7000 when 'repeat_rate' then 0.1 when 'aov' then 400 when 'coverage' then 1.5 when 'roas' then 3
    else 100 * m.n
  end, null
from public.plan_versions v,
  (select g::date as month, row_number() over (order by g) as n from generate_series('2026-08-01'::date, '2027-12-01'::date, interval '1 month') g) m,
  (values ('gmv_total'), ('gmv_marketplace'), ('gmv_website'), ('gmv_events'), ('cm1'), ('cm1_pct'), ('cm2'), ('cm2_pct'), ('cm3'), ('cm3_pct'), ('overhead'),
          ('ebitda'), ('ebitda_pct'), ('cogs'), ('platform_fees'), ('fulfilment'), ('event_costs'), ('ad_marketplace'), ('ad_website'), ('event_marketing'),
          ('content_other'), ('bridge_funding'), ('liability_settlement'), ('freight_onetime'), ('inv_purchases'), ('cash'), ('roas'), ('cac'), ('customers'),
          ('coverage'), ('repeat_rate'), ('aov')) k(metric)
where v.label = 'vSynthetic'
on conflict (plan_version, month, metric) do nothing;
