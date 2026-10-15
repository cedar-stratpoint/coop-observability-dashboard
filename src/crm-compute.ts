/**
 * Pure derivations for the CRM view. Kept free of server/client concerns so the
 * numbers can be unit-tested against the storefront admin's behaviour — the two
 * dashboards read the same API and must not disagree about what "Recovered" or
 * "Platinum" means.
 */
import type {CheckoutStage, CrmCheckout, CrmCustomer, CrmOrder} from './crm-types';

export type CartStatus = 'Active' | 'Recovered' | 'Converted';

/**
 * A cart's lifecycle state. "Recovered" is deliberately narrower than
 * "Converted": it means the purchase happened AFTER we emailed a reminder, so
 * it is the only one that can be credited to the recovery programme.
 */
export function cartStatus(c: Pick<CrmCheckout, 'convertedAt' | 'remindersSent'>): CartStatus {
  if (c.convertedAt && c.remindersSent > 0) return 'Recovered';
  if (c.convertedAt) return 'Converted';
  return 'Active';
}

/**
 * The start of the current membership spend window: January 1st, or the
 * programme start date when the programme began later in the same year.
 * Lexicographic compare is correct for zero-padded YYYY-MM-DD.
 */
export function membershipWindowStart(now: Date, programStart: string): string {
  const yearStart = `${now.getUTCFullYear()}-01-01`;
  return programStart > yearStart ? programStart : yearStart;
}

export type EnrichedCustomer = CrmCustomer & {
  /** Orders we captured for this customer (all statuses). */
  orderCount: number;
  /** Lifetime paid spend. */
  spent: number;
  /** Paid spend inside the current membership window — what Platinum measures. */
  spendYtd: number;
};

/**
 * Attach per-customer order counts and spend, computed from our own captured
 * orders rather than Shopify's `orders_count` / `total_spent` — those are not
 * populated on customers that entered via an order webhook. Matched on Shopify
 * customer id first, then email; only paid orders count toward spend.
 */
export function enrichCustomers(
  customers: CrmCustomer[],
  orders: Pick<CrmOrder, 'shopifyCustomerId' | 'email' | 'financialStatus' | 'totalPrice' | 'createdAt'>[],
  windowStart: string,
): EnrichedCustomer[] {
  const stats = new Map<string, {count: number; spent: number; spentYtd: number}>();
  for (const o of orders) {
    const key = o.shopifyCustomerId || (o.email ?? '').toLowerCase();
    if (!key) continue;
    const s = stats.get(key) ?? {count: 0, spent: 0, spentYtd: 0};
    s.count += 1;
    if (o.financialStatus === 'paid') {
      const amt = Number(o.totalPrice) || 0;
      s.spent += amt;
      if ((o.createdAt ?? '') >= windowStart) s.spentYtd += amt;
    }
    stats.set(key, s);
  }
  return customers.map((c) => {
    const s =
      stats.get(c.shopifyCustomerId) ??
      stats.get((c.email ?? '').toLowerCase()) ??
      {count: 0, spent: 0, spentYtd: 0};
    return {...c, orderCount: s.count, spent: s.spent, spendYtd: s.spentYtd};
  });
}

/**
 * Tier headcount. The tier is whatever the storefront stamped on the customer
 * (`custom.membership_tier`); anyone without one checked out as a guest and has
 * no membership at all — counted separately rather than folded into Gold.
 */
export function tierCounts(customers: CrmCustomer[]): {platinum: number; gold: number; guest: number} {
  return customers.reduce(
    (a, c) => {
      if (c.membershipTier === 'platinum') a.platinum += 1;
      else if (c.membershipTier === 'gold') a.gold += 1;
      else a.guest += 1;
      return a;
    },
    {platinum: 0, gold: 0, guest: 0},
  );
}

/** Order placement → fulfillment, as "2d 4h 30m". Unfulfilled reads as '—'. */
export function turnaround(placed: string | null, fulfilled: string | null): string {
  if (!placed || !fulfilled) return '—';
  const ms = new Date(fulfilled).getTime() - new Date(placed).getTime();
  if (Number.isNaN(ms) || ms < 0) return '—';
  const totalMin = Math.floor(ms / 60000);
  return `${Math.floor(totalMin / 1440)}d ${Math.floor((totalMin % 1440) / 60)}h ${totalMin % 60}m`;
}

