/**
 * Pure derivations for the CRM view. Kept free of server/client concerns so the
 * numbers can be unit-tested against the storefront admin's behaviour — the two
 * dashboards read the same API and must not disagree about what "Recovered" or
 * "Platinum" means.
 */
import {parseLineItems, phDay, phDayStart} from './custom-range';
import type {CheckoutStage, CrmCheckout, CrmCustomer, CrmOrder} from './crm-types';
import {CHANNEL_LABEL, CONTACT_CHANNELS, type ContactChannel} from './customer-contacts';

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
  /** Orders we captured for this customer, any payment status, test orders excluded. */
  orderCount: number;
  /** Lifetime paid spend (test orders excluded). */
  spent: number;
  /** Paid spend inside the current membership window — what Platinum measures. */
  spendYtd: number;
  /** createdAt of the earliest and latest counted order (null when none). */
  firstOrderAt: string | null;
  lastOrderAt: string | null;
  /** RET-06: the cohort key of the first counted order's discount code (firstOrderCode); null when there is no counted order. */
  firstOrderCode: string | null;
};

type Stats = {count: number; spent: number; spentYtd: number; first: string | null; last: string | null; firstCodes: readonly string[]};
const ms = (iso: string | null): number => Date.parse(String(iso ?? ''));

/**
 * Attach per-customer order counts, spend and first/last order, computed from our own captured
 * orders rather than Shopify's `orders_count` / `total_spent` — those are not
 * populated on customers that entered via an order webhook. Matched on Shopify
 * customer id first, then email. Owner rules (2026-11-09): an order counts in any
 * payment status but a test order counts nowhere; only paid orders count toward spend.
 */
export function enrichCustomers(
  customers: CrmCustomer[],
  orders: Pick<CrmOrder, 'shopifyCustomerId' | 'email' | 'financialStatus' | 'totalPrice' | 'createdAt' | 'test' | 'discountCodes'>[],
  windowStart: string,
): EnrichedCustomer[] {
  const stats = new Map<string, Stats>();
  for (const o of orders) {
    if (o.test === true) continue;
    const key = o.shopifyCustomerId || (o.email ?? '').toLowerCase();
    if (!key) continue;
    const s = stats.get(key) ?? {count: 0, spent: 0, spentYtd: 0, first: null, last: null, firstCodes: []};
    s.count += 1;
    if (o.financialStatus === 'paid') {
      const amt = Number(o.totalPrice) || 0;
      s.spent += amt;
      if ((o.createdAt ?? '') >= windowStart) s.spentYtd += amt;
    }
    const t = ms(o.createdAt);
    if (Number.isFinite(t)) {
      if (s.first === null || t < ms(s.first)) {
        s.first = o.createdAt;
        s.firstCodes = o.discountCodes ?? [];
      }
      if (s.last === null || t > ms(s.last)) s.last = o.createdAt;
    }
    stats.set(key, s);
  }
  return customers.map((c) => {
    const s = stats.get(c.shopifyCustomerId) ?? stats.get((c.email ?? '').toLowerCase());
    if (!s) return {...c, orderCount: 0, spent: 0, spendYtd: 0, firstOrderAt: null, lastOrderAt: null, firstOrderCode: null};
    return {...c, orderCount: s.count, spent: s.spent, spendYtd: s.spentYtd, firstOrderAt: s.first, lastOrderAt: s.last, firstOrderCode: s.count > 0 ? firstOrderCode(s.firstCodes) : null};
  });
}

/**
 * How often one address was contacted (RET-03, RET-05; shared by the Customers tab and Ask Coop). The four automated CRM emails,
 * `automated` = their sum, `manual` = contacts the team logged by hand (customer_contacts), `total` = automated + manual.
 * RET-07: `lastAt` / `lastKind` = the newest dated contact of any kind (null when none of its contacts carries a readable date).
 */
