-- p8 · Reopen for review (Nov 27). Plan: knowledge/tasks/2026-11-27-reopen-flare-band-wording.md (W3).
--
-- A committed page can go back to review: its counts leave Inventory, its read gets the committed
-- cells back (computed by the app, passed in as p_page), and the page and its read are "in review"
-- again. Coop's checks from that page that stop firing are closed as 'withdrawn': unlike
-- 'resolved', a withdrawn check does NOT count against the BA (owner decision: a commit mistake
-- must not stay on the BA). Re-committing re-runs the checks, so a real problem comes back.
--
-- Additive: widens the flags status check and adds one function. Apply on Nichido Staging first;
-- on Nichido prod in the release, with the owner's OK.

alter table public.flags drop constraint if exists flags_status_check;
alter table public.flags add constraint flags_status_check check (status in ('open', 'resolved', 'withdrawn'));

-- One transaction: the page must still be committed (locked, so two reopens or a reopen and a
-- commit can't interleave); its counts leave Inventory; its read takes p_page; both go back to
-- review. Returns the number of counts removed. Counts another page has since replaced carry that
-- page's id and are left alone.
create or replace function public.reopen_upload(
  p_company text,
  p_upload  uuid,
  p_page    jsonb
) returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_status text;
  v_n      integer;
begin
  select status into v_status from uploads where id = p_upload and company_id = p_company for update;
  if v_status is null then raise exception 'upload_not_found' using errcode = 'P0002'; end if;
  if v_status <> 'committed' then raise exception 'upload_not_committed' using errcode = 'P0001'; end if;
  if p_page is null or jsonb_typeof(p_page -> 'rows') <> 'array' then
    raise exception 'page_invalid' using errcode = 'P0001';
  end if;

  delete from inventory where company_id = p_company and source_upload_id = p_upload;
  get diagnostics v_n = row_count;

  update extractions set rows = p_page, status = 'pending_review'
    where company_id = p_company and upload_id = p_upload;
  update uploads set status = 'needs_review'
    where company_id = p_company and id = p_upload;
  return v_n;
end;
$$;

revoke all on function public.reopen_upload(text, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.reopen_upload(text, uuid, jsonb) to service_role;