/** Case-insensitive "does any of these fields contain the needle". */
export function textMatch(needle: string, fields: Array<string | null | undefined>): boolean {
  if (!needle) return true;
  return fields.some((f) => String(f ?? '').toLowerCase().includes(needle));
}

/**
 * A timestamp in Philippine time — the store, the customers and the team are
 * all in PH, so the zone is pinned rather than taken from the viewer's browser
 * (this matches the storefront admin, and a colleague abroad sees the hour the
 * customer actually saw).
 */
export function fmtPh(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-PH', {
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * How far a shopper got before abandoning, from the raw Shopify checkout
 * payload. Called on the server (crm-data.ts) so only the resulting label
 * crosses to the browser.
 *
 * Shipping counts as reached when an address was entered OR a shipping method
 * was computed, which implies one.
 */
export function checkoutStage(
  checkout: {email?: string | null; reachedPaymentAt?: string | null},
  raw: unknown,
): CheckoutStage {
  const r = (raw && typeof raw === 'object' ? raw : {}) as {
    email?: string;
    shipping_address?: {address1?: string; city?: string; zip?: string};
    shipping_lines?: unknown[];
  };
  if (checkout.reachedPaymentAt) return 'Payment';
  const addr = r.shipping_address ?? {};
  if (addr.address1 || addr.city || addr.zip || (r.shipping_lines?.length ?? 0) > 0) return 'Shipping';
  if (checkout.email || r.email) return 'Email';
  return 'Started';
}

/* ---------- table filters ---------- */

export type CartFilter = {stage: string; status: string; winback: string};
export type OrderFilter = {payment: string; fulfillment: string; reviewed: string};
export type CustomerFilter = {tier: string; buyers: string};

export const EMPTY_CART_FILTER: CartFilter = {stage: 'all', status: 'all', winback: 'all'};
export const EMPTY_ORDER_FILTER: OrderFilter = {payment: 'all', fulfillment: 'all', reviewed: 'all'};
export const EMPTY_CUSTOMER_FILTER: CustomerFilter = {tier: 'all', buyers: 'all'};

/** True when any of a filter set's fields is narrowed — drives "Clear". */
export function filterActive(f: Record<string, string>): boolean {
  return Object.values(f).some((v) => v !== 'all');
}

export function filterCarts(rows: CrmCheckout[], f: CartFilter, needle: string): CrmCheckout[] {
  return rows.filter(
    (c) =>
      textMatch(needle, [c.email]) &&
      (f.stage === 'all' || c.stage === f.stage) &&
      (f.status === 'all' || cartStatus(c) === f.status) &&
      (f.winback === 'all' || (f.winback === 'sent' ? Boolean(c.winbackSentAt) : !c.winbackSentAt)),
  );
}

export function filterOrders(rows: CrmOrder[], f: OrderFilter, needle: string): CrmOrder[] {
  return rows.filter(
    (o) =>
      textMatch(needle, [o.email, o.orderNumber, o.financialStatus]) &&
      (f.payment === 'all' || (o.financialStatus ?? '').toLowerCase() === f.payment) &&
      (f.fulfillment === 'all' ||
        (f.fulfillment === 'fulfilled' ? Boolean(o.fulfilledAt) : !o.fulfilledAt)) &&
      (f.reviewed === 'all' ||
        (f.reviewed === 'reviewed' ? Boolean(o.reviewSubmittedAt) : !o.reviewSubmittedAt)),
  );
}

export function filterCustomers(
  rows: EnrichedCustomer[],
  f: CustomerFilter,
  needle: string,
): EnrichedCustomer[] {
  return rows.filter(
    (c) =>
      textMatch(needle, [c.email, c.firstName, c.lastName, c.phone, c.petName, c.membershipTier]) &&
      (f.tier === 'all' || (f.tier === 'guest' ? !c.membershipTier : c.membershipTier === f.tier)) &&
      (f.buyers === 'all' || (f.buyers === 'buyers' ? c.orderCount > 0 : c.orderCount === 0)),
  );
}
