// RET-13B: spin-the-wheel voucher winners who have not ordered on the website since. Pure.
// The lead row carries no code and the data cannot tell a website voucher from a booth discount, so "used" means ANY counted
// (non-test) website order by the lead's email at or after the spin (owner default). Never a voucher code, never a recovery link.
import {emailKey, fmtPhDate, fmtPh} from './crm-compute';
import type {CrmOrder} from './crm-types';
import {isVoucherPrize} from './spin-leads-sync';
import type {SpinLead} from './spin-leads-types';

export type SpinVoucherState = 'not_used' | 'ordered' | 'not_voucher' | 'no_email';
type OrderLite = Pick<CrmOrder, 'email' | 'createdAt' | 'test'>;

const ms = (iso: string | null | undefined): number => (iso ? Date.parse(iso) : NaN);

/** The first counted order by this lead's email at or after the spin (ISO), or null. */
export function spinVoucherOrderAt(lead: Pick<SpinLead, 'email' | 'collectedAt'>, orders: readonly OrderLite[]): string | null {
  const key = emailKey(lead.email);
  const spun = ms(lead.collectedAt);
  if (!key || !Number.isFinite(spun)) return null;
  let first: {iso: string; at: number} | null = null;
  for (const o of orders) {
    if (o.test === true || emailKey(o.email) !== key) continue;
    const at = ms(o.createdAt);
    if (!Number.isFinite(at) || at < spun) continue;
    if (first === null || at < first.at) first = {iso: o.createdAt as string, at};
  }
  return first?.iso ?? null;
}

/** Null when the CRM orders were not read: unknown, never "not used". */
export function spinVoucherState(lead: SpinLead, orders: readonly OrderLite[] | null): SpinVoucherState | null {
  if (!isVoucherPrize(lead.prize)) return 'not_voucher';
  if (!emailKey(lead.email)) return 'no_email';
  if (orders === null) return null;
  return spinVoucherOrderAt(lead, orders) ? 'ordered' : 'not_used';
}

/** CSV rows (for downloadCsv) of the listed winners: no code, no link. */
export function spinVoucherCsv(
  rows: readonly {lead: SpinLead; state: SpinVoucherState | null; orderAt: string | null; lastContactAt: string | null}[],
  asOf: string,
): string[][] {
  const head = ['Email', 'Name', 'Mobile', 'Prize', 'Event', 'Spun (PH)', 'Website order since', 'Last logged contact'];
  const body = rows.map(({lead, state, orderAt, lastContactAt}) => [
    lead.email ?? '',
    lead.name ?? '',
    lead.mobile ?? '',
    lead.prize,
    lead.campaign ?? '',
    fmtPh(lead.collectedAt),
    state === 'ordered' ? fmtPhDate(orderAt) : state === 'not_used' ? 'No' : 'Unknown',
    lastContactAt ? fmtPhDate(lastContactAt) : 'Never',
  ]);
  return [[`Spin voucher winners, as of ${fmtPh(asOf)}`], head, ...body];
}

/** What the leads page ships to the browser per lead (never the orders list, never a code). */
export type SpinVoucherInfo = {state: SpinVoucherState | null; orderAt: string | null};
