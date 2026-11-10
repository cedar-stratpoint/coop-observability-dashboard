-- The manual contact log (RET-05, plan knowledge/tasks/2026-11-10-customer-contact-log-stage5.md): a DM, SMS, call,
-- hand-sent email or other contact a team member logs against a website customer, so "times contacted" on the
-- Website CRM page's Customers tab and in Ask Coop counts more than the automated CRM emails.
-- Written by src/customer-contacts-actions.ts (insert; delete only where created_by is the signed-in user), read by
-- src/customer-contacts-data.ts. It records a contact; nothing ever sends one.
--
-- Run once per environment in the Supabase SQL editor (Staging first, owner approval). Safe to re-run.
-- Until it runs, the dashboard shows the manual count as "unavailable" (never 0) and "Log contact" says it is not set up.
create table if not exists public.customer_contacts (
  id             uuid primary key default gen_random_uuid(),
  customer_email text not null check (customer_email <> '' and customer_email = lower(customer_email)),
  channel        text not null check (channel in ('dm', 'sms', 'call', 'email', 'other')),
  note           text check (note is null or char_length(note) <= 500),  -- free text, may hold PII
  contacted_at   timestamptz not null default now(),
  created_by     text not null check (created_by <> ''),                 -- the signed-in Coop email
  created_at     timestamptz not null default now()
);

-- Per-customer counts and the newest-first list.
create index if not exists customer_contacts_email_idx on public.customer_contacts (customer_email, contacted_at desc);

-- Contact data. RLS on with NO policies: the anon key can read nothing, and only the service role (Coop server-side,
-- same as spin_wheel_leads) gets through. Verify after applying: select with the anon key returns no rows.
alter table public.customer_contacts enable row level security;
