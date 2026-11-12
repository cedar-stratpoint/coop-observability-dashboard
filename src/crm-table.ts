/**
 * RET-09 (Stage 8A): the Website CRM page's table mechanics, ported from the storefront admin (Vince's /admin/crm) so Coop keeps
 * everything it does. Pure, so it is unit-tested (test/crm-table.test.ts):
 *  - header sorting: one getter per column, nulls last whichever way it runs (an unknown is never sorted as a 0);
 *  - the reminder / review schedule lines from the CRM's own /api/metrics settings (absent → no line, never a made-up schedule);
 *  - the Pet birthdays rows (petBirthdayStatus from 8B, so the table and the profile agree);
 *  - each table's CSV with Vince's summary header (as-of stamp, active filters, counts). A recovery link is never written to a CSV:
 *    it opens the customer's own checkout.
 * Coop's rule where Vince's differs: Shopify test orders count nowhere, so the Orders CSV's paid revenue leaves them out.
 */
import {
  cartStatus,
  daysToPetBirthday,
  emailKey,
  fmtPh,
  fmtPhDate,
  CONTACT_KIND_LABEL,
  lastContactLabel,
  money,
  peso,
  petBirthdayStatus,
  tierCounts,
  toPlatinum,
  turnaround,
  type CartStatus,
  type CustomerRow,
  type PetBirthdayStatus,
} from './crm-compute';
import {phDay} from './custom-range';
import type {CheckoutStage, CrmCheckout, CrmCustomer, CrmMetrics, CrmOrder} from './crm-types';

/* ---------- sorting ---------- */

export type SortDir = 'asc' | 'desc';
export type Sort<K extends string> = {key: K; dir: SortDir};
type Val = number | string | null;
type Getters<T> = Readonly<Record<string, (r: T) => Val>>;

/** Columns whose first click shows the newest first (Vince's SortHeader). Every other column starts ascending. */
const NEWEST_FIRST: ReadonlySet<string> = new Set(['abandoned', 'placed', 'fulfilled', 'reviewSent', 'reviewed']);

/** A header click: the same column flips; a new one starts at its natural direction. */
export function nextSort<K extends string>(cur: Sort<K> | null, key: K): Sort<K> {
  if (cur?.key === key) return {key, dir: cur.dir === 'asc' ? 'desc' : 'asc'};
  return {key, dir: NEWEST_FIRST.has(key) ? 'desc' : 'asc'};
}

const isNull = (v: Val): v is null => v === null || (typeof v === 'number' && Number.isNaN(v));
function compare(a: Val, b: Val, dir: SortDir): number {
  if (isNull(a) || isNull(b)) return Number(isNull(a)) - Number(isNull(b)); // nulls last, both directions
  const d = dir === 'asc' ? 1 : -1;
  if (typeof a === 'number' && typeof b === 'number') return a < b ? -d : a > b ? d : 0;
  return d * String(a).localeCompare(String(b), 'en', {sensitivity: 'base', numeric: true});
}

/** The rows in the header's order (a copy; ties keep their order). No sort = the rows as given. */
export function sortRows<T, K extends string>(rows: readonly T[], sort: Sort<K> | null, getters: Readonly<Record<K, (r: T) => Val>>): T[] {
  const get = sort ? getters[sort.key] : undefined;
  if (!sort || !get) return [...rows];
  return rows
    .map((r, i) => ({r, i, v: get(r)}))
    .sort((x, y) => compare(x.v, y.v, sort.dir) || x.i - y.i)
    .map((x) => x.r);
}

const text = (s: string | null | undefined): string | null => (s ?? '').trim() || null;
const at = (iso: string | null | undefined): number | null => {
  const t = Date.parse(String(iso ?? ''));
  return Number.isFinite(t) ? t : null;
};
const amount = (s: string | null | undefined): number | null => {
  const n = Number.parseFloat(String(s ?? ''));
  return Number.isFinite(n) ? n : null;
};
const STAGE_RANK: Readonly<Record<CheckoutStage, number>> = {Started: 0, Email: 1, Shipping: 2, Payment: 3};
const STATUS_RANK: Readonly<Record<CartStatus, number>> = {Active: 0, Converted: 1, Recovered: 2};
const TIER_RANK = (t: string | null): number => (t === 'platinum' ? 2 : t === 'gold' ? 1 : 0);

