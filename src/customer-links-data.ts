import 'server-only';
import {cache} from 'react';
import {unstable_cache} from 'next/cache';
import {CRM_CACHE_REVALIDATE, CRM_TAG} from './crm-cache';
import {loadLinkRows, type CustomerLink} from './customer-links';
import {posClient, usingPosMock} from './pos-data';

/**
 * The "Same person" links (customer_links, RET-15 Slice B), read with the service-role key server-side only (RLS on, no
 * policies). Null = unavailable (mock mode, the table not applied yet, or a failed read): the Website CRM table then shows
 * the Instagram and Booth cells as "unknown", never "—". Tagged CRM_TAG too, so the page's Refresh re-reads it.
 */
export const CUSTOMER_LINKS_TAG = 'customer-links';

export const getCustomerLinks = cache((): Promise<CustomerLink[] | null> =>
  usingPosMock() ? Promise.resolve(null) : linksCached(),
);

const linksCached = unstable_cache(async (): Promise<CustomerLink[] | null> => {
  const supabase = posClient();
  return loadLinkRows((from, to) =>
    supabase
      .from('customer_links')
      .select('id,customer_email,lead_email,lead_mobile,lead_instagram,lead_campaign,created_by')
      .order('created_at', {ascending: false})
      .order('id', {ascending: true})
      .range(from, to));
}, ['customer-links'], {revalidate: CRM_CACHE_REVALIDATE, tags: [CUSTOMER_LINKS_TAG, CRM_TAG]});
