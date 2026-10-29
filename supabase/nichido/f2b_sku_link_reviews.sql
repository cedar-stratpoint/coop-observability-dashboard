-- F2b · SKU link reviews (Nichido project). Additive and safe to re-run.
-- Run on Nichido STAGING (Nichido-Supabase-Staging) first; PROD after review.
--
-- Decided Oct 27: SKU linking is back in Coop with Approve / Reject on Coop's
-- suggested matches and an optional remark. Only the latest decision and the latest
-- remark per Watsons SKU are kept (no history). The link itself stays on
-- products.sku_code; this table only says who decided what, and why.
--   action    approved (Coop's suggestion accepted), rejected (turned down),
--             linked (an item picked by hand), unlinked (a link undone)
--   item_code the item the action was about

create table if not exists public.sku_link_reviews (
  company_id  text not null references public.companies(id) on delete cascade,
  chain       text not null check (chain in ('watsons', 'robinsons')),
  sku_code    text not null,
  action      text check (action is null or action in ('approved', 'rejected', 'linked', 'unlinked')),
  item_code   text,
  action_by   text,
  action_at   timestamptz,
  remark      text check (remark is null or char_length(remark) <= 500),
  remark_by   text,
  remark_at   timestamptz,
  primary key (company_id, chain, sku_code)
);
alter table public.sku_link_reviews enable row level security;
revoke all on public.sku_link_reviews from anon, authenticated;