export const CART_SORT = {
  email: (c: CrmCheckout) => text(c.email),
  total: (c: CrmCheckout) => amount(c.totalPrice),
  items: (c: CrmCheckout) => c.items ?? null,
  progress: (c: CrmCheckout) => STAGE_RANK[c.stage] ?? null,
  status: (c: CrmCheckout) => STATUS_RANK[cartStatus(c)],
  reminders: (c: CrmCheckout) => c.remindersSent,
  winback: (c: CrmCheckout) => at(c.winbackSentAt),
  abandoned: (c: CrmCheckout) => at(c.createdAt ?? c.updatedAt),
} satisfies Getters<CrmCheckout>;
export type CartSortKey = keyof typeof CART_SORT;

export const ORDER_SORT = {
  order: (o: CrmOrder) => {
    const digits = String(o.orderNumber ?? '').replace(/\D/g, '');
    return digits ? Number(digits) : text(o.orderNumber ?? o.shopifyOrderId);
  },
  email: (o: CrmOrder) => text(o.email),
  total: (o: CrmOrder) => amount(o.totalPrice),
  payment: (o: CrmOrder) => text(o.financialStatus),
  placed: (o: CrmOrder) => at(o.createdAt),
  // Placement → fulfillment in ms; unfulfilled is null, so it sorts last (Vince's turnaroundMs did the same with MAX_SAFE_INTEGER).
  turnaround: (o: CrmOrder) => {
    const p = at(o.createdAt);
    const f = at(o.fulfilledAt);
    return p === null || f === null || f < p ? null : f - p;
  },
  fulfilled: (o: CrmOrder) => at(o.fulfilledAt),
  reviewSent: (o: CrmOrder) => at(o.reviewRequestSentAt),
  reviewed: (o: CrmOrder) => at(o.reviewSubmittedAt),
} satisfies Getters<CrmOrder>;
export type OrderSortKey = keyof typeof ORDER_SORT;

export const CUSTOMER_SORT = {
  name: (c: CustomerRow) => text([c.firstName, c.lastName].filter(Boolean).join(' ')),
  email: (c: CustomerRow) => text(c.email),
  tier: (c: CustomerRow) => TIER_RANK(c.membershipTier),
  orders: (c: CustomerRow) => c.orderCount,
  firstOrder: (c: CustomerRow) => at(c.firstOrderAt),
  lastOrder: (c: CustomerRow) => at(c.lastOrderAt),
  daysSince: (c: CustomerRow) => c.daysSinceLastOrder,
  emailsSent: (c: CustomerRow) => c.emailsSent,
  manual: (c: CustomerRow) => c.manualContacts,
  // 7A's rule as a value: unknown is null (last), never contacted sorts before the oldest contact, so ascending IS
  // compareLastContacted ("haven't contacted longest") and descending is newest first with never, then unknown, after.
  lastContacted: (c: CustomerRow) => (!c.lastContactKnown ? null : c.lastContactedAt === null ? Number.NEGATIVE_INFINITY : at(c.lastContactedAt)),
  timesContacted: (c: CustomerRow) => c.timesContacted,
  consent: (c: CustomerRow) => text(c.consent),
  spend: (c: CustomerRow) => c.spendYtd,
  memberSince: (c: CustomerRow) => at(c.createdAt),
  // Gold by this year's spend (Vince's order), Platinum past every Gold (already qualified); a guest has no tier, so nothing to sort.
  toPlatinum: (c: CustomerRow) => (c.membershipTier === 'platinum' ? Number.POSITIVE_INFINITY : c.membershipTier === 'gold' ? c.spendYtd : null),
  pet: (c: CustomerRow) => text(c.petName),
} satisfies Getters<CustomerRow>;
export type CustomerSortKey = keyof typeof CUSTOMER_SORT;

