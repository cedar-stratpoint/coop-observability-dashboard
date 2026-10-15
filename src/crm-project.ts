// The website CRM field contract (spec 4.4): pure projections of the Worker's /api responses into crm-types.ts. ONE definition for
// both readers: the pages' live proxy (src/crm-data.ts) and Ask Coop's GET-only client (src/chat/crm/). A field is copied only when
// it is listed here, so a field the Worker adds later is dropped until someone adds it on purpose.
// Never projected: `raw` (the Shopify payload; reduced to `stage` here), `abandonedCheckoutUrl` (only the pages add it back, in
// crm-data.ts), the birthday voucher `code` (there is no voucher projection). Ask Coop sees none of them.
import {checkoutStage} from './crm-compute';
import {parseLineItems} from './custom-range';
import type {CrmCheckout, CrmCustomer, CrmMembershipConfig, CrmMetrics, CrmOrder} from './crm-types';

export type CrmCheckoutSafe = Omit<CrmCheckout, 'abandonedCheckoutUrl'>;
type Rec = Record<string, unknown>;

/** Fallbacks matching the storefront's own constants (app/lib/membership-tier.js). */
export const MEMBERSHIP_FALLBACK: CrmMembershipConfig = Object.freeze({platinumThreshold: 2000, programStart: '2026-07-01'});

export const num = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};
const numOrNull = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const str = (v: unknown): string | null => (typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : null);
const rec = (v: unknown): Rec => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {});

/** The list inside a Worker response: {<key>: [...]}, {data: [...]} or a bare array (the backend's paged reader sees all three). null = no list. */
export function envelope(body: unknown, key: string): Rec[] | null {
  const o = rec(body);
  const list = Array.isArray(body) ? body : Array.isArray(o[key]) ? o[key] : o.data;
  return Array.isArray(list) ? list.filter((x): x is Rec => x !== null && typeof x === 'object' && !Array.isArray(x)) : null;
}

/** Shopify's payload arrives as a JSON string; junk is treated as absent. */
function parseRaw(raw: unknown): unknown {
  if (raw !== null && typeof raw === 'object') return raw;
  if (typeof raw !== 'string' || raw === '') return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export function projectMetrics(body: unknown): CrmMetrics {
  const m = rec(body);
  return {
    customers: num(m.customers),
    orders: num(m.orders),
    totalRevenue: num(m.totalRevenue),
    ordersLast7Days: num(m.ordersLast7Days),
    revenueLast7Days: num(m.revenueLast7Days),
    abandonedActive: num(m.abandonedActive),
    recovered: num(m.recovered),
    reminded: num(m.reminded),
    revenueRecovered: num(m.revenueRecovered),
    recoveryRate: num(m.recoveryRate),
  };
}

export function projectCustomer(c: Rec): CrmCustomer {
  return {
    shopifyCustomerId: String(c.shopifyCustomerId),
    email: str(c.email),
    firstName: str(c.firstName),
    lastName: str(c.lastName),
    phone: str(c.phone),
    ordersCount: numOrNull(c.ordersCount),
    totalSpent: str(c.totalSpent),
    membershipTier: str(c.membershipTier),
    petName: str(c.petName),
    petBirthday: str(c.petBirthday),
    emailMarketingState: str(c.emailMarketingState),
    createdAt: str(c.createdAt),
    updatedAt: str(c.updatedAt),
  };
}

export function projectOrder(o: Rec): CrmOrder {
  return {
    shopifyOrderId: String(o.shopifyOrderId),
    shopifyCustomerId: str(o.shopifyCustomerId),
    orderNumber: str(o.orderNumber),
    email: str(o.email),
    totalPrice: str(o.totalPrice),
    currency: str(o.currency),
    financialStatus: str(o.financialStatus),
    fulfillmentStatus: str(o.fulfillmentStatus),
    createdAt: str(o.createdAt),
    fulfilledAt: str(o.fulfilledAt),
    reviewRequestSentAt: str(o.reviewRequestSentAt),
    reviewSubmittedAt: str(o.reviewSubmittedAt),
    // ponytail: raw Shopify JSON (~2.3KB/order); past ~850 orders the pages' cache entry nears Next's 2MB limit, so slim it to
    // title/quantity/price/discounts then.
    lineItems: typeof o.lineItems === 'string' ? o.lineItems : o.lineItems === null || o.lineItems === undefined ? null : JSON.stringify(o.lineItems),
  };
}

/** What Ask Coop may know of a line item: numbers and the product title. No properties, SKU, vendor or any other free text. */
export type CrmLineItemSafe = {title: string; quantity: number; price: number; discount: number};
export type CrmOrderChat = Omit<CrmOrder, 'lineItems'> & {lineItems: CrmLineItemSafe[]};

/** An order for the model: the pages' fields, with the raw Shopify line-item JSON (customer notes, gift messages, SKUs) reduced to {title, quantity, price, discount}. */
export function projectOrderChat(o: Rec): CrmOrderChat {
  const {lineItems: _raw, ...rest} = projectOrder(o);
  return {...rest, lineItems: parseLineItems(o.lineItems).map((i) => ({title: i.title.slice(0, 120), quantity: i.quantity, price: i.unitPrice, discount: i.discount}))};
}

/** A checkout without its recovery link; the progress stage is derived from `raw` here and the blob is dropped. */
export function projectCheckoutSafe(c: Rec): CrmCheckoutSafe {
  const email = str(c.email);
  const reachedPaymentAt = str(c.reachedPaymentAt);
  return {
    shopifyCheckoutId: String(c.shopifyCheckoutId),
    email,
    totalPrice: str(c.totalPrice),
    currency: str(c.currency),
    createdAt: str(c.createdAt),
    updatedAt: str(c.updatedAt),
    convertedAt: str(c.convertedAt),
    remindersSent: num(c.remindersSent),
    lastReminderAt: str(c.lastReminderAt),
    reachedPaymentAt,
    winbackSentAt: str(c.winbackSentAt),
    stage: checkoutStage({email, reachedPaymentAt}, parseRaw(c.raw)),
  };
}

export function projectMembership(body: unknown): CrmMembershipConfig {
  const m = rec(body);
  return {
    platinumThreshold: numOrNull(m.platinumThreshold) ?? MEMBERSHIP_FALLBACK.platinumThreshold,
    programStart: str(m.programStart) ?? MEMBERSHIP_FALLBACK.programStart,
  };
}
