-- RET-17 (plan knowledge/tasks/2026-11-25-ret17-implementation-plan.md, Task 1): the manual contact log (customer_contacts)
-- takes an event lead that has no email. A contact is logged against an email, an Instagram handle or a mobile (at least one),
-- and carries "they replied" (replied). Written by src/customer-contacts-actions.ts, read by src/customer-contacts-data.ts.
-- It records a contact; nothing ever sends one.
--
-- Keys are stored the way the code compares them: contact_instagram = igHandle (no "@", lower case, src/customer-links.ts),
-- contact_mobile = phoneKey (the last 10 digits, src/contacts-merge.ts).
--
-- ROLLOUT ORDER: run this in the Supabase SQL editor on Staging first, then PROD. Safe to re-run.
-- Until it runs, the dashboard still loads (reads fall back to the old columns: no Instagram / mobile, replied = false),
-- email logging keeps working, and logging by Instagram / mobile (or "they replied") says it is not set up.
-- Needs supabase/customer_contacts.sql applied first.

alter table public.customer_contacts alter column customer_email drop not null;

alter table public.customer_contacts add column if not exists contact_instagram text;
alter table public.customer_contacts add column if not exists contact_mobile text;
alter table public.customer_contacts add column if not exists replied boolean not null default false;

-- The inline email check from customer_contacts.sql (Postgres names it customer_contacts_customer_email_check) now allows null.
alter table public.customer_contacts drop constraint if exists customer_contacts_customer_email_check;
alter table public.customer_contacts add constraint customer_contacts_customer_email_check
  check (customer_email is null or (customer_email <> '' and customer_email = lower(customer_email)));

alter table public.customer_contacts drop constraint if exists customer_contacts_contact_instagram_check;
alter table public.customer_contacts add constraint customer_contacts_contact_instagram_check
  check (contact_instagram is null or (contact_instagram <> '' and contact_instagram = lower(contact_instagram) and contact_instagram !~ '^@'));

alter table public.customer_contacts drop constraint if exists customer_contacts_contact_mobile_check;
alter table public.customer_contacts add constraint customer_contacts_contact_mobile_check
  check (contact_mobile is null or contact_mobile ~ '^[0-9]{10}$');

-- Every contact is logged against someone.
alter table public.customer_contacts drop constraint if exists customer_contacts_has_key_check;
alter table public.customer_contacts add constraint customer_contacts_has_key_check
  check (customer_email is not null or contact_instagram is not null or contact_mobile is not null);

-- A lead's contacts by handle / mobile, newest first.
create index if not exists customer_contacts_instagram_idx on public.customer_contacts (contact_instagram, contacted_at desc) where contact_instagram is not null;
create index if not exists customer_contacts_mobile_idx on public.customer_contacts (contact_mobile, contacted_at desc) where contact_mobile is not null;

-- RLS stays on with NO policies (customer_contacts.sql): service role only. Nothing to grant.