/* ---------- schedule lines (the CRM engine's settings, from /api/metrics) ---------- */

/** Vince's fmtMinutes: 1 → "1 minute", 60 → "1 hour", 10080 → "7 days". */
export function fmtMinutes(m: number | null | undefined): string {
  if (m === null || m === undefined || !Number.isFinite(m)) return '—';
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'}`;
  if (m < 1440) {
    const h = Math.round(m / 60);
    return `${h} hour${h === 1 ? '' : 's'}`;
  }
  const d = Math.round(m / 1440);
  return `${d} day${d === 1 ? '' : 's'}`;
}

const paused = (enabled: boolean | undefined): string => (enabled === false ? ' · paused' : '');

/** "Reminder: sent 1 hour, then 1 day after abandonment[ · paused]"; null when the CRM did not send its steps. */
export function reminderSchedule(m: CrmMetrics | null): string | null {
  const steps = m?.reminderSteps;
  if (!m || !steps?.length) return null;
  return `Reminder: sent ${steps.map(fmtMinutes).join(', then ')} after abandonment${paused(m.remindersEnabled)}`;
}

/** "Review email: sent 7 days after fulfillment[ · paused]"; null when the CRM did not send the delay. */
export function reviewSchedule(m: CrmMetrics | null): string | null {
  if (!m || m.reviewAfterMinutes === undefined) return null;
  return `Review email: sent ${fmtMinutes(m.reviewAfterMinutes)} after fulfillment${paused(m.reviewEmailsEnabled)}`;
}

/** "1 of 1" when the CRM said how many reminders a cart gets; just the count otherwise (never a guessed total). */
export const remindersOf = (sent: number, total: number | null | undefined): string =>
  total === null || total === undefined ? String(sent) : `${sent} of ${total}`;

/* ---------- Pet birthdays ---------- */

export type PetRow = {
  shopifyCustomerId: string;
  email: string | null;
  petName: string | null;
  petBirthday: string | null;
  /** PH days to the next birthday (0 = today); null without a birthday. */
  nextDays: number | null;
  /** This PH year's voucher; null when the voucher ledger was not read or there is no birthday. */
  status: PetBirthdayStatus | null;
  /** When this year's voucher went out (the code itself never reaches the page). */
  sentAt: string | null;
};

/**
 * One row per customer with a pet on file. The CRM projects one pet per customer (petName / petBirthday), so there is no
 * "primary pet" to tag: Vince's multi-pet rows read a pet_profiles list that Coop's projection does not carry.
 */
export function petRows(
  rows: readonly Pick<CrmCustomer, 'shopifyCustomerId' | 'email' | 'petName' | 'petBirthday'>[],
  vouchers: readonly {email: string | null; year?: number; sentAt?: string}[] | null,
  now: Date,
): PetRow[] {
  const year = Number(phDay(now.getTime()).slice(0, 4));
  const sent = new Map<string, string>();
  for (const v of vouchers ?? []) {
    const k = emailKey(v.email);
    if (v.year !== year || !k || !v.sentAt) continue;
    if (!sent.has(k) || v.sentAt > (sent.get(k) ?? '')) sent.set(k, v.sentAt);
  }
  return rows
    .filter((c) => text(c.petName) !== null || text(c.petBirthday) !== null)
    .map((c) => ({
      shopifyCustomerId: c.shopifyCustomerId,
      email: c.email,
      petName: text(c.petName),
      petBirthday: text(c.petBirthday),
      nextDays: daysToPetBirthday(c.petBirthday, now),
      status: vouchers === null ? null : petBirthdayStatus(c, vouchers, now),
      sentAt: sent.get(emailKey(c.email)) ?? null,
    }));
}

const PET_RANK: Readonly<Record<PetBirthdayStatus, number>> = {Passed: 0, Upcoming: 1, Sent: 2};
export const PET_SORT = {
  email: (p: PetRow) => text(p.email),
  pet: (p: PetRow) => p.petName,
  next: (p: PetRow) => p.nextDays,
  status: (p: PetRow) => (p.status === null ? null : PET_RANK[p.status]),
} satisfies Getters<PetRow>;
export type PetSortKey = keyof typeof PET_SORT;

