import 'server-only';
import {cache} from 'react';
import {unstable_cache} from 'next/cache';
import {CRM_CACHE_REVALIDATE, CRM_TAG} from './crm-cache';
import {envelope, MEMBERSHIP_FALLBACK, projectCheckoutSafe, projectCustomer, projectMembership, projectMetrics, projectOrder} from './crm-project';
import type {RemoteSpinLead} from './spin-leads-sync';
import type {CrmBirthdayVoucher, CrmCheckout, CrmCustomer, CrmMembershipConfig, CrmMetrics, CrmOrder} from './crm-types';

/**
 * Reader for the Zoomy CRM engine — a Cloudflare Worker over its own D1
 * database of Shopify customers, orders and abandoned checkouts.
 *
 * This is a live proxy, not an archive: the Worker is the system of record (the
 * Shopify webhooks land there), so Coop reads it per request rather than
 * keeping a copy that could disagree with the storefront admin. Reads are
 * cached for POS_CACHE_REVALIDATE-scale windows so a page and its prefetch do
 * not hit the Worker twice.
 *
 * SERVER-ONLY. The bearer token must never reach the browser. It is the
 * READ-scoped token (CRM_API_READ_TOKEN on the Worker), which opens /api and
 * not /admin — where a POST starts a real customer email batch.
 */

const base = process.env.CRM_API_URL?.replace(/\/$/, '');
const token = process.env.CRM_API_READ_TOKEN;

/** True when the CRM env is absent — pages render the empty state, not an error. */
export function crmConfigured(): boolean {
  return Boolean(base && token);
}

async function crmGet<T>(path: string): Promise<T> {
  if (!crmConfigured()) throw new Error('CRM_API_URL / CRM_API_READ_TOKEN not configured');
  const res = await fetch(`${base}${path}`, {
    headers: {Authorization: `Bearer ${token}`},
    // Caching is handled by unstable_cache below, so the fetch itself is not
    // also cached — otherwise a revalidation would serve the same stale body.
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`CRM ${res.status} for ${path}`);
  return res.json() as Promise<T>;
}

/**
 * Every spin-the-wheel lead Shopify holds, via the Worker's /api/spin-leads.
 * Uncached on purpose: it is only called by the leads page's Update button,
 * whose whole job is to get the current list. Throws when the Worker or
 * Shopify can't answer, so a failure is never reported as "no new leads".
 */
export async function fetchCrmSpinLeads(): Promise<RemoteSpinLead[]> {
  const {leads} = await crmGet<{leads: RemoteSpinLead[]}>('/api/spin-leads');
  return Array.isArray(leads) ? leads : [];
}

/* ---------- readers ---------- */

export const getCrmMetrics = cache((): Promise<CrmMetrics | null> =>
  crmConfigured() ? metricsCached() : Promise.resolve(null),
);

const metricsCached = unstable_cache(async (): Promise<CrmMetrics | null> => {
  try {
    return projectMetrics(await crmGet<unknown>('/api/metrics'));
  } catch (err) {
    // Fail soft, like the spin-leads reader: the CRM is one page of a
    // multi-channel dashboard, and the Worker being briefly unreachable must
    // not take the route down.
    console.warn(`CRM metrics read failed: ${(err as Error).message}`);
    return null;
  }
}, ['crm-metrics'], {revalidate: CRM_CACHE_REVALIDATE, tags: [CRM_TAG]});

export const getCrmCustomers = cache((): Promise<CrmCustomer[]> =>
  crmConfigured() ? customersCached() : Promise.resolve([]),
);

const customersCached = unstable_cache(async (): Promise<CrmCustomer[]> => {
  try {
    return (envelope(await crmGet<unknown>('/api/customers'), 'customers') ?? []).map(projectCustomer);
  } catch (err) {
    console.warn(`CRM customers read failed: ${(err as Error).message}`);
    return [];
  }
}, ['crm-customers'], {revalidate: CRM_CACHE_REVALIDATE, tags: [CRM_TAG]});

export const getCrmOrders = cache((): Promise<CrmOrder[]> =>
  crmConfigured() ? ordersCached() : Promise.resolve([]),
);

const ordersCached = unstable_cache(async (): Promise<CrmOrder[]> => {
  try {
    return (envelope(await crmGet<unknown>('/api/orders'), 'orders') ?? []).map(projectOrder);
  } catch (err) {
    console.warn(`CRM orders read failed: ${(err as Error).message}`);
    return [];
  }
}, ['crm-orders'], {revalidate: CRM_CACHE_REVALIDATE, tags: [CRM_TAG]});

export const getCrmCheckouts = cache((): Promise<CrmCheckout[]> =>
  crmConfigured() ? checkoutsCached() : Promise.resolve([]),
);

const checkoutsCached = unstable_cache(async (): Promise<CrmCheckout[]> => {
  try {
    // `raw` is the original Shopify payload. The progress stage is derived from
    // it HERE, on the server, and the blob itself is then dropped — the browser
    // needs the label, not the shopper's address. The stage is derived in src/crm-project.ts and the blob is dropped.
    // (The pages keep the recovery link: the Website CRM page shows it to staff.)
    return (envelope(await crmGet<unknown>('/api/checkouts'), 'checkouts') ?? []).map(
      (c): CrmCheckout => ({...projectCheckoutSafe(c), abandonedCheckoutUrl: typeof c.abandonedCheckoutUrl === 'string' ? c.abandonedCheckoutUrl : null}),
    );
  } catch (err) {
    console.warn(`CRM checkouts read failed: ${(err as Error).message}`);
    return [];
  }
}, ['crm-checkouts'], {revalidate: CRM_CACHE_REVALIDATE, tags: [CRM_TAG]});

export const getCrmBirthdayVouchers = cache((): Promise<CrmBirthdayVoucher[]> =>
  crmConfigured() ? birthdaysCached() : Promise.resolve([]),
);

const birthdaysCached = unstable_cache(async (): Promise<CrmBirthdayVoucher[]> => {
  try {
    const {birthdayVouchers} = await crmGet<{birthdayVouchers: CrmBirthdayVoucher[]}>(
      '/api/birthday-vouchers',
    );
    return birthdayVouchers ?? [];
  } catch (err) {
    console.warn(`CRM birthday vouchers read failed: ${(err as Error).message}`);
    return [];
  }
}, ['crm-birthday-vouchers'], {revalidate: CRM_CACHE_REVALIDATE, tags: [CRM_TAG]});

/**
 * Membership settings. Served by the Worker from the same Shopify metafield the
 * storefront admin edits, so the Platinum threshold shown here cannot drift
 * from the one the storefront uses. Cached for an hour — it changes a few times
 * a year and costs a Shopify round trip.
 */
export const getCrmMembershipConfig = cache((): Promise<CrmMembershipConfig> =>
  crmConfigured() ? membershipConfigCached() : Promise.resolve(MEMBERSHIP_FALLBACK),
);

const membershipConfigCached = unstable_cache(async (): Promise<CrmMembershipConfig> => {
  try {
    return projectMembership(await crmGet<unknown>('/api/membership-config'));
  } catch (err) {
    console.warn(`CRM membership config read failed: ${(err as Error).message}`);
    return MEMBERSHIP_FALLBACK;
  }
}, ['crm-membership-config'], {revalidate: 3600, tags: [CRM_TAG]});
