-- LOCAL ONLY. Reference queries for the Ask Coop Explore golden set (spec 9.2). Each block is `-- @ref <key>` then ONE query. They read the
-- BASE pos_* / spin_wheel_leads tables as the superuser on the local database, written independently of the coop_explore_* views and of
-- the SQL the model writes, so a wrong view or a wrong model query cannot make its own expected answer. Dates are Manila days.
-- scripts/explore-golden-expected.mjs runs every block (local-only guard first) and prints/writes the result as JSON. Nothing here is a figure:
-- the figures are computed from the fictional fixture (scripts/coop-explore-fixture.sql) at run time and are never typed or committed.

-- @ref G01_pet_event
select e.name as event, coalesce(o.pet_type, 'untagged') as pet, count(*)::int as orders_count, sum(o.total)::numeric as revenue_php
from pos_orders o join pos_events e on e.event_id = o.event_id
where o.status is distinct from 'voided' and (e.name ~* 'sm aura' or e.name ~* 'circuit makati')
group by 1, 2 order by 1, 2;

-- @ref G01_leads
select * from (
  select e.name as event,
    (select count(*) from spin_wheel_leads l where (l.collected_at at time zone 'Asia/Manila')::date between e.starts_on and coalesce(e.ends_on, e.starts_on))::int as leads_count,
    (select count(*) from spin_wheel_leads l where (l.collected_at at time zone 'Asia/Manila')::date between e.starts_on and coalesce(e.ends_on, e.starts_on) and btrim(coalesce(l.pet, '')) <> '')::int as with_pet_count
  from pos_events e where e.name ~* 'sm aura' or e.name ~* 'circuit makati'
) x where leads_count > 0 order by 1;

-- @ref G02
select coalesce(sum(total), 0)::numeric as revenue
from pos_orders where status is distinct from 'voided' and (created_at at time zone 'Asia/Manila')::date between date '2026-09-21' and date '2026-09-27';

-- @ref G03
select count(*)::int as voided_count from pos_orders
where status = 'voided' and (created_at at time zone 'Asia/Manila')::date between date '2026-09-01' and date '2026-09-30';

-- @ref G04
select extract(hour from created_at at time zone 'Asia/Manila')::int as hour_of_day, count(*)::int as orders_count
from pos_orders
where status is distinct from 'voided' and event_id is not null and (created_at at time zone 'Asia/Manila')::date between date '2026-09-07' and date '2026-09-27'
group by 1 order by 2 desc, 1;

-- @ref G05
select customer_handle as handle, count(*)::int as orders_count, sum(total)::numeric as spend_php
from pos_orders
where status is distinct from 'voided' and customer_handle is not null and (created_at at time zone 'Asia/Manila')::date between date '2026-09-01' and date '2026-09-30'
group by 1 order by 3 desc, 1 limit 5;

-- @ref G06
select count(*)::int as leads_count, count(*) filter (where l.email is null and l.instagram is not null)::int as instagram_only_count
from spin_wheel_leads l, pos_events e
where e.name ~* 'modern market' and (l.collected_at at time zone 'Asia/Manila')::date between e.starts_on and coalesce(e.ends_on, e.starts_on);

-- @ref G07
select prize, count(*)::int as leads_count from spin_wheel_leads
where (collected_at at time zone 'Asia/Manila')::date = date '2026-09-27' group by 1 order by 2 desc, 1;

-- @ref G08
select p.name as product, sum(i.qty)::int as units
from pos_order_items i join pos_orders o on o.id = i.order_id join pos_products p on p.product_id = i.product_id
where o.status is distinct from 'voided' and (o.created_at at time zone 'Asia/Manila')::date = date '2026-09-20'
group by 1 order by 2 desc, 1;

-- @ref G08b
select p.name as product, sum(i.qty)::int as units
from pos_order_items i join pos_orders o on o.id = i.order_id join pos_products p on p.product_id = i.product_id
where o.status is distinct from 'voided'
group by 1 order by 2 desc, 1;