export type ContactTally = {reminders: number; winback: number; reviewRequests: number; birthdayVouchers: number; automated: number; manual: number; total: number; lastAt: string | null; lastKind: ContactKind | null};
type AutomatedKey = 'reminders' | 'winback' | 'reviewRequests' | 'birthdayVouchers';
/** RET-07: what the last contact was. An automated CRM email kind, or the manual log's own channel (the two sets never overlap). */
export type ContactKind = 'reminder' | 'winback' | 'review_request' | 'birthday_voucher' | ContactChannel;
export const CONTACT_KIND_LABEL: Readonly<Record<ContactKind, string>> = Object.freeze({
  reminder: 'Cart reminder',
  winback: 'Win-back email',
  review_request: 'Review request',
  birthday_voucher: 'Birthday voucher',
  ...CHANNEL_LABEL,
});
const emailKey = (e: string | null | undefined): string => (e ?? '').trim().toLowerCase();
const channelKind = (c: string | null | undefined): ContactChannel => ((CONTACT_CHANNELS as readonly unknown[]).includes(c) ? (c as ContactChannel) : 'other');

/**
 * The per-email contact tally, keyed by trimmed lower-cased email. Owner rules (2026-11-10): cart reminders = checkouts.remindersSent
 * summed; win-back = 1 per checkout with winbackSentAt; review requests = 1 per order with reviewRequestSentAt, test orders excluded;
 * birthday vouchers = 1 per voucher row; manual = 1 per logged contact. Rows without an email are skipped. Only addresses with at
 * least one contact are present. RET-07 (2026-11-11): the newest timestamp of a counted contact wins (lastReminderAt, winbackSentAt,
 * reviewRequestSentAt, voucher sentAt, contactedAt); an unparseable date still counts but never dates the contact.
 */
export function contactTally(src: {
  checkouts: readonly (Pick<CrmCheckout, 'email' | 'remindersSent' | 'winbackSentAt'> & Partial<Pick<CrmCheckout, 'lastReminderAt'>>)[];
  orders: readonly Pick<CrmOrder, 'email' | 'reviewRequestSentAt' | 'test'>[];
  birthdayVouchers: readonly {email: string | null; sentAt?: string | null}[];
  manualContacts?: readonly {email: string | null; channel?: string | null; contactedAt?: string | null}[];
}): Map<string, ContactTally> {
  const out = new Map<string, ContactTally>();
  const add = (email: string | null | undefined, k: AutomatedKey | 'manual', n: number, at: string | null | undefined, kind: ContactKind) => {
    const key = emailKey(email);
    if (!key || !(n > 0)) return;
    const t = out.get(key) ?? {reminders: 0, winback: 0, reviewRequests: 0, birthdayVouchers: 0, automated: 0, manual: 0, total: 0, lastAt: null, lastKind: null};
    t[k] += n;
    if (k !== 'manual') t.automated += n;
    t.total += n;
    const when = ms(at ?? null);
    if (Number.isFinite(when) && (t.lastAt === null || when > ms(t.lastAt))) {
      t.lastAt = at as string;
      t.lastKind = kind;
    }
    out.set(key, t);
  };
  for (const c of src.checkouts) {
    add(c.email, 'reminders', Number(c.remindersSent) || 0, c.lastReminderAt, 'reminder');
    if (c.winbackSentAt) add(c.email, 'winback', 1, c.winbackSentAt, 'winback');
  }
  for (const o of src.orders) if (o.test !== true && o.reviewRequestSentAt) add(o.email, 'reviewRequests', 1, o.reviewRequestSentAt, 'review_request');
  for (const v of src.birthdayVouchers) add(v.email, 'birthdayVouchers', 1, v.sentAt, 'birthday_voucher');
  for (const m of src.manualContacts ?? []) add(m.email, 'manual', 1, m.contactedAt, channelKind(m.channel));
  return out;
}

/* ---------- RET-08: one customer's profile (8B) and communication timeline (8C), from the lists the page already reads ---------- */

/**
 * The orders that belong to one customer, newest first, test orders kept (the profile tags them). The same match as
 * enrichCustomers: orders carrying this customer id, else (only when none of those counts) orders with no customer id and this email.
 */
