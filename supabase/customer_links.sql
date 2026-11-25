-- "Same person" links (RET-15 Slice B, plan knowledge/tasks/2026-11-25-ask-coop-log-contact-and-link-people.md): an owner-approved
-- link between a website customer and a booth lead, saved from Ask Coop's matches table. It only adds Instagram and Booth
-- metadata beside the customer on the Website CRM page's Customers tab; it is NOT a merge: the customer keeps their own name,
-- email, orders, spend and vouchers, and no count, cohort or repeat rate changes. Unlink removes the metadata only.
-- Written by src/customer-links-actions.ts (insert; delete only where created_by is the signed-in user), read by
-- src/customer-links-data.ts. Exact matches (same email, or same mobile by its last 10 digits) need no row here.
--
-- Run once per environment in the Supabase SQL editor (Staging first, owner approval). Safe to re-run.
-- Until it runs, the Instagram and Booth cells show "unknown" for non-exact people (never "—") and "Same person" says it is not set up.
create table if not exists public.customer_links (
  id             uuid primary key default gen_random_uuid(),
  customer_email text not null check (customer_email <> '' and customer_email = lower(customer_email)),
  lead_email     text check (lead_email is null or (lead_email <> '' and lead_email = lower(lead_email))),
  lead_mobile    text check (lead_mobile is null or lead_mobile <> ''),            -- last 10 digits
  lead_instagram text check (lead_instagram is null or (lead_instagram <> '' and lead_instagram = lower(lead_instagram) and lead_instagram not like '@%')),
  lead_campaign  text,                                                               -- the event the row showed; a hint, not a key
  created_by     text not null check (created_by <> ''),                             -- the signed-in Coop email
  created_at     timestamptz not null default now(),
  check (lead_email is not null or lead_mobile is not null or lead_instagram is not null)
);

-- One link per customer and lead identity: linking the same pair twice is a no-op.
create unique index if not exists customer_links_unique_idx
  on public.customer_links (customer_email, coalesce(lead_email, ''), coalesce(lead_mobile, ''), coalesce(lead_instagram, ''));

-- Contact data. RLS on with NO policies: the anon key can read nothing, and only the service role (Coop server-side) gets
-- through. Verify after applying: select with the anon key returns no rows.
alter table public.customer_links enable row level security;
