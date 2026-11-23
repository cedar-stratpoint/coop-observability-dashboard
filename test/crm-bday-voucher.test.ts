// RET-13A (Stage 9D, plan knowledge/tasks/2026-11-23-customer-unredeemed-vouchers-ret13.md): "Birthday voucher not used". The cohort field
// `bday`, the built-in cohort, the shared withVoucherFacts helper (page and Ask Coop), and the rule that no voucher code ever shows.
// Every expected state is worked out by hand from the fixture below (NOW = 2026-11-20, PH year 2026).
import {describe, expect, it} from 'vitest';
import {createCrmExecutors} from '../src/chat/crm/executors';
import type {CohortDraftBlock, ChatBlock} from '../src/chat/block-types';
import {
  BUILTIN_RULE_COHORTS,
  bdayVoucherText,
  birthdayVoucherState,
  condText,
  contactTally,
  customerRows,
  enrichCustomers,
  matchesCohort,
  membershipWindowStart,
  ruleText,
  withVoucherFacts,
  type CohortRule,
} from '../src/crm-compute';
import {projectBirthdayVoucher, projectCustomer, projectOrder} from '../src/crm-project';
import {customerCsv} from '../src/crm-table';
import {fakeCrmClient} from './support/crm-fixtures';
import {sink} from './support/fake-model';

const NOW = new Date('2026-11-20T04:00:00Z');
const SECRET = 'SECRET-BDAY-CODE';
const person = (id: string, email: string | null) => ({shopifyCustomerId: id, email, firstName: id.toUpperCase(), lastName: 'Test', phone: null, membershipTier: 'gold', petName: null, petBirthday: null, emailMarketingState: 'subscribed', createdAt: '2026-01-01T00:00:00Z', updatedAt: null});
const CUSTOMERS = [person('a', 'a@x.com'), person('b', 'b@x.com'), person('c', 'c@x.com'), person('d', 'd@x.com'), person('e', 'e@x.com'), person('f', 'f@x.com'), person('g', null), person('h', 'h@x.com'), person('i', 'i@x.com')];
const order = (id: string, n: number, at: string, codes: string[], test = false) => ({shopifyOrderId: `${id}-${n}`, orderNumber: `#${id}${n}`, shopifyCustomerId: id, email: `${id}@x.com`, totalPrice: '500', currency: 'PHP', financialStatus: 'paid', fulfillmentStatus: null, createdAt: at, lineItems: null, raw: JSON.stringify({test, discount_codes: codes.map((code) => ({code, amount: '100'}))})});
const ORDERS = [
  order('a', 1, '2026-11-10T02:00:00Z', [`BDAY-${SECRET}`]), // after the Nov 2 send: used
  order('b', 1, '2026-10-01T02:00:00Z', [`BDAY-${SECRET}`]), // before the send: not a redemption
  order('c', 1, '2026-11-10T02:00:00Z', [`BDAY-${SECRET}`], true), // a test order never counts
  order('f', 1, '2026-01-15T02:00:00Z', [`BDAY-${SECRET}`]), // last year's voucher used in January: still none this year
  order('i', 1, '2026-11-12T02:00:00Z', ['GRAND300']), // another code is not a birthday redemption
];
const v = (email: string, year: number, sentAt: string, expiresAt: string | null) => ({id: 1, email, year, tier: 'gold', code: `BDAY-${SECRET}`, amount: '100', discountNodeId: 'gid://SECRET-NODE', expiresAt, sentAt});
const LEDGER = [
  v('a@x.com', 2026, '2026-11-02T02:00:00Z', '2026-12-03'),
  v('b@x.com', 2026, '2026-11-02T02:00:00Z', '2026-12-03'),
  v('c@x.com', 2026, '2026-11-02T02:00:00Z', '2026-12-03'),
  v('d@x.com', 2026, '2026-10-01T02:00:00Z', '2026-11-10'), // expired, unused
  v('e@x.com', 2026, '2026-11-02T02:00:00Z', null), // no expiry known: unused
  v('f@x.com', 2025, '2025-11-02T02:00:00Z', '2025-12-03'), // last year only
  v('h@x.com', 2026, '2026-11-02T02:00:00Z', '2026-12-03'), // unused, no orders at all
  v('i@x.com', 2026, '2026-11-02T02:00:00Z', '2026-12-03'),
];
const MEMBERSHIP = {platinumThreshold: 2000, programStart: '2026-07-01'};
const STATE: Record<string, string> = {a: 'used', b: 'unused', c: 'unused', d: 'expired', e: 'unused', f: 'none', g: 'none', h: 'unused', i: 'unused'};
const UNUSED = ['b', 'c', 'e', 'h', 'i'];