export function customerOrders<T extends Pick<CrmOrder, 'shopifyCustomerId' | 'email' | 'createdAt' | 'test'>>(c: Pick<CrmCustomer, 'shopifyCustomerId' | 'email'>, orders: readonly T[]): T[] {
  const byId = orders.filter((o) => o.shopifyCustomerId === c.shopifyCustomerId);
  const key = emailKey(c.email);
  const byEmail = key ? orders.filter((o) => !o.shopifyCustomerId && emailKey(o.email) === key) : [];
  const counted = (l: T[]) => l.some((o) => o.test !== true);
  const mine = counted(byId) ? byId : counted(byEmail) ? byEmail : [...byId, ...byEmail];
  return [...mine].sort((a, b) => (ms(b.createdAt) || 0) - (ms(a.createdAt) || 0));
}

/** Filter-chip groups. `account` (account created) shows only under All. */
export type TimelineGroup = 'orders' | 'checkouts' | 'emails' | 'manual' | 'account';
/** A contact event's kind is 7A's ContactKind, so the timeline and Last contacted name the same thing. */
export type TimelineKind = 'account_created' | 'order_placed' | 'order_fulfilled' | 'review_submitted' | 'checkout_abandoned' | ContactKind;
export type TimelineEvent = {
  /** Stable React key. */
  id: string;
  kind: TimelineKind;
  group: TimelineGroup;
  /** Null when the source has no readable date: still listed, after the dated events. */
  at: string | null;
  /** Counts toward times contacted (exactly the events contactTally counts); `count` = how many contacts it stands for. */
  contact: boolean;
  count: number;
  /** A Shopify test order's event: shown, tagged, counted nowhere. */
  test: boolean;
  orderId?: string;
  orderNumber?: string | null;
  total?: string | null;
  currency?: string | null;
  items?: {title: string; quantity: number; unitPrice: number}[];
  codes?: string[];
  turnaround?: string;
  checkoutId?: string;
  stage?: CheckoutStage;
  status?: CartStatus;
  /** Only on an open (unconverted) checkout, and only when the page read it. Never in Ask Coop or a CSV. */
  recoveryUrl?: string | null;
  /** Cart reminders: the CRM keeps only the last reminder's date, so `at` is that date and the count is the total. */
  lastDateOnly?: boolean;
  year?: number;
  note?: string | null;
  by?: string;
};

export const TIMELINE_GROUP_LABEL: Readonly<Record<Exclude<TimelineGroup, 'account'>, string>> = Object.freeze({
  orders: 'Orders',
  checkouts: 'Abandoned checkouts',
  emails: 'Emails',
  manual: 'Manual',
});

/**
 * Everything that happened with one customer, newest first (RET-08 / 8C). Orders, fulfilment and reviews come from customerOrders;
 * the contacts follow contactTally exactly (matched by email, test-order review requests not counted, reminders = one event ×N), so
 * the newest contact event is customerRows' last contacted and the contact counts sum to times contacted.
 */
