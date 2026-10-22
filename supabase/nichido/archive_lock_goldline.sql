-- Run on the Coop ARCHIVE project (not Nichido), once Goldline has moved to Nichido in
-- that environment. Order: deploy the code that reads NICHIDO_URL, run
-- scripts/nichido/migrate-goldline.ts --apply one last time (catches anything written to
-- the archive before the deploy), then --verify, then this file.
--
-- The archive keeps its gl_* tables and goldline-uploads files indefinitely, readable,
-- but nothing can write to them any more: an old deployment still pointed at the
-- archive fails loudly instead of quietly splitting Goldline's data across two
-- databases. Undo with the matching grants if ever needed. Safe to re-run.

do $$
declare t text;
begin
  foreach t in array array['gl_stores','gl_products','gl_sales','gl_inventory','gl_uploads','gl_extractions',
                           'gl_upload_batches','gl_supply_settings','gl_line_lead_times','gl_store_transit',
                           'gl_warehouse_stock','gl_shipments','gl_price_changes'] loop
    execute format('revoke insert, update, delete, truncate on public.%I from service_role', t);
    execute format('comment on table public.%I is %L', t,
      'Read-only copy. Goldline data moved to the Nichido project on ' || current_date || '; write there.');
  end loop;
end $$;

-- The write functions are security invoker, so the revokes above already stop them;
-- revoking execute makes the failure obvious at the call.
revoke execute on function public.gl_commit_batch(text, uuid, text, date, date, text, jsonb) from service_role;
revoke execute on function public.gl_record_shipment(text, text, text, integer, text, date) from service_role;
revoke execute on function public.gl_cancel_shipment(text, uuid, text, date) from service_role;
revoke execute on function public.gl_set_price(text, text, numeric, text) from service_role;

-- New uploads into the old bucket: storage writes use the service role too, so block
-- them with a policy-free bucket setting (no new objects accepted).
update storage.buckets set allowed_mime_types = array['application/x-goldline-moved-to-nichido']
 where id = 'goldline-uploads';
