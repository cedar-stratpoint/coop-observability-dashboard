-- F2d · Notes on our form items (Nichido project). Additive and safe to re-run.
-- Run on Nichido STAGING (Nichido-Supabase-Staging) first; PROD after review.
--
-- Oct 29: on SKU linking's "Sold at Watsons?" list, an item can carry a note ("check
-- with Justin", "maybe the Watsons short name for X") separate from marking it
-- decommissioned. Only the latest note per item is kept, with who wrote it and when;
-- clearing the note deletes the row. Nothing reads it for matching or restock.

create table if not exists public.item_notes (
  company_id  text not null references public.companies(id) on delete cascade,
  item_code   text not null,
  note        text not null check (char_length(note) between 1 and 500),
  note_by     text,
  note_at     timestamptz not null default now(),
  primary key (company_id, item_code)
);
alter table public.item_notes enable row level security;
revoke all on public.item_notes from anon, authenticated;
