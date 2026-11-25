import 'server-only';
import {cache} from 'react';
import {unstable_cache} from 'next/cache';
import {CRM_CACHE_REVALIDATE, CRM_TAG} from './crm-cache';
import {loadContactRows, withColumnFallback, type ContactChannel, type CustomerContact} from './customer-contacts';
import {posClient, usingPosMock} from './pos-data';

/**
 * The manual contact log (customer_contacts, RET-05), read with the service-role key server-side only (RLS on, no
 * policies: the anon key sees nothing). Null = unavailable (mock mode, the table not applied yet, or a failed read):
 * the Customers tab and Ask Coop then show the manual count as unavailable, never 0. Read only, nothing here writes.
 *
 * Tagged CRM_TAG too, so the Website CRM page's Refresh button re-reads it with the rest of the page.
 */
export const CUSTOMER_CONTACTS_TAG = 'customer-contacts';

export const getCustomerContacts = cache((): Promise<CustomerContact[] | null> =>
  usingPosMock() ? Promise.resolve(null) : contactsCached(),
);

const contactsCached = unstable_cache(async (): Promise<CustomerContact[] | null> => {
  const supabase = posClient();
  // Paged (fetchAllRows inside loadContactRows): contacted_at desc for display, the PK `id` as the unique tiebreaker.
  const page = (columns: string) => (from: number, to: number) =>
    supabase
      .from('customer_contacts')
      .select(columns)
      .order('contacted_at', {ascending: false})
      .order('id', {ascending: true})
      .range(from, to);
  // RET-17: before supabase/customer_contacts_lead_keys.sql is applied the new columns answer 42703; the old select is used
  // then, so the page still loads (instagram / mobile null, replied false).
  return loadContactRows(withColumnFallback(
    page('id,customer_email,contact_instagram,contact_mobile,replied,channel,note,contacted_at,created_by'),
    page('id,customer_email,channel,note,contacted_at,created_by'),
  ));
}, ['customer-contacts'], {revalidate: CRM_CACHE_REVALIDATE, tags: [CUSTOMER_CONTACTS_TAG, CRM_TAG]});

/** Ask Coop's view of the log: one entry per logged contact, its email, channel and time (RET-07 last contacted); never the note or the author. Null = unavailable. */
export async function getManualContactEmails(): Promise<{email: string | null; channel: ContactChannel; contactedAt: string}[] | null> {
  const rows = await getCustomerContacts();
  return rows ? rows.map((r) => ({email: r.email, channel: r.channel, contactedAt: r.contactedAt})) : null;
}