export function customerTimeline(
  c: Pick<CrmCustomer, 'shopifyCustomerId' | 'email' | 'createdAt'>,
  src: {
    orders: readonly CrmOrder[];
    checkouts: readonly (Omit<CrmCheckout, 'abandonedCheckoutUrl'> & Partial<Pick<CrmCheckout, 'abandonedCheckoutUrl'>>)[];
    birthdayVouchers: readonly {email: string | null; year?: number; sentAt?: string | null}[];
    manualContacts: readonly {id: string; email: string | null; channel?: string | null; note?: string | null; contactedAt?: string | null; createdBy?: string}[];
  },
): TimelineEvent[] {
  const key = emailKey(c.email);
  const mailOf = (e: string | null | undefined) => key !== '' && emailKey(e) === key;
  const ev: TimelineEvent[] = [];
  const push = (e: Omit<TimelineEvent, 'contact' | 'count' | 'test'> & Partial<Pick<TimelineEvent, 'contact' | 'count' | 'test'>>) =>
    ev.push({contact: false, count: 0, test: false, ...e});
  if (c.createdAt) push({id: 'account', kind: 'account_created', group: 'account', at: c.createdAt});
  for (const o of customerOrders(c, src.orders)) {
    const base = {orderId: o.shopifyOrderId, orderNumber: o.orderNumber, test: o.test === true};
    const items = parseLineItems(o.lineItems).map(({title, quantity, unitPrice}) => ({title, quantity, unitPrice}));
    push({...base, id: `order:${o.shopifyOrderId}`, kind: 'order_placed', group: 'orders', at: o.createdAt, total: o.totalPrice, currency: o.currency, items, codes: o.discountCodes ?? []});
    if (o.fulfilledAt) push({...base, id: `fulfilled:${o.shopifyOrderId}`, kind: 'order_fulfilled', group: 'orders', at: o.fulfilledAt, turnaround: turnaround(o.createdAt, o.fulfilledAt)});
    if (o.reviewSubmittedAt) push({...base, id: `reviewed:${o.shopifyOrderId}`, kind: 'review_submitted', group: 'orders', at: o.reviewSubmittedAt});
  }
  // Review requests are matched by the order's email, as contactTally counts them.
  for (const o of src.orders) {
    if (!o.reviewRequestSentAt || !mailOf(o.email)) continue;
    const test = o.test === true;
    push({id: `review:${o.shopifyOrderId}`, kind: 'review_request', group: 'emails', at: o.reviewRequestSentAt, orderId: o.shopifyOrderId, orderNumber: o.orderNumber, test, contact: !test, count: test ? 0 : 1});
  }
  for (const k of src.checkouts) {
    if (!mailOf(k.email)) continue;
    const status = cartStatus(k);
    push({
      id: `checkout:${k.shopifyCheckoutId}`, kind: 'checkout_abandoned', group: 'checkouts', at: k.createdAt ?? k.updatedAt, checkoutId: k.shopifyCheckoutId,
      total: k.totalPrice, currency: k.currency, stage: k.stage, status, recoveryUrl: status === 'Active' ? (k.abandonedCheckoutUrl ?? null) : null,
    });
    const n = Number(k.remindersSent) || 0;
    if (n > 0) push({id: `reminder:${k.shopifyCheckoutId}`, kind: 'reminder', group: 'emails', at: k.lastReminderAt ?? null, checkoutId: k.shopifyCheckoutId, lastDateOnly: true, contact: true, count: n});
    if (k.winbackSentAt) push({id: `winback:${k.shopifyCheckoutId}`, kind: 'winback', group: 'emails', at: k.winbackSentAt, checkoutId: k.shopifyCheckoutId, contact: true, count: 1});
  }
  src.birthdayVouchers.forEach((v, i) => {
    if (mailOf(v.email)) push({id: `voucher:${v.year ?? ''}:${i}`, kind: 'birthday_voucher', group: 'emails', at: v.sentAt || null, year: v.year, contact: true, count: 1});
  });
  for (const m of src.manualContacts) {
    if (mailOf(m.email)) push({id: `manual:${m.id}`, kind: channelKind(m.channel), group: 'manual', at: m.contactedAt ?? null, note: m.note ?? null, by: m.createdBy, contact: true, count: 1});
  }
  // Newest first; undated last (stable, so their source order is kept).
  return ev.sort((a, b) => {
    const x = ms(a.at);
    const y = ms(b.at);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return Number(!Number.isFinite(x)) - Number(!Number.isFinite(y));
    return y - x;
  });
}

/** The To Platinum bar: share of the threshold reached this membership year (0–100) and the pesos still to go. */
export function toPlatinum(spendYtd: number, threshold: number): {pct: number; left: number} {
  if (!(threshold > 0)) return {pct: 100, left: 0};
  return {pct: Math.min(100, Math.round((spendYtd / threshold) * 100)), left: Math.max(0, threshold - spendYtd)};
}

export type PetBirthdayStatus = 'Sent' | 'Upcoming' | 'Passed';
/** This year's birthday voucher: Sent when the ledger has one for this email and PH year; else Upcoming / Passed by the PH day. */
export function petBirthdayStatus(
  c: Pick<CrmCustomer, 'email' | 'petBirthday'>,
  vouchers: readonly {email: string | null; year?: number}[],
  now: Date,
): PetBirthdayStatus | null {
  const md = /(\d{2})-(\d{2})$/.exec(String(c.petBirthday ?? '').trim().slice(0, 10));
  if (!md) return null;
  const today = phDay(now.getTime());
  const key = emailKey(c.email);
  if (key && vouchers.some((v) => v.year === Number(today.slice(0, 4)) && emailKey(v.email) === key)) return 'Sent';
  return `${md[1]}-${md[2]}` < today.slice(5) ? 'Passed' : 'Upcoming';
}

