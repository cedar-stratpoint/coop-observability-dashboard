-- S2 · Goldline sales money encrypted at rest. Part 2 of 2: drop the plain copy.
-- Run only after s1_sales_encryption.sql AND the app build whose upsertSales calls
-- upsert_sales are live in this environment. Nichido STAGING first; PROD after review.
--
-- After this an older deployment that still writes gross_retail / net_of_vat fails
-- loudly instead of storing plain figures.

-- Refuse if any row would lose its figures (plain values that never got encrypted).
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'sales' and column_name = 'gross_retail')
     and exists (select 1 from public.sales
                 where amounts_enc is null and (gross_retail is not null or net_of_vat is not null)) then
    raise exception 'sales rows with plain figures but no amounts_enc: re-run s1 first';
  end if;
end $$;

drop trigger if exists sales_seal_legacy on public.sales;
drop function if exists private.goldline_sales_seal_legacy();

alter table public.sales drop column if exists gross_retail;
alter table public.sales drop column if exists net_of_vat;

-- Run this statement ON ITS OWN (VACUUM cannot run inside a transaction). Dropping a
-- column only hides it; this rewrites the table so the old plaintext leaves the data
-- files. Takes an exclusive lock on sales for a few seconds.
-- vacuum full public.sales;
