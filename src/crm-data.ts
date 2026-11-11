import 'server-only';
import {cache} from 'react';
import {unstable_cache} from 'next/cache';
import {CRM_CACHE_REVALIDATE, CRM_TAG, PLAN_WEB_TAG} from './crm-cache';
import {envelope, MEMBERSHIP_FALLBACK, projectBirthdayVoucher, projectCheckoutSafe, projectCustomer, projectMembership, projectMetrics, projectOrder, type CrmBirthdayVoucherSafe} from './crm-project';
import {collectOrderPages, crmCoverage} from './plan-gmv';
import type {RemoteSpinLead} from './spin-leads-sync';
import type {CrmCheckout, CrmCustomer, CrmMembershipConfig, CrmMetrics, CrmOrder} from './crm-types';

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

// Trimmed like the chat's resolveCrmAccess: a pasted trailing space or newline in the env value must not break the pages.
const base = process.env.CRM_API_URL?.trim().replace(/\/+$/, '');
const token = process.env.CRM_API_READ_TOKEN?.trim();

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

/* ---------- readers ----------
 * The list readers return null when the CRM is not configured or the read failed (RET-04 audit finding): a page shows
 * "unavailable", never 0, and callers that only want a best-effort list write `?? []` themselves. */

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

export const getCrmCustomers = cache((): Promise<CrmCustomer[] | null> =>
  crmConfigured() ? customersCached() : Promise.resolve(null),
);

const customersCached = unstable_cache(async (): Promise<CrmCustomer[] | null> => {
  try {
    return (envelope(await crmGet<unknown>('/api/customers'), 'customers') ?? []).map(projectCustomer);
  } catch (err) {
    console.warn(`CRM customers read failed: ${(err as Error).message}`);
    return null;
  }
}, ['crm-customers'], {revalidate: CRM_CACHE_REVALIDATE, tags: [CRM_TAG]});

export const getCrmOrders = cache((): Promise<CrmOrder[] | null> =>
  crmConfigured() ? ordersCached() : Promise.resolve(null),
);

const ordersCached = unstable_cache(async (): Promise<CrmOrder[] | null> => {
  try {
    return (envelope(await crmGet<unknown>('/api/orders'), 'orders') ?? []).map(projectOrder);
  } catch (err) {
    console.warn(`CRM orders read failed: ${(err as Error).message}`);
    return null;
  }
}, ['crm-orders'], {revalidate: CRM_CACHE_REVALIDATE, tags: [CRM_TAG]});

/** The Business Health Report's Website orders and when the Worker was read for them (ISO time). */
export type PlanWebOrders = {orders: CrmOrder[]; truncated: boolean; syncedAt: string};

/**
 * The Business Health Report's Website read. Unlike getCrmOrders it never turns a failure into "no orders": null means the CRM is not
 * configured or any page failed (a gap on the report). It pages the Worker's filtered /api/orders from `fromDay` (the first plan month),
 * so `truncated` is only true when the page ceiling was hit. An old Worker that ignores the filter (no `next_cursor`) returns its newest
 * 1000, so that case keeps the cap rule with the /api/metrics order count.
 *
 * Synced on demand (BHR-09): the result is kept with no time limit until the report's Refresh expires PLAN_WEB_TAG, so a page reload
 * does not re-read the Worker. A failed read is NOT cached (it throws inside the cache, and unstable_cache stores only results), so the
 * next load tries again instead of pinning a gap until someone presses Refresh.
 */
export const getCrmOrdersForPlan = cache(async (fromDay: string): Promise<PlanWebOrders | null> => {
  if (!crmConfigured()) return null;
  try {
    return await ordersForPlanCached(fromDay);
  } catch (err) {
    console.warn(`CRM orders (plan) read failed: ${(err as Error).message}`);
    return null;
  }
});

const ordersForPlanCached = unstable_cache(async (fromDay: string): Promise<PlanWebOrders> => {
  const fields = 'shopifyOrderId,createdAt,financialStatus,totalPrice';
  const read = await collectOrderPages<CrmOrder>(async (cursor) => {
    // lines=1: each order's line price and quantity, for Shopify gross sales (src/plan-gmv.ts orderGross).
    const qs = `from=${encodeURIComponent(fromDay)}&limit=500&fields=${fields}&lines=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const body = await crmGet<{next_cursor?: string | null}>(`/api/orders?${qs}`);
    return {orders: (envelope(body, 'orders') ?? []).map(projectOrder), nextCursor: body.next_cursor};
  });
  const syncedAt = new Date().toISOString();
  if (!read.legacy) return {orders: read.orders, truncated: !read.complete, syncedAt};
  const metrics = await getCrmMetrics(); // soft: null just means we rely on the cap alone
  return {orders: read.orders, truncated: crmCoverage(read.orders.length, metrics?.orders ?? null).truncated, syncedAt};
}, ['crm-orders-plan-synced'], {revalidate: false, tags: [PLAN_WEB_TAG]});

export const getCrmCheckouts = cache((): Promise<CrmCheckout[] | null> =>
  crmConfigured() ? checkoutsCached() : Promise.resolve(null),
);

const checkoutsCached = unstable_cache(async (): Promise<CrmCheckout[] | null> => {
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
    return null;
  }
}, ['crm-checkouts'], {revalidate: CRM_CACHE_REVALIDATE, tags: [CRM_TAG]});

/** The voucher ledger, projected on the server (projectBirthdayVoucher keeps email, year, tier, sentAt): no voucher code reaches the page. */
export const getCrmBirthdayVouchers = cache((): Promise<CrmBirthdayVoucherSafe[] | null> =>
  crmConfigured() ? birthdaysCached() : Promise.resolve(null),
);

const birthdaysCached = unstable_cache(async (): Promise<CrmBirthdayVoucherSafe[] | null> => {
  try {
    return (envelope(await crmGet<unknown>('/api/birthday-vouchers'), 'birthdayVouchers') ?? []).map(projectBirthdayVoucher);
  } catch (err) {
    console.warn(`CRM birthday vouchers read failed: ${(err as Error).message}`);
    return null;
  }
}, ['crm-birthday-vouchers-safe'], {revalidate: CRM_CACHE_REVALIDATE, tags: [CRM_TAG]});

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