/* ---------- retention rules (RET-02/03/04): ONE implementation for the Customers tab and Ask Coop ---------- */

const DAY_MS = 86_400_000;

/** The PH calendar day an ISO instant falls on, or null when it does not parse. */
export function phDayOf(iso: string | null | undefined): string | null {
  const t = Date.parse(String(iso ?? ''));
  return Number.isFinite(t) ? phDay(t) : null;
}

/** Philippine calendar days from an instant to `now` (null when there is no instant). */
export function phDaysSince(iso: string | null | undefined, now: Date): number | null {
  const d = phDayOf(iso);
  return d === null ? null : Math.round((phDayStart(phDay(now.getTime())) - phDayStart(d)) / DAY_MS);
}

/** Closed outreach audiences (RET-03). "all" = no audience rule. */
export const CUSTOMER_AUDIENCES = ['all', 'repeat_promo', 'win_back'] as const;
export type CustomerAudience = (typeof CUSTOMER_AUDIENCES)[number];
/** The owner's outreach rules (2026-11-10), fixed in code: counted orders (test orders excluded) and PH days since the last counted order. */
export const AUDIENCE_RULES: Readonly<Record<Exclude<CustomerAudience, 'all'>, {minOrders: number; maxOrders: number | null; minDays: number}>> = Object.freeze({
  repeat_promo: Object.freeze({minOrders: 1, maxOrders: 1, minDays: 30}),
  win_back: Object.freeze({minOrders: 2, maxOrders: null, minDays: 60}),
});

export function inAudience(c: Pick<EnrichedCustomer, 'orderCount' | 'lastOrderAt'>, audience: CustomerAudience, now: Date): boolean {
  if (audience === 'all') return true;
  const rule = AUDIENCE_RULES[audience];
  const days = phDaysSince(c.lastOrderAt, now);
  return c.orderCount >= rule.minOrders && (rule.maxOrders === null || c.orderCount <= rule.maxOrders) && days !== null && days >= rule.minDays;
}

/** Sort by last order (1 = oldest first); customers with no order sort last whichever way it runs. */
export function compareLastOrder(dir: 1 | -1) {
  const at = (iso: string | null): number => Date.parse(String(iso ?? '')) || 0;
  return (a: Pick<EnrichedCustomer, 'lastOrderAt'>, b: Pick<EnrichedCustomer, 'lastOrderAt'>): number =>
    a.lastOrderAt === null || b.lastOrderAt === null ? Number(a.lastOrderAt === null) - Number(b.lastOrderAt === null) : dir * (at(a.lastOrderAt) - at(b.lastOrderAt));
}

/**
 * The repeat buyer rate TARGET, in percent: a plan target, never an actual (lesson plan-workbook-is-targets-only). Source: the owner's
 * retention brief (customers-feature-brief/customer-retention-and-outreach) and the plan workbook's C118 note ("the pitch says 25%").
 */
export const REPEAT_TARGET_PCT = 25;

/** The owner's repeat buyer rate (2026-11-09): buyers with 2+ counted orders / buyers with 1+, all time, one decimal. Null with no buyers. */
export function repeatRate(orderCounts: readonly number[]): {repeat: number; buyers: number; ratePct: number | null} {
  const buyers = orderCounts.filter((n) => n >= 1).length;
  const repeat = orderCounts.filter((n) => n >= 2).length;
  return {repeat, buyers, ratePct: buyers === 0 ? null : Math.round((repeat * 1000) / buyers) / 10};
}

/* ---------- RET-06: cohorts by the first counted order's discount code (the event-promo proxy) ---------- */

