-- Run on the Nichido project after scripts/nichido/migrate-goldline.ts --apply.
-- The copy keeps the archive's ids, so move each id sequence past the highest copied
-- id; otherwise the next insert would reuse an id. Safe to re-run.
select setval(pg_get_serial_sequence('public.sales', 'id'), coalesce((select max(id) from public.sales), 0) + 1, false);
select setval(pg_get_serial_sequence('public.inventory', 'id'), coalesce((select max(id) from public.inventory), 0) + 1, false);
select setval(pg_get_serial_sequence('public.price_changes', 'id'), coalesce((select max(id) from public.price_changes), 0) + 1, false);
