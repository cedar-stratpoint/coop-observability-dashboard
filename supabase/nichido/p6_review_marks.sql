-- P6 · Review marks (NICH-42 / NICH-36 / NICH-43, Nov 25). Additive, safe to re-run.
-- Run on Nichido STAGING (Nichido-Supabase-Staging) first; PROD after review.
--
-- A review mark says "look at this row on this page": a number that can't be read, a BA's
-- handwritten note or revision, "Damage" written in a count, a column the BA relabelled,
-- a product the BA hand-wrote onto the form, or anything else. Syl (Nov 25): flag the file,
-- page and row; never capture the note's text.
--
-- Unlike public.flags (the BA scorecard), a mark NEVER counts against the BA. It is keyed by
-- the page (an uploads row) and the row (item code), not by batch or store: batches get
-- re-split and a page's store is often set after it is read, so reports join store, period
-- and BA live through the page's batch.
--
--   kind    illegible | note | damage | column_changed | added_row | other
--   source  reviewer (the Flag action) | reader (set by the read, NICH-36)
--   status  open | cleared (cleared keeps who and when; flagging again reopens it)

create table if not exists public.review_marks (
  id          uuid primary key default gen_random_uuid(),
  company_id  text not null references public.companies(id) on delete cascade,
  upload_id   uuid not null references public.uploads(id) on delete cascade,
  item_code   text,                                   -- null = the whole page
  row_index   integer,                                -- position in the read when flagged (display hint only)
  field       text check (field is null or field in ('stockroom', 'drawer', 'selling_area', 'delivery', 'ending_on_hand')),
  kind        text not null check (kind in ('illegible', 'note', 'damage', 'column_changed', 'added_row', 'other')),
  source      text not null check (source in ('reviewer', 'reader')),
  reason      text check (reason is null or char_length(reason) <= 200),  -- the reviewer's own words, never the BA's note
  status      text not null default 'open' check (status in ('open', 'cleared')),
  created_by  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  cleared_by  text,
  cleared_at  timestamptz
);

-- One mark per page, row, kind and source: flagging the same thing again updates it.
create unique index if not exists review_marks_one_idx
  on public.review_marks (upload_id, coalesce(item_code, ''), kind, source);
create index if not exists review_marks_company_idx on public.review_marks (company_id, status, created_at desc);

alter table public.review_marks enable row level security;
revoke all on public.review_marks from anon, authenticated;

-- Upsert one mark (the unique index is an expression, so PostgREST's on_conflict can't target it).
-- Re-flagging a cleared mark reopens it with the new reason.
create or replace function public.review_mark_upsert(
  p_company text, p_upload uuid, p_item text, p_row integer, p_kind text, p_source text, p_reason text, p_by text
) returns public.review_marks
language sql security invoker set search_path = public as $$
  insert into public.review_marks (company_id, upload_id, item_code, row_index, kind, source, reason, created_by)
  values (p_company, p_upload, nullif(p_item, ''), p_row, p_kind, p_source, nullif(p_reason, ''), p_by)
  on conflict (upload_id, coalesce(item_code, ''), kind, source) do update
    set row_index = excluded.row_index, reason = excluded.reason, status = 'open',
        cleared_by = null, cleared_at = null, updated_at = now()
  returning *;
$$;
revoke all on function public.review_mark_upsert(text, uuid, text, integer, text, text, text, text) from public, anon, authenticated;
grant execute on function public.review_mark_upsert(text, uuid, text, integer, text, text, text, text) to service_role;
