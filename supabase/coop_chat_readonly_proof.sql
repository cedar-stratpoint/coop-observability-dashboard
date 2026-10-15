-- coop_chat_readonly_proof.sql
-- Negative-proof script for the coop_chat_ro role. Paste into the archive project's SQL editor (staging, then PROD).
-- SAFE ON PROD: it only reads, and everything runs in a transaction that is rolled back. Any write it tries must be
-- refused, and if one were NOT refused the rollback undoes it. Read the NOTICE output: every line must start with PASS.
-- Run supabase/coop_chat_readonly.sql and supabase/coop_chat_stock.sql first.
begin;
set local role coop_chat_ro;

do $$ declare r text; n bigint; begin
  foreach r in array array['coop_chat_orders','coop_chat_order_items','coop_chat_products','coop_chat_bundles','coop_chat_prices','coop_chat_price_changes','coop_chat_events','coop_chat_stock_by_location','coop_chat_sale_movements','coop_chat_stock_config'] loop
    begin
      execute format('select count(*) from public.%I', r) into n;
      raise notice 'PASS read view % (% rows)', r, n;
    exception when others then raise notice 'FAIL read view %: %', r, sqlerrm; end;
  end loop;
end $$;

do $$ declare r text; n bigint; begin
  foreach r in array array['pos_orders','pos_order_items','pos_products','pos_bundles','pos_prices','pos_price_changes','pos_events','pos_inventory_by_location','pos_stock_movements','pos_settings'] loop
    begin
      execute format('select count(*) from public.%I', r) into n;
      raise notice 'FAIL base table % was readable', r;
    exception
      when insufficient_privilege then raise notice 'PASS base table % denied (insufficient_privilege)', r;
      when others then raise notice 'FAIL base table %: unexpected % %', r, sqlstate, sqlerrm;
    end;
  end loop;
end $$;

do $$ declare c text; begin
  foreach c in array array['customer_handle','remarks','client_uuid','device_id'] loop
    begin
      execute format('select %I from public.coop_chat_orders limit 1', c);
      raise notice 'FAIL column % selectable through coop_chat_orders', c;
    exception
      when undefined_column then raise notice 'PASS column % absent from coop_chat_orders', c;
      when others then raise notice 'FAIL column %: unexpected % %', c, sqlstate, sqlerrm;
    end;
  end loop;
end $$;

do $$ declare v text; col text; stmt text; begin
  foreach v in array array['coop_chat_orders','coop_chat_order_items','coop_chat_products','coop_chat_bundles','coop_chat_prices','coop_chat_price_changes','coop_chat_events','coop_chat_stock_by_location','coop_chat_sale_movements','coop_chat_stock_config'] loop
    select attname into col from pg_attribute
      where attrelid = ('public.' || v)::regclass and attnum > 0 and not attisdropped order by attnum limit 1;
    foreach stmt in array array[
      format('insert into public.%I default values', v),
      format('update public.%I set %I = %I', v, col, col),
      format('delete from public.%I', v)
    ] loop
      begin
        execute stmt;
        raise notice 'FAIL write allowed: %', stmt;
      exception
        when insufficient_privilege or feature_not_supported or generated_always or read_only_sql_transaction or object_not_in_prerequisite_state then -- 55000: a view over a grouped view is not updatable
          raise notice 'PASS write refused (%): %', sqlstate, stmt;
        when others then raise notice 'FAIL unexpected % %: %', sqlstate, sqlerrm, stmt;
      end;
    end loop;
  end loop;
end $$;

-- Staff, device and cash columns of the new views' base tables must not be selectable through the views.
do $$ declare pair text[]; v text; c text; begin
  foreach pair slice 1 in array array[
    ['coop_chat_events','created_by'],['coop_chat_events','organizer'],['coop_chat_events','opening_cash'],
    ['coop_chat_events','closing_cash'],['coop_chat_events','cash_note'],
    ['coop_chat_prices','updated_by'],
    ['coop_chat_price_changes','changed_by'],['coop_chat_price_changes','device_id'],['coop_chat_price_changes','reason']
  ] loop
    v := pair[1]; c := pair[2];
    begin
      execute format('select %I from public.%I limit 1', c, v);
      raise notice 'FAIL column % selectable through %', c, v;
    exception
      when undefined_column then raise notice 'PASS column % absent from %', c, v;
      when others then raise notice 'FAIL column % of %: unexpected % %', c, v, sqlstate, sqlerrm;
    end;
  end loop;
end $$;

reset role;
rollback;