export const NO_CODE = 'no code';
export const BIRTHDAY_COHORT = 'birthday voucher';
export const BUNDLE_COHORT = 'BUNDLE (auto)';
/** Under this many buyers a cohort is a small group: its rate is shown but flagged, never ranked as a finding. */
export const SMALL_COHORT = 5;

/**
 * The cohort key from the first counted order's codes (owner rules 2026-11-10): the first listed code, upper-cased; "no code" without
 * one. A BDAY- code identifies one person (single-use birthday voucher), so it is never a key: "birthday voucher". BUNDLE- codes are
 * generated per bundle, so they collapse to "BUNDLE (auto)". Which code was which event is the owner's mapping, never guessed here.
 */
export function firstOrderCode(codes: readonly string[]): string {
  const code = (codes[0] ?? '').trim().toUpperCase();
  if (code === '') return NO_CODE;
  if (code.startsWith('BDAY-')) return BIRTHDAY_COHORT;
  if (code.startsWith('BUNDLE-')) return BUNDLE_COHORT;
  return code;
}

export type CodeCohort = {group: string; buyers: number; repeat: number; ratePct: number; small: boolean};

/** Buyers per first-order code, with repeat buyers (2+ counted orders) and the repeat rate (repeatRate), biggest first, ties by name. Non-buyers are in no cohort. */
export function codeCohorts(rows: readonly Pick<EnrichedCustomer, 'orderCount' | 'firstOrderCode'>[]): CodeCohort[] {
  const acc = new Map<string, number[]>();
  for (const c of rows) {
    if (c.orderCount < 1 || c.firstOrderCode === null) continue;
    acc.set(c.firstOrderCode, [...(acc.get(c.firstOrderCode) ?? []), c.orderCount]);
  }
  return [...acc.entries()]
    .map(([group, counts]) => {
      const r = repeatRate(counts);
      return {group, buyers: r.buyers, repeat: r.repeat, ratePct: r.ratePct ?? 0, small: r.buyers < SMALL_COHORT};
    })
    .sort((x, y) => y.buyers - x.buyers || x.group.localeCompare(y.group));
}

/** The orders bucket a customer falls in: 0, 1, 2, 3 or 4+. */
export const ordersBucket = (n: number): string => (n >= 4 ? '4+' : String(n));

/**
 * The Customers tab row: the enriched customer plus days since last order, consent and how often they were contacted.
 * Null = a source unread: emails sent (automated) when a CRM list did not answer, manual contacts when the log is not applied,
 * times contacted (their sum) when either is unknown. Never 0 for unknown.
 * RET-07 last contacted: `lastContactKnown` is false when any source is unread (R3: unknown, never "never"); known with a null
 * `lastContactedAt` = never contacted (R2).
 */
export type CustomerRow = EnrichedCustomer & {
  daysSinceLastOrder: number | null;
  emailsSent: number | null;
  manualContacts: number | null;
  timesContacted: number | null;
  lastContactedAt: string | null;
  lastContactKind: ContactKind | null;
  lastContactKnown: boolean;
  consent: string;
};

/** `known` says which parts of `tally` were read; by default the automated part is known when a tally is given and the manual part is not. */
export function customerRows(
  enriched: readonly EnrichedCustomer[],
  tally: Map<string, ContactTally> | null,
  now: Date,
  known: {automated: boolean; manual: boolean} = {automated: tally !== null, manual: false},
): CustomerRow[] {
  const auto = tally !== null && known.automated;
  const manual = tally !== null && known.manual;
  return enriched.map((c) => {
    const t = tally?.get(emailKey(c.email));
    return {
      ...c,
      daysSinceLastOrder: phDaysSince(c.lastOrderAt, now),
      emailsSent: auto ? (t?.automated ?? 0) : null,
      manualContacts: manual ? (t?.manual ?? 0) : null,
      timesContacted: auto && manual ? (t?.total ?? 0) : null,
      lastContactedAt: auto && manual ? (t?.lastAt ?? null) : null,
      lastContactKind: auto && manual ? (t?.lastKind ?? null) : null,
      lastContactKnown: auto && manual,
      consent: c.emailMarketingState?.trim() || 'unknown',
    };
  });
}

