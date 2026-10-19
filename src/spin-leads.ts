import 'server-only';
import {cache} from 'react';
import {unstable_cache} from 'next/cache';
import {posClient, usingPosMock} from './pos-data';
import {POS_CACHE_REVALIDATE} from './pos-cache';
import {fetchAllRows} from './pos-fetch-paginate';
import type {SpinLead} from './spin-leads-types';

/**
 * Spin-the-wheel booth leads (spin_wheel_leads). The booth form on the
 * storefront saves each lead into Shopify, in the shop's
 * custom.newsletter_subscribers metafield (rows tagged source 'spin-win'), which
 * zoomyforpets.com/admin/spin-wheel shows. Coop copies them into this table:
 * the leads page's Update button pulls them through the CRM worker
 * (src/spin-leads-actions.ts), and scripts/import-spin-leads.mjs still imports
 * the admin's CSV export. Table DDL: supabase/spin_wheel_leads*.sql.
 *
 * Contact data, so this is read with the service-role key server-side only
 * (the table's RLS has no policies — the anon key sees nothing).
 */
/** Cleared by the leads page's Update button once new leads are written. */
export const SPIN_LEADS_TAG = 'spin-wheel-leads';

export const getSpinLeads = cache((): Promise<SpinLead[]> =>
  usingPosMock() ? Promise.resolve([]) : spinLeadsCached(),
);

const spinLeadsCached = unstable_cache(async (): Promise<SpinLead[]> => {
  const supabase = posClient();
  // Paged via fetchAllRows (collected_at desc for display, PK `lead_id` as the
  // unique tiebreaker) so a bare .select() can't be silently capped at
  // db.max_rows (1000) and drop leads.
  let data: Record<string, unknown>[];
  try {
    data = await fetchAllRows('spin_wheel_leads', (from, to) =>
      supabase
        .from('spin_wheel_leads')
        .select('*')
        .order('collected_at', {ascending: false})
        .order('lead_id', {ascending: true})
        .range(from, to));
  } catch (error) {
    // Fail soft, unlike the pos_* readers. Leads are one optional block at the
    // bottom of the event card, and the table is created per environment by hand
    // (supabase/spin_wheel_leads.sql) — an environment that has not run it yet
    // must still render sales, cash reconciliation and the rest of the page.
    console.warn(`spin_wheel_leads read failed, rendering events without leads: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }

  return data.map((l): SpinLead => ({
    email: (l.email as string | null) ?? null,
    // Absent until spin_wheel_leads_instagram.sql has run on this environment.
    instagram: (l.instagram as string | null) ?? null,
    pet: (l.pet as string | null) ?? null,
    // Absent until spin_wheel_leads_picky.sql has run on this environment.
    picky: (l.picky as string | null) ?? null,
    mobile: (l.mobile as string | null) ?? null,
    prize: (l.prize as string | null) ?? 'Unknown',
    campaign: (l.campaign as string | null) ?? null,
    collectedAt: l.collected_at as string,
    consentAt: (l.consent_at as string | null) ?? null,
  }));
}, ['spin-wheel-leads'], {revalidate: POS_CACHE_REVALIDATE, tags: [SPIN_LEADS_TAG]});
