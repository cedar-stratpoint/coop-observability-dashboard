-- S2 · Goldline sales figures encrypted at rest. Last step: drop the plain copy.
-- Run only after s1_sales_encryption.sql, s3_sales_units_encryption.sql AND the app build
-- that reads units through sales_units are live in this environment. Nichido STAGING
-- first; PROD after review.
--
-- After this an older deployment that still writes gross_retail / net_of_vat / units
-- fails loudly instead of storing plain figures.

-- Refuse if any row would lose a figure: plain values with no ciphertext, or a ciphertext
-- still on s1's 2-part format (units not in it yet: re-run s3).
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'sales' and column_name = 'units')
     and exists (
       with key as materialized (select private.goldline_sales_key() as k)
       select 1 from public.sales s cross join key
       where case when s.amounts_enc is null
                  then s.gross_retail is not null or s.net_of_vat is not null or s.units is not null
                  else pg_catalog.array_length(pg_catalog.string_to_array(private.goldline_sales_open(s.amounts_enc, key.k), '|'), 1) < 3
             end) then
    raise exception 'sales rows not on the 3-part amounts_enc: run s1 and s3 first';
  end if;
end $$;

drop trigger if exists sales_seal_legacy on public.sales;
drop function if exists private.goldline_sales_seal_legacy();

alter table public.sales drop column if exists gross_retail;
alter table public.sales drop column if exists net_of_vat;
alter table public.sales drop column if exists units;

-- Run this statement ON ITS OWN (VACUUM cannot run inside a transaction). Dropping a
-- column only hides it; this rewrites the table so the old plaintext leaves the data
-- files. Takes an exclusive lock on sales for a few seconds.
-- vacuum full public.sales;
