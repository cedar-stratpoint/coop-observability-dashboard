-- Goldline inventory snapshots: one row per company × store × form period, rolled up
-- from gl_inventory. Feeds the Inventory page's store/period pickers and its
-- "from N scanned pages" line without scanning every inventory row.
--
-- Additive only (new view; gl_inventory untouched). security_invoker so the base
-- table's RLS applies to callers; with RLS on and no policies, only the service-role
-- dashboard can read it. Explicit revokes keep it off the anon/authenticated APIs.
-- Apply on Staging first; promote to prod with companies.sql / goldline.sql.

create or replace view public.gl_inventory_snapshots
with (security_invoker = true) as
select
  company_id,
  store_code,
  period_start,
  period_end,
  count(*)::int                         as items,
  count(distinct source_upload_id)::int as uploads,
  max(consultant)                       as consultant,
  max(created_at)                       as last_committed_at
from public.gl_inventory
group by company_id, store_code, period_start, period_end;

revoke all on public.gl_inventory_snapshots from anon, authenticated;

comment on view public.gl_inventory_snapshots is
  'Per company/store/period rollup of gl_inventory (Inventory page pickers). Service-role only.';
