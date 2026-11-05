-- Restock hit or miss (Nichido project). Additive and safe to re-run.
-- Run on Nichido STAGING (Nichido-Supabase-Staging) first; PROD after review. Needs p3b_recommendations.sql.
--
-- Decided Nov 4: every restock line the owner decides on the Restock run (F11) is a hit
-- or a miss for Coop.
--   hit   approved as is (an edit back to Coop's own number is already stored as approved)
--   miss  edited or rejected
-- Lines still pending (undone ones too) aren't decided, so they don't count. Held and
-- covered lines can't be decided at all. The math is in src/goldline-hit-rate.ts; this
-- file only returns the decided lines.
--
--   restock_decisions()  the decided lines of the last p_runs runs (null = every run), as
--                        one jsonb array (no PostgREST row cap). Volume is bounded by
--                        hand decisions, a few hundred per run.

create or replace function public.restock_decisions(p_company text, p_stores text[] default null, p_runs integer default null)
returns jsonb
language sql stable security invoker set search_path = public
as $$
  with runs as (
    select id, cycle, run_date from restock_runs
    where company_id = p_company
    order by run_date desc, cycle desc
    limit p_runs
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'cycle', ru.cycle, 'run_date', ru.run_date,
           'store_code', r.store_code, 'item_code', r.item_code, 'product_line', p.product_line,
           'decision', r.decision, 'suggested', r.suggested, 'final_qty', r.final_qty,
           'remark', r.remark, 'decided_by', r.decided_by, 'decided_at', r.decided_at)
         order by ru.run_date, r.store_code, r.item_code), '[]'::jsonb)
  from recommendations r
  join runs ru on ru.id = r.run_id
  left join products p on p.company_id = r.company_id and p.item_code = r.item_code
  where r.company_id = p_company
    and r.decision <> 'pending'
    and (p_stores is null or r.store_code = any(p_stores));
$$;
revoke all on function public.restock_decisions(text, text[], integer) from public, anon, authenticated;
grant execute on function public.restock_decisions(text, text[], integer) to service_role;