-- @ref G09
select payment_method as method, count(*)::int as orders_count, round(avg(total), 2)::numeric as avg_order_value_php
from pos_orders where status is distinct from 'voided' and (created_at at time zone 'Asia/Manila')::date between date '2026-09-01' and date '2026-09-30'
group by 1 order by 1;

-- Events, tagged and untagged-on-event-dates. tagged_total: completed orders carrying an event id. untagged_in_windows: completed untagged orders whose
-- Manila day falls inside ANY event's [starts_on, ends_on or starts_on] (an upper bound for what the registry may attribute by date).
-- @ref G10
select
  (select count(*) from pos_orders where status is distinct from 'voided' and event_id is not null and (created_at at time zone 'Asia/Manila')::date between date '2026-09-01' and date '2026-09-30')::int as tagged_total,
  (select count(*) from pos_orders o where o.status is distinct from 'voided' and o.event_id is null and (o.created_at at time zone 'Asia/Manila')::date between date '2026-09-01' and date '2026-09-30'
     and exists (select 1 from pos_events e where (o.created_at at time zone 'Asia/Manila')::date between e.starts_on and coalesce(e.ends_on, e.starts_on)))::int as untagged_in_windows;

-- @ref R01
select e.name as event,
  (select count(*) from pos_orders o where o.event_id = e.event_id and o.status is distinct from 'voided')::int as tagged_count,
  (select count(*) from pos_orders o where o.event_id is null and o.status is distinct from 'voided'
     and (o.created_at at time zone 'Asia/Manila')::date between e.starts_on and coalesce(e.ends_on, e.starts_on))::int as untagged_in_window_count
from pos_events e where e.name in ('SM Aura Pet Fair', 'Circuit Makati Weekend', 'circuit makati weekend') order by 1;

-- @ref G11
select p.name as product, sum(i.qty)::int as picks_units
from pos_order_items i join pos_orders o on o.id = i.order_id join pos_products p on p.product_id = i.product_id
where i.bundle_group is not null and i.product_id is not null and o.status is distinct from 'voided' and p.name ~* 'salmon bites'
  and (o.created_at at time zone 'Asia/Manila')::date between date '2026-09-01' and date '2026-09-30'
group by 1;

-- @ref G12
select coalesce(sum(i.line_total), 0)::numeric as bundle_paid_php
from pos_order_items i join pos_orders o on o.id = i.order_id
where i.bundle_id is not null and i.product_id is null and o.status is distinct from 'voided'
  and (o.created_at at time zone 'Asia/Manila')::date between date '2026-09-11' and date '2026-09-27';

-- @ref G13
select count(*)::int as untagged_count from pos_orders
where status is distinct from 'voided' and pet_type is null and (created_at at time zone 'Asia/Manila')::date between date '2026-09-01' and date '2026-09-30';

-- @ref G14
select to_char(created_at at time zone 'Asia/Manila', 'Dy') as weekday, sum(total)::numeric as revenue_php
from pos_orders where status is distinct from 'voided' and (created_at at time zone 'Asia/Manila')::date between date '2026-09-01' and date '2026-09-27'
group by 1, extract(isodow from created_at at time zone 'Asia/Manila') order by extract(isodow from created_at at time zone 'Asia/Manila');

-- @ref G15
select coalesce(pet_type, 'untagged') as pet, sum(total)::numeric as revenue_php
from pos_orders where status is distinct from 'voided' and event_id = 'X-EV1' group by 1 order by 1;

-- @ref G16
select count(*)::int as handles_count, count(*) filter (where n >= 2)::int as repeat_count
from (select customer_handle, count(*) as n from pos_orders
      where status is distinct from 'voided' and customer_handle is not null and (created_at at time zone 'Asia/Manila')::date between date '2026-09-01' and date '2026-09-30'
      group by 1) h;