/* ---------- CSV with Vince's summary header ---------- */

type Count = readonly [string, string | number];
type Csv = string[][];

/** The narrowed filters and the search, as "Progress=Email; Search=ana"; "none" when nothing narrows the rows. */
export function filterNote(filters: ReadonlyArray<readonly [string, string]>, search: string): string {
  const parts = filters.filter(([, v]) => v !== 'all').map(([k, v]) => `${k}=${v}`);
  if (search.trim()) parts.push(`Search=${search.trim()}`);
  return parts.join('; ') || 'none';
}

/** Title with the as-of stamp, the filters note, one row per count, then a blank line before the table. */
export function csvSummary(title: string, asOf: string, note: string, counts: readonly Count[]): Csv {
  return [
    [`${title} (as of ${asOf})`],
    [`Note: the summary and rows below reflect the current filters (${note}), not the whole store.`],
    ...counts.map(([k, v]) => [k, String(v)]),
    [],
  ];
}

/** A PH timestamp for a CSV cell: empty when there is none (the page shows a dash, a spreadsheet wants a blank). */
const ph = (iso: string | null | undefined): string => (iso ? fmtPh(iso) : '');
const sum = (xs: readonly (number | null)[]): string => xs.reduce<number>((a, x) => a + (x ?? 0), 0).toFixed(2);

/** The cart-recovery counts of the exported rows (Vince's export summary). */
export function cartSummary(rows: readonly CrmCheckout[]): Count[] {
  const status = rows.map(cartStatus);
  const recovered = status.filter((s) => s === 'Recovered').length;
  const reminded = rows.filter((c) => c.remindersSent > 0).length;
  return [
    ['Rows in export', rows.length],
    ['Abandoned (active)', status.filter((s) => s === 'Active').length],
    ['Recovered (via reminder)', recovered],
    ['Reminded', reminded],
    ['Recovery rate', reminded > 0 ? `${Math.round((recovered / reminded) * 100)}%` : 'n/a'],
    ['Revenue recovered', sum(rows.filter((_, i) => status[i] === 'Recovered').map((c) => amount(c.totalPrice)))],
  ];
}

/** The Abandoned checkouts export. Never the recovery link. */
export function cartCsv(rows: readonly CrmCheckout[], asOf: string, note: string, reminderTotal?: number): Csv {
  return [
    ...csvSummary('abandoned-checkouts', asOf, note, cartSummary(rows)),
    ['Email', 'Cart value', 'Items', 'Progress', 'Status', 'Reminders sent', 'Last reminder (PH time)', 'Reminder (RETURN30)', 'Abandoned (PH time)'],
    ...rows.map((c) => [
      c.email ?? '',
      money(c.totalPrice, c.currency),
      c.items === undefined ? '' : String(c.items),
      c.stage,
      cartStatus(c),
      remindersOf(c.remindersSent, reminderTotal),
      ph(c.lastReminderAt),
      ph(c.winbackSentAt),
      ph(c.createdAt ?? c.updatedAt),
    ]),
  ];
}

/** The Orders export. Paid revenue leaves Shopify test orders out (owner rule 2026-11-09); the summary says how many are listed. */
export function orderCsv(rows: readonly CrmOrder[], asOf: string, note: string): Csv {
  const paid = rows.filter((o) => (o.financialStatus ?? '').toLowerCase() === 'paid' && o.test !== true);
  return [
    ...csvSummary('orders', asOf, note, [
      ['Rows in export', rows.length],
      ['Paid revenue (test orders excluded)', sum(paid.map((o) => amount(o.totalPrice)))],
      ['Shopify test orders in export', rows.filter((o) => o.test === true).length],
    ]),
    ['Order', 'Email', 'Total', 'Payment', 'Fulfillment', 'Placed (PH time)', 'Turnaround', 'Fulfilled (PH time)', 'Review sent (PH time)', 'Reviewed (PH time)', 'Shopify test order'],
    ...rows.map((o) => [
      o.orderNumber ?? o.shopifyOrderId,
      o.email ?? '',
      money(o.totalPrice, o.currency),
      o.financialStatus ?? '',
      o.fulfillmentStatus ?? '',
      ph(o.createdAt),
      turnaround(o.createdAt, o.fulfilledAt),
      ph(o.fulfilledAt),
      ph(o.reviewRequestSentAt),
      ph(o.reviewSubmittedAt),
      o.test === true ? 'yes' : '',
    ]),
  ];
}