type LastContact = Pick<CustomerRow, 'lastContactedAt' | 'lastContactKnown'>;
/** RET-07 display: the PH date of the last contact, "never" (known, none) or "unknown" (a source unread). */
export function lastContactLabel(r: LastContact): string {
  if (!r.lastContactKnown) return 'unknown';
  return r.lastContactedAt === null ? 'never' : fmtPhDate(r.lastContactedAt);
}
/** R5 "haven't talked to longest": never contacted first, then the oldest last contact; unknown rows last (their order is kept). */
export function compareLastContacted(a: LastContact, b: LastContact): number {
  const rank = (r: LastContact): number => (!r.lastContactKnown ? 2 : r.lastContactedAt === null ? 0 : 1);
  return rank(a) - rank(b) || (rank(a) === 1 ? ms(a.lastContactedAt) - ms(b.lastContactedAt) : 0);
}
/** Most contacted first (times contacted desc); unknown (null) last. */
export function compareTimesContacted(a: Pick<CustomerRow, 'timesContacted'>, b: Pick<CustomerRow, 'timesContacted'>): number {
  if (a.timesContacted === null || b.timesContacted === null) return Number(a.timesContacted === null) - Number(b.timesContacted === null);
  return b.timesContacted - a.timesContacted;
}

/** An audience preset's rows, longest-lapsed first (the chat's audience order); "all" returns the rows unchanged. */
export function audienceRows<T extends Pick<EnrichedCustomer, 'orderCount' | 'lastOrderAt'>>(rows: readonly T[], audience: CustomerAudience, now: Date): T[] {
  if (audience === 'all') return [...rows];
  return rows.filter((c) => inAudience(c, audience, now)).sort(compareLastOrder(1));
}

const countBy = (keys: string[]): {group: string; customers: number}[] => {
  const acc = new Map<string, number>();
  for (const k of keys) acc.set(k, (acc.get(k) ?? 0) + 1);
  return [...acc.entries()].sort((x, y) => x[0].localeCompare(y[0])).map(([group, customers]) => ({group, customers}));
};

/** Buyers by counted orders (1 / 2 / 3 / 4+); non-buyers are not buyers, so they are left out. */
export function buyersByOrders(rows: readonly Pick<EnrichedCustomer, 'orderCount'>[]): {group: string; customers: number}[] {
  return countBy(rows.filter((c) => c.orderCount >= 1).map((c) => ordersBucket(c.orderCount)));
}

/** New buyers per PH month of their first counted order, oldest month first. */
export function newBuyersByMonth(rows: readonly Pick<EnrichedCustomer, 'firstOrderAt'>[]): {group: string; customers: number}[] {
  return countBy(rows.map((c) => phDayOf(c.firstOrderAt)?.slice(0, 7)).filter((m): m is string => Boolean(m)));
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

const pesoDigits = {minimumFractionDigits: 2, maximumFractionDigits: 2} as const;
/** Pesos with centavos ("₱1,234.50"). */
export const peso = (n: number): string => `₱${Number(n || 0).toLocaleString('en-PH', pesoDigits)}`;
/** A money string straight off the API, which may carry its own currency. */
export const money = (amount: string | null | undefined, currency?: string | null): string =>
  `${!currency || currency === 'PHP' ? '₱' : `${currency} `}${Number(amount ?? 0).toLocaleString('en-PH', pesoDigits)}`;

/** A PH calendar date ("Oct 11, 2026") for day-level columns; '—' when absent. */
export function fmtPhDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-PH', {timeZone: 'Asia/Manila', year: 'numeric', month: 'short', day: 'numeric'});
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

export function filterCustomers<T extends EnrichedCustomer>(
  rows: readonly T[],
  f: CustomerFilter,
  needle: string,
): T[] {
  return rows.filter(
    (c) =>
      textMatch(needle, [c.email, c.firstName, c.lastName, c.phone, c.petName, c.membershipTier]) &&
      (f.tier === 'all' || (f.tier === 'guest' ? !c.membershipTier : c.membershipTier === f.tier)) &&
      (f.buyers === 'all' || (f.buyers === 'buyers' ? c.orderCount > 0 : c.orderCount === 0)),
  );
}
