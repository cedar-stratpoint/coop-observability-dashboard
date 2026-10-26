-- product_channel_alias.sql: OWNED BY zoomy-observability-dashboard (cross-channel SKU comparison, src/sku-compare.ts).
-- Applied BY HAND in the archive project's SQL editor (local Docker first, then staging; PROD with the co-worker's OK).
-- Service role only: RLS on, no policies. Idempotent. Plan: knowledge/tasks/2026-10-22-cross-channel-sku-and-calculation-build-plan.md (D1).
--
-- One row says "this channel's identifier means this POS product". The canonical key is the POS pos_products.product_id, referenced BY VALUE
-- (no foreign key, and no pos_* DDL here: those tables belong to zoomy-pos). The POS channel needs no rows (its code is the key).
--   * A combo (one listing that is several products) is several rows with the SAME key, the SAME bundle_id and a component_qty each.
--   * Two rows for the same key that disagree (different product, same validity window) are a conflict: the comparison leaves that key
--     unmapped and says so, it never picks one.
--   * 'auto' rows are exact matches (alias_value equals a POS product_id); every other row is 'manual' and counts only once confirmed_at is set.
--   * valid_from / valid_to (Manila dates, inclusive, null = open) let a renamed or recreated listing keep its history joined.

create table if not exists public.product_channel_alias (
  id             bigint generated always as identity primary key,
  channel        text    not null check (channel in ('shopee', 'website', 'lazada')),
  alias_type     text    not null check (alias_type in ('sku', 'variant_id', 'item_id+variation_id', 'title')),
  alias_value    text    not null check (btrim(alias_value) <> ''),
  product_id     text    not null,                          -- pos_products.product_id (the component, for a combo)
  bundle_id      text,                                      -- set only on the rows of one combo, equal on all of them
  component_qty  integer not null default 1 check (component_qty > 0),
  valid_from     date,
  valid_to       date,
  source         text    not null default 'manual' check (source in ('auto', 'manual')),
  confirmed_at   timestamptz,
  created_at     timestamptz not null default now(),
  check (valid_to is null or valid_from is null or valid_to >= valid_from)
);

-- One identifier maps to one product per validity start; a combo repeats the key once per component, so product_id is part of the key.
create unique index if not exists product_channel_alias_key
  on public.product_channel_alias (channel, alias_type, alias_value, product_id, coalesce(valid_from, date '0001-01-01'));
create index if not exists product_channel_alias_product on public.product_channel_alias (product_id);

alter table public.product_channel_alias enable row level security;
revoke all on public.product_channel_alias from anon, authenticated;

notify pgrst, 'reload schema';
