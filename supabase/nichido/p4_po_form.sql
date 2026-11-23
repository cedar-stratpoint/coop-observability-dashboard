-- NICH-17 · The PO form (Nichido project). Additive and safe to re-run.
-- Run on Nichido STAGING (Nichido-Supabase-Staging) first; PROD after review.
--
-- Decided Nov 23:
--   • Nichido's paper PURCHASE ORDER FORM (xlsx or pdf) is the source of truth for which
--     products are ACTIVE (still delivered). A product printed on it is "on the PO"; a
--     product not on it is inactive (being phased out).
--   • The latest ACTIVATED form wins, in full. No lookback window. An upload is a draft
--     until an admin reviews what was read and activates it; activating supersedes the
--     previous form (kept for history, never deleted).
--   • The reconciliation matrix (/stock/audit) uses it as its third leg (PO), and the
--     restock run holds lines for products that aren't on it ("Not on the PO form").
--   • These are NOT purchase_orders / po_lines (F12): those are Coop's own outbound orders
--     made from the restock run.
--
--   po_forms          one row per uploaded file: draft → active → superseded.
--   po_form_items     the catalog products on that form (read from it, or added by hand).
--   activate_po_form  make a draft the active form, superseding the old one, atomically.

create table if not exists public.po_forms (
  id            uuid primary key default gen_random_uuid(),
  company_id    text not null references public.companies(id) on delete cascade,
  file_name     text not null check (char_length(file_name) between 1 and 200),
  file_kind     text not null check (file_kind in ('xlsx', 'pdf')),
  storage_path  text,                          -- the original file in goldline-uploads
  status        text not null default 'draft' check (status in ('draft', 'active', 'superseded')),
  lines_read    integer not null default 0,    -- printed product lines read from the file
  unmatched     jsonb not null default '[]'::jsonb, -- printed lines that matched no product
  uploaded_by   text,
  uploaded_at   timestamptz not null default now(),
  activated_by  text,
  activated_at  timestamptz
);
create unique index if not exists po_forms_one_active on public.po_forms (company_id) where status = 'active';
create index if not exists po_forms_company_idx on public.po_forms (company_id, uploaded_at desc);
alter table public.po_forms enable row level security;
revoke all on public.po_forms from anon, authenticated;

create table if not exists public.po_form_items (
  po_form_id   uuid not null references public.po_forms(id) on delete cascade,
  company_id   text not null references public.companies(id) on delete cascade,
  item_code    text not null,
  source_text  text,                           -- the printed line it was read from (null = by hand)
  score        numeric,                        -- matcher confidence (null = by hand)
  by_hand      boolean not null default false,
  created_at   timestamptz not null default now(),
  primary key (po_form_id, item_code)
);
create index if not exists po_form_items_company_idx on public.po_form_items (company_id, item_code);
alter table public.po_form_items enable row level security;
revoke all on public.po_form_items from anon, authenticated;

create or replace function public.activate_po_form(p_company text, p_form uuid, p_by text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
begin
  select status into v_status from public.po_forms where id = p_form and company_id = p_company for update;
  if v_status is null then raise exception 'po_form_not_found'; end if;
  if v_status = 'active' then return; end if;
  if v_status = 'superseded' then raise exception 'po_form_superseded'; end if;
  update public.po_forms set status = 'superseded' where company_id = p_company and status = 'active';
  update public.po_forms set status = 'active', activated_by = p_by, activated_at = now() where id = p_form;
end;
$$;
revoke all on function public.activate_po_form(text, uuid, text) from public, anon, authenticated;
grant execute on function public.activate_po_form(text, uuid, text) to service_role;