const orders = ORDERS.map(projectOrder);
const ledger = LEDGER.map(projectBirthdayVoucher);
const customers = CUSTOMERS.map(projectCustomer);
function pageRows(vouchers: typeof ledger | null = ledger, ords: typeof orders | null = orders) {
  const enriched = enrichCustomers(customers, orders, membershipWindowStart(NOW, MEMBERSHIP.programStart));
  const rows = customerRows(enriched, contactTally({checkouts: [], orders, birthdayVouchers: [], membershipEvents: [], manualContacts: []}), NOW, {automated: true, manual: true});
  return withVoucherFacts(rows, ords, vouchers, NOW);
}
const RULE = BUILTIN_RULE_COHORTS[0].rule;
const rule = (op: 'is' | 'is_not', value: string): CohortRule => ({all: [{f: 'bday', op, v: value}]});

describe('RET-13A birthdayVoucherState', () => {
  it('sent Nov 2 + BDAY- order Nov 10 = used; a BDAY- order before the send = unused', () => {
    const s = (id: string) => birthdayVoucherState(customers.find((c) => c.shopifyCustomerId === id)!, ledger, orders, NOW)?.state;
    expect(s('a')).toBe('used');
    expect(s('b')).toBe('unused');
  });
  it('only a test order with BDAY- = unused; another code is not a redemption', () => {
    const rows = pageRows();
    expect(rows.find((r) => r.shopifyCustomerId === 'c')?.bdayVoucher?.state).toBe('unused');
    expect(rows.find((r) => r.shopifyCustomerId === 'i')?.bdayVoucher?.state).toBe('unused');
  });
  it('every fixture customer lands in its hand-worked state (expired, no expiry, last year only, no email)', () => {
    expect(Object.fromEntries(pageRows().map((r) => [r.shopifyCustomerId, r.bdayVoucher?.state]))).toEqual(STATE);
  });
  it('expired = past expiry; a date-only expiry lasts to the end of that PH day; null expiry never expires', () => {
    const c = customers[0];
    const one = (expiresAt: string | null) => birthdayVoucherState(c, [{email: 'a@x.com', year: 2026, sentAt: '2026-11-02T02:00:00Z', expiresAt}], [], NOW)?.state;
    expect(one('2026-11-19')).toBe('expired');
    expect(one('2026-11-20')).toBe('unused'); // today PH
    expect(one('2026-11-20T01:00:00Z')).toBe('expired'); // an instant behind us
    expect(one(null)).toBe('unused');
  });
  it('the newest voucher of the year decides', () => {
    const two = [
      {email: 'a@x.com', year: 2026, sentAt: '2026-03-01T00:00:00Z', expiresAt: '2026-04-01'},
      {email: 'a@x.com', year: 2026, sentAt: '2026-11-02T00:00:00Z', expiresAt: '2026-12-03'},
    ];
    expect(birthdayVoucherState(customers[0], two, [], NOW)).toEqual({state: 'unused', expiresAt: '2026-12-03'});
  });
  it('a ledger or orders list that was not read is unknown (null), never "none" or "unused"', () => {
    expect(birthdayVoucherState(customers[0], null, orders, NOW)).toBeNull();
    expect(birthdayVoucherState(customers[0], ledger, null, NOW)).toBeNull();
    for (const rows of [pageRows(null), pageRows(ledger, null)]) {
      expect(rows.every((r) => r.bdayVoucher === null)).toBe(true);
      for (const val of ['unused', 'expired', 'used', 'none']) for (const op of ['is', 'is_not'] as const) expect(rows.some((r) => matchesCohort(r, rule(op, val)))).toBe(false);
    }
  });
});

describe('RET-13A the built-in "Birthday voucher not used"', () => {
  it('is bday is unused, and lists exactly those rows; expired and used are left out', () => {
    expect(BUILTIN_RULE_COHORTS).toEqual([{key: 'bday_unused', label: 'Birthday voucher not used', rule: {all: [{f: 'bday', op: 'is', v: 'unused'}]}}]);
    expect(pageRows().filter((r) => matchesCohort(r, RULE)).map((r) => r.shopifyCustomerId).sort()).toEqual(UNUSED);
  });
  it('is / is not read as plain sentences, never a field code or a voucher code', () => {
    expect(condText({f: 'bday', op: 'is', v: 'unused'})).toBe('Got a birthday voucher this year and has not used it');
    expect(condText({f: 'bday', op: 'is', v: 'expired'})).toBe("This year's birthday voucher expired unused");
    expect(condText({f: 'bday', op: 'is', v: 'used'})).toBe("Used this year's birthday voucher");
    expect(condText({f: 'bday', op: 'is', v: 'none'})).toBe('No birthday voucher this year');
    expect(condText({f: 'bday', op: 'is_not', v: 'used'})).toBe('Birthday voucher this year is not Sent and used');
    expect(ruleText(RULE)).not.toMatch(/bday|BDAY/);
  });
  it('"is not used" includes unused, expired and none (the unread stay out)', () => {
    expect(pageRows().filter((r) => matchesCohort(r, rule('is_not', 'used'))).map((r) => r.shopifyCustomerId).sort()).toEqual(['b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']);
  });
  it('column text: expiry, Expired, Used, a dash, unknown', () => {
    expect(bdayVoucherText({state: 'unused', expiresAt: '2026-12-03'})).toBe('Sent, not used · expires Dec 3');
    expect(bdayVoucherText({state: 'unused', expiresAt: null})).toBe('Sent, not used');
    expect(bdayVoucherText({state: 'expired', expiresAt: '2026-11-10'})).toBe('Expired');
    expect(bdayVoucherText({state: 'used', expiresAt: '2026-12-03'})).toBe('Used');
    expect(bdayVoucherText({state: 'none', expiresAt: null})).toBe('—');
    expect(bdayVoucherText(null)).toBe('unknown');
  });
});

