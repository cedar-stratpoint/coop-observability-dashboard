-- f2c · Decommissioned items: who retired an item and why (Oct 28).
-- Additive. SKU linking's "Sold at Watsons?" list can mark one of our form items as
-- decommissioned (no longer made or sold): it sets products.retired_at as before, and now
-- also who did it and an optional remark, so the decision can be read back and undone.
-- Same retired_at the Inventory board's Retire uses: retired items stay out of SKU
-- matching and restock.

alter table public.products add column if not exists retired_by text;
alter table public.products add column if not exists retired_remark text;

do $$ begin
  alter table public.products add constraint products_retired_remark_len check (retired_remark is null or char_length(retired_remark) <= 500);
exception when duplicate_object then null; end $$;
