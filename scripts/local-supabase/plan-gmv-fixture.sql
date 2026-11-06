-- LOCAL ONLY (throwaway harness). Past-month POS orders so the Business Health Report has real actuals to judge (BHR-02):
--   docker exec -i coop-local-db psql -U postgres < scripts/local-supabase/plan-gmv-fixture.sql
-- Idempotent: the rows carry fixed client_uuids and are replaced on every run. Boundary orders sit at 31 Aug 23:59 and 1 Sep 00:00 Manila.
delete from public.pos_orders where client_uuid::text like '00000000-0000-4000-8000-0000000b02%';
insert into public.pos_orders (client_uuid, subtotal, total, status, created_at, event_id) values
  ('00000000-0000-4000-8000-0000000b0201', 30000, 30000, 'completed', '2026-08-31 23:59:00+08', 'EV4'),   -- August event: met
  ('00000000-0000-4000-8000-0000000b0202', 100000, 100000, 'completed', '2026-09-01 00:00:00+08', 'EV1'), -- September event: met
  ('00000000-0000-4000-8000-0000000b0203', 5000, 5000, 'completed', '2026-09-15 12:00:00+08', null),      -- non-event walk-in: not Events GMV
  ('00000000-0000-4000-8000-0000000b0204', 9999, 9999, 'voided', '2026-09-16 12:00:00+08', 'EV1'),        -- voided: not counted
  ('00000000-0000-4000-8000-0000000b0205', 20000, 20000, 'completed', '2026-10-11 12:00:00+08', 'EV3');   -- October event: missed