/** To Platinum as a CSV cell: Qualified for Platinum, the pesos left for Gold, blank for a guest (no tier). */
const toPlatinumCell = (c: CustomerRow, threshold: number): string =>
  c.membershipTier === 'platinum' ? 'Qualified' : c.membershipTier === 'gold' ? toPlatinum(c.spendYtd, threshold).left.toFixed(2) : '';

/** The Customers export (any audience preset; `title` names the file's audience). */
export function customerCsv(rows: readonly CustomerRow[], asOf: string, note: string, threshold: number, title: string): Csv {
  const tiers = tierCounts([...rows]);
  return [
    ...csvSummary(title, asOf, note, [
      ['Rows in export', rows.length],
      ['Platinum threshold (PHP/year)', threshold.toFixed(2)],
      ['Platinum', tiers.platinum],
      ['Gold', tiers.gold],
      ['Guest', tiers.guest],
      ['Lifetime spend (paid, test orders excluded)', sum(rows.map((c) => c.spent))],
    ]),
    ['Name', 'Email', 'Mobile', 'Member since (PH)', 'Tier', 'Orders', 'First order (PH)', 'Last order (PH)', 'Days since last order', 'Emails sent', 'Manual contacts', 'Times contacted', 'Last contacted (PH)', 'Last contact kind', 'Email consent', 'Lifetime spend', 'Spend this membership year', 'To Platinum', 'Pet'],
    ...rows.map((c) => [
      [c.firstName, c.lastName].filter(Boolean).join(' '),
      c.email ?? '',
      c.phone ?? '',
      c.createdAt ? fmtPhDate(c.createdAt) : '',
      c.membershipTier ?? 'guest',
      String(c.orderCount),
      c.firstOrderAt ? fmtPhDate(c.firstOrderAt) : '',
      c.lastOrderAt ? fmtPhDate(c.lastOrderAt) : '',
      c.daysSinceLastOrder === null ? '' : String(c.daysSinceLastOrder),
      c.emailsSent === null ? 'unknown' : String(c.emailsSent),
      c.manualContacts === null ? 'unknown' : String(c.manualContacts),
      c.timesContacted === null ? 'unknown' : String(c.timesContacted),
      lastContactLabel(c),
      c.lastContactKind ? CONTACT_KIND_LABEL[c.lastContactKind] : '',
      c.consent,
      peso(c.spent),
      peso(c.spendYtd),
      toPlatinumCell(c, threshold),
      c.petName ?? '',
    ]),
  ];
}

/** The Pet birthdays export: the status counts of this PH year's vouchers. No voucher code: the page never has it. */
export function petCsv(rows: readonly PetRow[], asOf: string, note: string, year: number): Csv {
  const n = (s: PetBirthdayStatus) => rows.filter((p) => p.status === s).length;
  return [
    ...csvSummary('pet-birthdays', asOf, note, [
      ['Rows in export', rows.length],
      ['Sent this year', n('Sent')],
      ['Upcoming', n('Upcoming')],
      ['Passed', n('Passed')],
    ]),
    ['Email', 'Pet', 'Pet birthday', 'Next birthday (days)', `Birthday voucher (${year})`, 'Sent at (PH time)'],
    ...rows.map((p) => [p.email ?? '', p.petName ?? '', p.petBirthday?.slice(0, 10) ?? '', p.nextDays === null ? '' : String(p.nextDays), p.status ?? '', ph(p.sentAt)]),
  ];
}
