-- F2e · Undo for SKU linking (Nichido project). Additive and safe to re-run.
-- Run on Nichido STAGING (Nichido-Supabase-Staging) first; PROD after review.
--
-- Oct 29: every decision on SKU linking (approve, reject, link, unlink, remark, mark
-- decommissioned, bring back, note) is logged with the rows it actually changed, before
-- and after: our items' link and retire fields, Coop's suggestion per Watsons SKU, the
-- latest decision per SKU, the latest note per item. The latest decision on a SKU or an
-- item can be undone (restores `before`) as long as those rows still equal `after`.
-- Undoing keeps the trail: the entry gets undone_by / undone_at, nothing is deleted.

create table if not exists public.sku_decision_log (
  id          bigint generated always as identity primary key,
  company_id  text not null references public.companies(id) on delete cascade,
  target      text not null check (target in ('sku', 'item')),
  key         text not null,
  action      text not null check (action in ('approved', 'rejected', 'linked', 'unlinked', 'remark', 'decommissioned', 'restored', 'note')),
  summary     text,
  done_by     text,
  done_at     timestamptz not null default now(),
  before      jsonb not null,
  after       jsonb not null,
  undone_by   text,
  undone_at   timestamptz
);
create index if not exists sku_decision_log_latest on public.sku_decision_log (company_id, target, key, id desc);
alter table public.sku_decision_log enable row level security;
revoke all on public.sku_decision_log from anon, authenticated;
