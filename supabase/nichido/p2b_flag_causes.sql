-- P2b · Oct 26 meeting decisions on flags (Nichido project). Additive in spirit, safe to re-run.
-- Run on Nichido STAGING (Nichido-Supabase-Staging) first; PROD after review, after p2_checks.sql.
--
--   cause   renamed to the words Justin's dad uses:
--             unreadable   → messy_handwriting
--             human_error  → incorrect_total
--             manipulation → padding
--           A sales gap is now named by its direction: POS sold more than the counts show
--           → padding; the counts show more gone than POS sold → incorrect_total.
--   status  every flag counts against the BA as soon as Coop raises it, for good: no
--           checked or dismissed, no admin step. 'open', or 'resolved' when the data
--           changed since (e.g. a corrected count); a resolved flag still counts, because
--           the form was wrong when the BA wrote it. Admins can add a remark; it never
--           changes the count. Flags an admin had closed go back to open.

alter table public.flags drop constraint if exists flags_cause_check;
update public.flags set cause = case
    when kind = 'sales_gap' and coalesce((details->>'gap')::numeric, 0) < 0 then 'padding'
    when kind = 'sales_gap' then 'incorrect_total'
    when cause in ('unreadable') then 'messy_handwriting'
    when cause in ('human_error') then 'incorrect_total'
    when cause in ('manipulation') then 'padding'
    else cause
  end
  where cause in ('unreadable', 'human_error', 'manipulation') or kind = 'sales_gap';
alter table public.flags add constraint flags_cause_check check (cause in ('messy_handwriting', 'incorrect_total', 'padding'));

-- Who wrote the remark and when (closed_by / closed_at now only record Coop resolving a flag).
alter table public.flags add column if not exists remark_by text;
alter table public.flags add column if not exists remarked_at timestamptz;

alter table public.flags drop constraint if exists flags_status_check;
update public.flags
  set status = 'open', remark_by = coalesce(remark_by, closed_by), remarked_at = coalesce(remarked_at, closed_at),
      closed_at = null, closed_by = null, updated_at = now()
  where status in ('checked', 'dismissed');
-- Coop's old resolve note isn't an admin remark.
update public.flags set remark = null where status = 'resolved' and remark like 'Cleared by the data%';
alter table public.flags add constraint flags_status_check check (status in ('open', 'resolved'));

-- original_cause stays for history (an admin can no longer change a cause).
create index if not exists flags_ba_month_idx on public.flags (company_id, store_code, period_end);