describe('RET-13A no voucher code anywhere', () => {
  it('the projected ledger keeps expiresAt but never the code, amount or discount node', () => {
    expect(Object.keys(ledger[0]).sort()).toEqual(['email', 'expiresAt', 'sentAt', 'tier', 'year']);
  });
  it('rows, sentences and the CSV carry no code', () => {
    const rows = pageRows().filter((r) => matchesCohort(r, RULE));
    const csv = customerCsv(rows, 'as of', 'Cohort: Birthday voucher not used', 2000, 'crm-customers-bday-unused', true);
    expect(csv.some((r) => r.includes('Birthday voucher'))).toBe(true);
    expect(JSON.stringify(csv)).not.toMatch(new RegExp(`${SECRET}|BDAY-${SECRET}|gid://`));
    expect(JSON.stringify(rows)).not.toContain(SECRET);
    expect(JSON.stringify(csv)).toContain('Sent, not used · expires Dec 3');
  });
});

describe('RET-13A Ask Coop sees the same people', () => {
  const BODIES = {customers: {customers: CUSTOMERS}, orders: {orders: ORDERS}, checkouts: {checkouts: []}, birthdayVouchers: {birthdayVouchers: LEDGER}, membershipEvents: {membershipEvents: []}, membership: MEMBERSHIP};
  function exec(bodies: Record<string, unknown> = BODIES) {
    const blocks: ChatBlock[] = [];
    const ex = createCrmExecutors({client: fakeCrmClient(bodies as never).client, now: NOW, user: 'owner@zoomy.ph', sink: sink(), keep: (r) => r, emitBlock: (b) => blocks.push(b), manualContacts: async () => [], cohorts: async () => []});
    return {ex, blocks};
  }
  const drafts = (b: ChatBlock[]) => b.filter((x): x is CohortDraftBlock => x.kind === 'cohort_draft');
  const DRAFT = {group: 'Promo', name: 'Birthday unused', rule: {all: [{f: 'bday', op: 'is', v: 'unused'}]}};

  it('a "bday is unused" draft previews the page count (and no code leaks)', async () => {
    const {ex, blocks} = exec();
    const out = await ex.propose_crm_cohort(DRAFT);
    expect(drafts(blocks)[0].preview.customers).toBe(UNUSED.length);
    expect(drafts(blocks)[0].preview.customers).toBe(pageRows().filter((r) => matchesCohort(r, RULE)).length);
    expect(drafts(blocks)[0].sentences).toEqual(['Got a birthday voucher this year and has not used it']);
    expect(JSON.stringify([out, blocks])).not.toContain(SECRET);
  });
  it('with the ledger unread the preview matches nobody and says why', async () => {
    const {ex, blocks} = exec({...BODIES, birthdayVouchers: undefined});
    const out = (await ex.propose_crm_cohort(DRAFT)) as {customers: number; notes: string[]};
    expect(out.customers).toBe(0);
    expect(out.notes.join(' ')).toMatch(/birthday voucher ledger could not be read/);
    expect(drafts(blocks)[0].preview.customers).toBe(0);
  });
  it('a saved bday cohort lists through list_crm_customers; a ledger that did not answer adds a partial_coverage note', async () => {
    const CUS = {joined_from: '', joined_to: '', tier: 'all', buyers: 'all', group_by: 'none', sort: 'newest', min_orders: 0, audience: 'all', limit: 25, offset: 0, cohort: 'Promo · Birthday unused'};
    const saved = [{id: 'x', group: 'Promo', name: 'Birthday unused', rule: RULE, createdBy: 'o', createdAt: '', updatedAt: ''}];
    const run = async (bodies: Record<string, unknown>) => {
      const kept: any[] = [];
      const ex = createCrmExecutors({client: fakeCrmClient(bodies as never).client, now: NOW, user: 'o', sink: sink(), keep: (r) => (kept.push(r), r), emitBlock: () => {}, manualContacts: async () => [], cohorts: async () => saved as never});
      await ex.list_crm_customers(CUS);
      return kept[0];
    };
    const ok = await run(BODIES);
    expect(ok.rows.map((r: any) => String(r.name).split(' ')[0]).sort()).toEqual(UNUSED.map((i) => i.toUpperCase()));
    const bad = await run({...BODIES, birthdayVouchers: undefined});
    expect(bad.rows).toHaveLength(0);
    expect(JSON.stringify(bad.checks ?? bad)).toMatch(/birthday voucher ledger could not be read/);
  });
});