-- @ref G17
select (event_id is not null) as at_event, round(avg(discount), 2)::numeric as avg_discount_php, count(*)::int as orders_count
from pos_orders where status is distinct from 'voided' and (created_at at time zone 'Asia/Manila')::date between date '2026-09-01' and date '2026-09-30'
group by 1 order by 1;

-- @ref G18
select e.name as name from pos_events e
where not exists (select 1 from pos_orders o where o.event_id = e.event_id and o.status is distinct from 'voided') order by 1;

-- @ref G19
select count(*)::int as changes_count, (array_agg(new_price order by changed_at desc))[1]::numeric as latest_price_php, (array_agg(old_price order by changed_at desc))[1]::numeric as previous_price_php
from pos_price_changes where product_id = 'P1';

-- @ref G20
select (select count(*) from spin_wheel_leads)::int as leads_count,
  (select count(*) from spin_wheel_leads where instagram is not null)::int as instagram_count,
  (select count(*) from spin_wheel_leads l where l.instagram is not null and exists (
     select 1 from pos_orders o where o.status is distinct from 'voided' and o.customer_handle is not null and lower(replace(o.customer_handle, '@', '')) = lower(l.instagram)))::int as matched_count;

-- @ref G25
select pet, count(*)::int as leads_count from spin_wheel_leads
where (collected_at at time zone 'Asia/Manila')::date = date '2026-09-27' group by 1 order by 2 desc, 1;

-- Train 3 (direct reads). Base tables only, as the superuser on the local fixture.;

-- @ref G26
select l.product_id, sum(l.qty_on_hand)::int as stock from public.pos_inventory_lots l where l.location = 'event' group by 1 order by 1;

-- @ref G27
select l.product_id, sum(l.qty_on_hand)::int as stock from public.pos_inventory_lots l group by 1 order by 1;

-- @ref G28
with s as (
  select m.product_id, sum(-m.delta) as units, count(distinct (m.created_at at time zone 'Asia/Manila')::date) as days
  from public.pos_stock_movements m where m.reason = 'sale' and m.created_at >= now() - interval '60 days' group by 1),
e as (select l.product_id, sum(l.qty_on_hand)::int as stock from public.pos_inventory_lots l where l.location = 'event' group by 1)
select e.product_id, e.stock, round(e.stock / nullif(s.units::numeric / s.days, 0), 2) as cover_days
from e left join s on s.product_id = e.product_id order by 1;

-- @ref G29
select l.lot_code, l.qty_on_hand as on_hand_units from public.pos_inventory_lots l where l.expires_on < date '2027-01-01' and l.qty_on_hand > 0 order by l.expires_on;

-- @ref G30
select m.product_id, sum(-m.delta)::int as sold_units from public.pos_stock_movements m
where m.reason = 'sale' and m.created_at >= now() - interval '30 days' group by 1 order by 1;

-- @ref G31
select count(*) as reports_count, count(*) filter (where r.pinned) as pinned_count from public.coop_reports r where r.deleted_at is null;

-- @ref G32
select count(*) as voided_count from public.pos_orders o
where o.status = 'voided' and (o.created_at at time zone 'Asia/Manila')::date between date '2026-09-01' and date '2026-09-30';

-- @ref G33
select count(*) as orders_count, round(sum(o.total), 2) as revenue_php from public.pos_orders o
where o.status is distinct from 'voided' and (o.created_at at time zone 'Asia/Manila')::date between date '2026-09-01' and date '2026-09-30';

-- @ref G34
select s.key, s.value ->> 'threshold' as threshold_text from public.pos_settings s where s.key = 'stock_forecast_config';

-- @ref A07_pet_venue_event
select e.venue as venue, e.name as event, coalesce(o.pet_type, 'untagged') as pet, count(*)::int as orders_count, sum(o.total)::numeric as revenue_php
from pos_orders o join pos_events e on e.event_id = o.event_id
where o.status is distinct from 'voided' and (e.venue ~* 'sm aura' or e.venue ~* 'circuit')
group by 1, 2, 3 order by 1, 2, 3;
