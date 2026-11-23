// RET-10 Stage 9A (plan knowledge/tasks/2026-11-12-customer-cohorts-stage9.md): rule-based cohorts on the Website CRM page.
// Every expected answer below is written by hand first. Owner rules: a cohort is a group + a name + an AND rule over a closed field
// list; customers get the label only by matching the rule (never by hand); members recompute live; only the creator edits or
// deletes; the table not applied reads "unavailable"; the save path follows knowledge/best-practices/chat-proposed-writes.md
// (actor from the session, server re-validates, 23505 with the same rule + creator = "Already saved", otherwise a clear error).
import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';
import {
  BUILTIN_COHORT_RULES,
  COHORT_FIELDS,
  COHORT_FIELD_SPEC,
  COHORT_RULE_MAX_CONDS,
  codesUsedList,
  condText,
  customerVouchers,
  enrichCustomers,
  contactTally,
  customerRows,
  inAudience,
  matchesCohort,
  readCohortRule,
  ruleText,
  type CohortRow,
  type CohortRule,
  type EnrichedCustomer,
} from '../src/crm-compute';
import {
  COHORT_GROUP_MAX,
  COHORT_NAME_MAX,
  cohortLabel,
  cohortsOf,
  createCohortWith,
  deleteCohortWith,
  labelTaken,
  loadCohortRows,
  readCohortInput,
  readCohortLabel,
  updateCohortWith,
  type CohortDeps,
  type CustomerCohort,
} from '../src/customer-cohorts';

const ME = 'ana@zoomy.ph';
const ID = '0b6f6a52-2f6e-4f5e-9d33-6f1b8a3c9e01';
const NOW = new Date('2026-11-10T04:00:00Z');

/** A buyer with one order 40 days ago, never contacted, everything else plain. Override what a test is about. */
const row = (o: Partial<CohortRow> = {}): CohortRow => ({
  orderCount: 1,
  firstOrderCode: 'CIRCUIT10',
  codesUsed: ['CIRCUIT10'] as string[] | null,
  firstOrderAt: '2026-10-01T02:00:00Z',
  daysSinceLastOrder: 40,
  spent: 1200,
  spendYtd: 800,
  membershipTier: 'gold',
  lastContactKnown: true,
  lastContactedAt: null,
  daysSinceLastContact: null,
  timesContacted: 0,
  consent: 'subscribed',
  ...o,
});
const rule = (...all: CohortRule['all']): CohortRule => ({all});
const ok = (input: unknown): CohortRule => {
  const r = readCohortRule(input);
  if ('error' in r) throw new Error(r.error);
  return r.rule;
};

describe('9A the closed field list', () => {
  it('has exactly the eleven owner fields, each with a plain label and its operators', () => {
    expect([...COHORT_FIELDS]).toEqual(['code', 'anycode', 'first', 'orders', 'days', 'life', 'ytd', 'tier', 'lcdays', 'times', 'consent']);
    for (const f of COHORT_FIELDS) {
      expect(COHORT_FIELD_SPEC[f].label, f).not.toMatch(/^[a-z]+$/); // a label, never the code
      expect(COHORT_FIELD_SPEC[f].ops.length, f).toBeGreaterThan(0);
    }
    expect(COHORT_RULE_MAX_CONDS).toBe(10);
  });
});

describe('9A readCohortRule: the one validator (builder, server action, and 9B Ask Coop drafts)', () => {
  it('normalises values: code upper-cased and trimmed, numbers from strings, enums lower-cased; extra keys dropped', () => {
    expect(
      ok({all: [{f: 'code', op: 'is', v: ' circuit10 ', x: 1}, {f: 'orders', op: 'eq', v: '1'}, {f: 'tier', op: 'is', v: 'Gold'}, {f: 'life', op: 'gte', v: 1500.5}]}),
    ).toEqual(rule({f: 'code', op: 'is', v: 'CIRCUIT10'}, {f: 'orders', op: 'eq', v: 1}, {f: 'tier', op: 'is', v: 'gold'}, {f: 'life', op: 'gte', v: 1500.5}));
  });
  it('accepts every field with every one of its operators', () => {
    const sample: Record<string, string | number> = {code: 'X', anycode: 'X', first: '2026-10-01', orders: 1, days: 30, life: 1000, ytd: 500, tier: 'gold', lcdays: 30, times: 0, consent: 'subscribed'};
    for (const f of COHORT_FIELDS) for (const op of COHORT_FIELD_SPEC[f].ops) expect('rule' in readCohortRule({all: [{f, op, v: sample[f]}]}), `${f} ${op}`).toBe(true);
  });
  it.each([
    [null, /rule/i],
    [{all: []}, /at least one condition/i],
    [{all: 'x'}, /at least one condition/i],
    [{all: Array.from({length: 11}, () => ({f: 'orders', op: 'gte', v: 1}))}, /10 conditions/],
    [{all: [{f: 'pawsport', op: 'is', v: 'x'}]}, /field Coop does not know.*First-order code/i],
    [{all: [{f: 'orders', op: 'is', v: 1}]}, /operator/i],
    [{all: [{f: 'code', op: 'gte', v: 'X'}]}, /operator/i],
    [{all: [{f: 'orders', op: 'gte', v: 'two'}]}, /number/i],
    [{all: [{f: 'orders', op: 'gte', v: 1.5}]}, /whole number/i],
    [{all: [{f: 'days', op: 'gte', v: -1}]}, /number/i],
    [{all: [{f: 'life', op: 'gte', v: ''}]}, /number/i],
    [{all: [{f: 'first', op: 'on_or_after', v: '2026-13-01'}]}, /date/i],
    [{all: [{f: 'first', op: 'on_or_after', v: 'last week'}]}, /date/i],
    [{all: [{f: 'tier', op: 'is', v: 'diamond'}]}, /Platinum, Gold or Guest/],
    [{all: [{f: 'consent', op: 'is', v: 'maybe'}]}, /consent/i],
    [{all: [{f: 'code', op: 'is', v: '  '}]}, /code/i],
    [{all: [{f: 'code', op: 'is', v: 'X'.repeat(65)}]}, /code/i],
    [{all: ['orders >= 2']}, /condition/i],
  ])('refuses %j', (input, msg) => {
    const r = readCohortRule(input);
    expect('error' in r && r.error).toMatch(msg);
  });
});

describe('9A matchesCohort: every field and operator', () => {
  const m = (r: Partial<CohortRow>, ...c: CohortRule['all']) => matchesCohort(row(r), rule(...c));
  it('first-order code is / is not, case-insensitive', () => {
    expect(m({}, {f: 'code', op: 'is', v: 'CIRCUIT10'})).toBe(true);
    expect(m({firstOrderCode: 'circuit10'}, {f: 'code', op: 'is', v: 'CIRCUIT10'})).toBe(true);
    expect(m({}, {f: 'code', op: 'is', v: 'PETEXPO'})).toBe(false);
    expect(m({}, {f: 'code', op: 'is_not', v: 'PETEXPO'})).toBe(true);
    expect(m({}, {f: 'code', op: 'is_not', v: 'CIRCUIT10'})).toBe(false);
    expect(m({firstOrderCode: 'no code'}, {f: 'code', op: 'is', v: 'NO CODE'})).toBe(true);
  });
  it('first order date on or after / on or before, by the PH day (inclusive)', () => {
    // 2026-09-30T17:00Z is Oct 1 01:00 in Manila.
    expect(m({firstOrderAt: '2026-09-30T17:00:00Z'}, {f: 'first', op: 'on_or_after', v: '2026-10-01'})).toBe(true);
    expect(m({firstOrderAt: '2026-09-30T15:00:00Z'}, {f: 'first', op: 'on_or_after', v: '2026-10-01'})).toBe(false);
    expect(m({firstOrderAt: '2026-10-01T02:00:00Z'}, {f: 'first', op: 'on_or_before', v: '2026-10-01'})).toBe(true);
    expect(m({firstOrderAt: '2026-10-02T02:00:00Z'}, {f: 'first', op: 'on_or_before', v: '2026-10-01'})).toBe(false);
  });
  it('orders at least / at most / exactly', () => {
    expect(m({orderCount: 2}, {f: 'orders', op: 'gte', v: 2})).toBe(true);
    expect(m({orderCount: 1}, {f: 'orders', op: 'gte', v: 2})).toBe(false);
    expect(m({orderCount: 1}, {f: 'orders', op: 'lte', v: 1})).toBe(true);
    expect(m({orderCount: 2}, {f: 'orders', op: 'lte', v: 1})).toBe(false);
    expect(m({orderCount: 1}, {f: 'orders', op: 'eq', v: 1})).toBe(true);
    expect(m({orderCount: 3}, {f: 'orders', op: 'eq', v: 1})).toBe(false);
  });
  it('days since last order at least / at most', () => {
    expect(m({daysSinceLastOrder: 30}, {f: 'days', op: 'gte', v: 30})).toBe(true);
    expect(m({daysSinceLastOrder: 29}, {f: 'days', op: 'gte', v: 30})).toBe(false);
    expect(m({daysSinceLastOrder: 7}, {f: 'days', op: 'lte', v: 7})).toBe(true);
    expect(m({daysSinceLastOrder: 8}, {f: 'days', op: 'lte', v: 7})).toBe(false);
  });
  it('lifetime and membership-year spend at least / at most', () => {
    expect(m({spent: 1500}, {f: 'life', op: 'gte', v: 1500})).toBe(true);
    expect(m({spent: 1499.99}, {f: 'life', op: 'gte', v: 1500})).toBe(false);
    expect(m({spent: 1500}, {f: 'life', op: 'lte', v: 1500})).toBe(true);
    expect(m({spendYtd: 500}, {f: 'ytd', op: 'gte', v: 500})).toBe(true);
    expect(m({spendYtd: 501}, {f: 'ytd', op: 'lte', v: 500})).toBe(false);
  });
  it('tier is / is not; no tier (or an unknown one) is Guest, as the tier tiles count it', () => {
    expect(m({membershipTier: 'platinum'}, {f: 'tier', op: 'is', v: 'platinum'})).toBe(true);
    expect(m({membershipTier: 'gold'}, {f: 'tier', op: 'is', v: 'platinum'})).toBe(false);
    expect(m({membershipTier: null}, {f: 'tier', op: 'is', v: 'guest'})).toBe(true);
    expect(m({membershipTier: 'silver'}, {f: 'tier', op: 'is', v: 'guest'})).toBe(true);
    expect(m({membershipTier: 'gold'}, {f: 'tier', op: 'is_not', v: 'guest'})).toBe(true);
  });
  it('days since last contacted at least / at most', () => {
    const contacted = (d: number) => ({lastContactedAt: '2026-10-01T00:00:00Z', daysSinceLastContact: d});
    expect(m(contacted(30), {f: 'lcdays', op: 'gte', v: 30})).toBe(true);
    expect(m(contacted(29), {f: 'lcdays', op: 'gte', v: 30})).toBe(false);
    expect(m(contacted(5), {f: 'lcdays', op: 'lte', v: 7})).toBe(true);
    expect(m(contacted(8), {f: 'lcdays', op: 'lte', v: 7})).toBe(false);
  });
  it('times contacted at least / at most / exactly', () => {
    expect(m({timesContacted: 3}, {f: 'times', op: 'gte', v: 3})).toBe(true);
    expect(m({timesContacted: 2}, {f: 'times', op: 'gte', v: 3})).toBe(false);
    expect(m({timesContacted: 0}, {f: 'times', op: 'lte', v: 0})).toBe(true);
    expect(m({timesContacted: 0}, {f: 'times', op: 'eq', v: 0})).toBe(true);
    expect(m({timesContacted: 1}, {f: 'times', op: 'eq', v: 0})).toBe(false);
  });
  it('consent: subscribed vs everything else (not subscribed, unsubscribed, unknown)', () => {
    expect(m({consent: 'subscribed'}, {f: 'consent', op: 'is', v: 'subscribed'})).toBe(true);
    expect(m({consent: 'SUBSCRIBED'}, {f: 'consent', op: 'is', v: 'subscribed'})).toBe(true);
    expect(m({consent: 'unsubscribed'}, {f: 'consent', op: 'is', v: 'subscribed'})).toBe(false);
    expect(m({consent: 'unknown'}, {f: 'consent', op: 'is', v: 'not_subscribed'})).toBe(true);
    expect(m({consent: 'not_subscribed'}, {f: 'consent', op: 'is_not', v: 'subscribed'})).toBe(true);
    expect(m({consent: 'subscribed'}, {f: 'consent', op: 'is_not', v: 'not_subscribed'})).toBe(true);
  });
});

describe('9A nulls: never ordered, never contacted, a source unread', () => {
  const never = {orderCount: 0, firstOrderCode: null, firstOrderAt: null, daysSinceLastOrder: null, spent: 0, spendYtd: 0};
  const m = (r: Partial<CohortRow>, ...c: CohortRule['all']) => matchesCohort(row(r), rule(...c));
  it('never ordered: no order-based condition holds (code is AND is not, date, days), but orders = 0 and spend do', () => {
    expect(m(never, {f: 'code', op: 'is', v: 'CIRCUIT10'})).toBe(false);
    expect(m(never, {f: 'code', op: 'is_not', v: 'CIRCUIT10'})).toBe(false);
    expect(m(never, {f: 'first', op: 'on_or_after', v: '2020-01-01'})).toBe(false);
    expect(m(never, {f: 'first', op: 'on_or_before', v: '2099-01-01'})).toBe(false);
    expect(m(never, {f: 'days', op: 'gte', v: 0})).toBe(false);
    expect(m(never, {f: 'days', op: 'lte', v: 9999})).toBe(false);
    expect(m(never, {f: 'orders', op: 'eq', v: 0})).toBe(true);
    expect(m(never, {f: 'life', op: 'lte', v: 0})).toBe(true);
  });
  it('never contacted (every source read) counts as at least any day count, never as "contacted in the last N days"', () => {
    expect(m({lastContactKnown: true, lastContactedAt: null, daysSinceLastContact: null}, {f: 'lcdays', op: 'gte', v: 100000})).toBe(true);
    expect(m({lastContactKnown: true, lastContactedAt: null, daysSinceLastContact: null}, {f: 'lcdays', op: 'lte', v: 100000})).toBe(false);
  });
  it('a contact source unread: last contacted and times contacted are unknown, so no condition on them holds', () => {
    const unknown = {lastContactKnown: false, lastContactedAt: null, daysSinceLastContact: null, timesContacted: null};
    expect(m(unknown, {f: 'lcdays', op: 'gte', v: 0})).toBe(false);
    expect(m(unknown, {f: 'lcdays', op: 'lte', v: 100000})).toBe(false);
    expect(m(unknown, {f: 'times', op: 'gte', v: 0})).toBe(false);
    expect(m(unknown, {f: 'times', op: 'eq', v: 0})).toBe(false);
  });
});

describe('9A AND logic', () => {
  const circuit = rule({f: 'code', op: 'is', v: 'CIRCUIT10'}, {f: 'orders', op: 'eq', v: 1});
  it('every condition must hold', () => {
    expect(matchesCohort(row(), circuit)).toBe(true);
    expect(matchesCohort(row({orderCount: 2}), circuit)).toBe(false);
    expect(matchesCohort(row({firstOrderCode: 'PETEXPO'}), circuit)).toBe(false);
    expect(matchesCohort(row({orderCount: 2, firstOrderCode: 'PETEXPO'}), circuit)).toBe(false);
  });
  it('a rule that is not valid matches nobody (never everybody)', () => {
    expect(matchesCohort(row(), {all: []})).toBe(false);
    expect(matchesCohort(row(), {all: [{f: 'nope', op: 'is', v: 'x'}]} as unknown as CohortRule)).toBe(false);
  });
});

describe('9A rules read as plain sentences (never field codes)', () => {
  it('the owner example', () => {
    expect(ruleText(rule({f: 'code', op: 'is', v: 'CIRCUIT10'}, {f: 'orders', op: 'eq', v: 1}))).toBe('First order used code CIRCUIT10, and has exactly 1 order');
  });
  it.each([
    [{f: 'code', op: 'is_not', v: 'PETEXPO'}, 'First order did not use code PETEXPO'],
    [{f: 'code', op: 'is', v: 'NO CODE'}, 'First order used no code'],
    [{f: 'first', op: 'on_or_after', v: '2026-10-01'}, 'First order on or after Oct 1, 2026'],
    [{f: 'first', op: 'on_or_before', v: '2026-10-31'}, 'First order on or before Oct 31, 2026'],
    [{f: 'orders', op: 'eq', v: 3}, 'Has exactly 3 orders'],
    [{f: 'orders', op: 'gte', v: 2}, 'Has 2 or more orders'],
    [{f: 'orders', op: 'lte', v: 1}, 'Has at most 1 order'],
    [{f: 'days', op: 'gte', v: 60}, 'Last order was 60 or more days ago'],
    [{f: 'days', op: 'lte', v: 30}, 'Ordered in the last 30 days'],
    [{f: 'life', op: 'gte', v: 5000}, 'Spent ₱5,000 or more in total'],
    [{f: 'ytd', op: 'lte', v: 1500.5}, 'Spent at most ₱1,500.50 this membership year'],
    [{f: 'tier', op: 'is', v: 'platinum'}, 'Tier is Platinum'],
    [{f: 'tier', op: 'is_not', v: 'guest'}, 'Tier is not Guest'],
    [{f: 'lcdays', op: 'gte', v: 30}, 'Not contacted in the last 30 days'],
    [{f: 'lcdays', op: 'lte', v: 7}, 'Contacted in the last 7 days'],
    [{f: 'times', op: 'eq', v: 0}, 'Never contacted'],
    [{f: 'times', op: 'eq', v: 1}, 'Contacted exactly 1 time'],
    [{f: 'times', op: 'gte', v: 2}, 'Contacted 2 or more times'],
    [{f: 'consent', op: 'is', v: 'subscribed'}, 'Subscribed to email'],
    [{f: 'consent', op: 'is_not', v: 'subscribed'}, 'Not subscribed to email'],
  ] as const)('%j → %s', (c, text) => {
    expect(condText(c)).toBe(text);
  });
  it('no sentence ever shows a field or operator code', () => {
    const sample: Record<string, string | number> = {code: 'X', anycode: 'X', first: '2026-10-01', orders: 1, days: 30, life: 1000, ytd: 500, tier: 'gold', lcdays: 30, times: 2, consent: 'not_subscribed'};
    for (const f of COHORT_FIELDS) {
      for (const op of COHORT_FIELD_SPEC[f].ops) {
        const t = condText({f, op, v: sample[f]} as CohortRule['all'][number]);
        expect(t, `${f} ${op}`).not.toMatch(/\b(lcdays|ytd|life|on_or_after|on_or_before|is_not|gte|lte|eq|not_subscribed)\b/);
      }
    }
  });
});

describe('9A built-ins stay inAudience and match it exactly', () => {
  const c = (orderCount: number, lastOrderAt: string | null): EnrichedCustomer => ({
    shopifyCustomerId: `${orderCount}-${lastOrderAt}`, email: null, firstName: null, lastName: null, phone: null, ordersCount: null, totalSpent: null,
    membershipTier: null, petName: null, petBirthday: null, emailMarketingState: null, createdAt: null, updatedAt: null,
    orderCount, spent: 0, spendYtd: 0, firstOrderAt: lastOrderAt, lastOrderAt, firstOrderCode: orderCount ? 'no code' : null, codesUsed: null,
  });
  const days = [null, 0, 29, 30, 31, 59, 60, 61, 400];
  const at = (d: number | null) => (d === null ? null : new Date(NOW.getTime() - d * 86_400_000).toISOString());
  const rows = customerRows([0, 1, 2, 3, 5].flatMap((n) => days.map((d) => c(n, at(d)))), null, NOW);
  it.each(['repeat_promo', 'win_back'] as const)('%s: the rule form picks exactly the inAudience list', (a) => {
    const viaRule = rows.filter((r) => matchesCohort(r, BUILTIN_COHORT_RULES[a])).map((r) => r.shopifyCustomerId);
    const viaAudience = rows.filter((r) => inAudience(r, a, NOW)).map((r) => r.shopifyCustomerId);
    expect(viaAudience.length).toBeGreaterThan(0);
    expect(viaRule).toEqual(viaAudience);
  });
  it('their sentences', () => {
    expect(ruleText(BUILTIN_COHORT_RULES.repeat_promo)).toBe('Has exactly 1 order, and last order was 30 or more days ago');
    expect(ruleText(BUILTIN_COHORT_RULES.win_back)).toBe('Has 2 or more orders, and last order was 60 or more days ago');
  });
});

describe('9A customerRows carries days since last contacted for the evaluator', () => {
  const e: EnrichedCustomer = {
    shopifyCustomerId: '1', email: 'mia@x.com', firstName: null, lastName: null, phone: null, ordersCount: null, totalSpent: null, membershipTier: null,
    petName: null, petBirthday: null, emailMarketingState: null, createdAt: null, updatedAt: null,
    orderCount: 1, spent: 0, spendYtd: 0, firstOrderAt: null, lastOrderAt: null, firstOrderCode: null, codesUsed: null,
  };
  it('PH days since the last contact when known; null when never or unknown', () => {
    const tally = contactTally({checkouts: [], orders: [], birthdayVouchers: [], manualContacts: [{email: 'mia@x.com', channel: 'sms', contactedAt: '2026-10-31T04:00:00Z'}]});
    expect(customerRows([e], tally, NOW, {automated: true, manual: true})[0].daysSinceLastContact).toBe(10);
    expect(customerRows([{...e, email: 'noa@x.com'}], tally, NOW, {automated: true, manual: true})[0].daysSinceLastContact).toBeNull();
    expect(customerRows([e], tally, NOW, {automated: true, manual: false})[0].daysSinceLastContact).toBeNull();
  });
});

describe('9A labels: group + name in plain words', () => {
  it('trims and collapses spaces; shows as "Group · Name"', () => {
    expect(readCohortLabel({group: '  Event ', name: ' Circuit   Makati '})).toEqual({group: 'Event', name: 'Circuit Makati'});
    expect(cohortLabel({group: 'Event', name: 'Circuit Makati'})).toBe('Event · Circuit Makati');
    expect([COHORT_GROUP_MAX, COHORT_NAME_MAX]).toEqual([24, 48]);
  });
  it.each([
    [{group: '', name: 'Circuit Makati'}, /group/i],
    [{group: 'Event', name: '   '}, /name/i],
    [{group: 'E'.repeat(25), name: 'x'}, /24/],
    [{group: 'Event', name: 'n'.repeat(49)}, /48/],
    [{group: '---', name: 'x'}, /letter or number/i],
    [{group: 'Event', name: 'a\u0000b'}, /plain text/i],
    [{group: 7, name: 'x'}, /group/i],
  ])('refuses %j', (input, msg) => {
    const r = readCohortLabel(input);
    expect('error' in r && r.error).toMatch(msg);
  });
  it('limits are inclusive', () => {
    expect('error' in readCohortLabel({group: 'E'.repeat(24), name: 'n'.repeat(48)})).toBe(false);
  });
  it('uniqueness is case-insensitive on group + name, and an edit does not collide with itself', () => {
    const existing = [{id: 'a', group: 'Event', name: 'Circuit Makati'}];
    expect(labelTaken(existing, {group: 'event', name: 'CIRCUIT makati'})).toBe(true);
    expect(labelTaken(existing, {group: 'Promo', name: 'Circuit Makati'})).toBe(false);
    expect(labelTaken(existing, {group: 'Event', name: 'Circuit Makati'}, 'a')).toBe(false);
  });
});

function fakeDeps(o: {actor?: string | null; missing?: boolean; owner?: string; dup?: {id: string; rule: CohortRule; createdBy: string} | null} = {}) {
  const inserted: Record<string, unknown>[] = [];
  const updates: Array<{id: string; by: string; patch: Record<string, unknown>}> = [];
  const deletes: Array<{id: string; by: string}> = [];
  const missing = {code: 'PGRST205', message: "Could not find the table 'public.customer_cohorts' in the schema cache"};
  const dupErr = {code: '23505', message: 'duplicate key value violates unique constraint "customer_cohorts_label_key"'};
  const deps: CohortDeps = {
    actor: async () => (o.actor === undefined ? ME : o.actor),
    insert: async (r) => {
      if (o.missing) return {error: missing, id: null};
      if (o.dup) return {error: dupErr, id: null};
      inserted.push(r);
      return {error: null, id: ID};
    },
    findByLabel: async () => o.dup ?? null,
    updateOwn: async (id, by, patch) => {
      if (o.missing) return {error: missing, updated: 0};
      if (o.dup) return {error: dupErr, updated: 0};
      updates.push({id, by, patch});
      return {error: null, updated: by === (o.owner ?? ME) ? 1 : 0};
    },
    deleteOwn: async (id, by) => {
      if (o.missing) return {error: missing, deleted: 0};
      deletes.push({id, by});
      return {error: null, deleted: by === (o.owner ?? ME) ? 1 : 0};
    },
  };
  return {deps, inserted, updates, deletes};
}

const CIRCUIT = {group: 'Event', name: 'Circuit Makati', rule: {all: [{f: 'code', op: 'is', v: 'circuit10'}, {f: 'orders', op: 'eq', v: '1'}]}};
const CIRCUIT_RULE = rule({f: 'code', op: 'is', v: 'CIRCUIT10'}, {f: 'orders', op: 'eq', v: 1});

describe('9A create: the one save path (builder now, Ask Coop Save in 9B)', () => {
  it('writes the validated label and rule with created_by from the session, never from the input', async () => {
    const {deps, inserted} = fakeDeps();
    const r = await createCohortWith(deps, {...CIRCUIT, createdBy: 'someone@else.ph', created_by: 'x@y.z'});
    expect(r).toEqual({ok: true, id: ID});
    expect(inserted).toEqual([{group_name: 'Event', name: 'Circuit Makati', rule: CIRCUIT_RULE, created_by: ME}]);
  });
  it('an invalid rule is refused server-side, nothing written', async () => {
    const {deps, inserted} = fakeDeps();
    const r = await createCohortWith(deps, {...CIRCUIT, rule: {all: [{f: 'pawsport', op: 'is', v: 'yes'}]}});
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/field Coop does not know/);
    expect(inserted).toEqual([]);
  });
  it('an invalid label is refused, nothing written', async () => {
    const {deps, inserted} = fakeDeps();
    expect((await createCohortWith(deps, {...CIRCUIT, group: ''})).ok).toBe(false);
    expect(inserted).toEqual([]);
  });
  it('no session: refused, nothing written', async () => {
    const {deps, inserted} = fakeDeps({actor: null});
    const r = await createCohortWith(deps, CIRCUIT);
    expect(!r.ok && r.error).toMatch(/sign in/i);
    expect(inserted).toEqual([]);
  });
  it('the table not applied: "not set up", no crash', async () => {
    const {deps} = fakeDeps({missing: true});
    const r = await createCohortWith(deps, CIRCUIT);
    expect(!r.ok && r.error).toMatch(/aren't set up/i);
  });
  it('the same label, rule and creator again (double click, retry): ok with the existing id, "Already saved"', async () => {
    const {deps} = fakeDeps({dup: {id: 'existing', rule: CIRCUIT_RULE, createdBy: ME}});
    expect(await createCohortWith(deps, {...CIRCUIT, group: 'EVENT', name: 'circuit makati'})).toEqual({ok: true, id: 'existing', already: true});
  });
  it('the same label with another rule, or by another person: refused, never overwritten', async () => {
    for (const dup of [{id: 'e', rule: rule({f: 'orders', op: 'gte', v: 2}), createdBy: ME}, {id: 'e', rule: CIRCUIT_RULE, createdBy: 'leo@zoomy.ph'}]) {
      const {deps, updates} = fakeDeps({dup});
      const r = await createCohortWith(deps, CIRCUIT);
      expect(!r.ok && r.error).toBe('A cohort named Event · Circuit Makati already exists.');
      expect(updates).toEqual([]);
    }
  });
});

describe('9A edit and delete: creator only', () => {
  it('edit re-validates and is filtered by id AND the session email', async () => {
    const {deps, updates} = fakeDeps();
    expect(await updateCohortWith(deps, ID, CIRCUIT)).toEqual({ok: true, id: ID});
    expect(updates).toEqual([{id: ID, by: ME, patch: {group_name: 'Event', name: 'Circuit Makati', rule: CIRCUIT_RULE}}]);
  });
  it("someone else's cohort: nothing changes, a clear message", async () => {
    const {deps} = fakeDeps({owner: 'leo@zoomy.ph'});
    const r = await updateCohortWith(deps, ID, CIRCUIT);
    expect(!r.ok && r.error).toMatch(/only edit a cohort you saved/i);
    const d = await deleteCohortWith(deps, ID);
    expect(!d.ok && d.error).toMatch(/only delete a cohort you saved/i);
  });
  it('an invalid rule on edit is refused before any write', async () => {
    const {deps, updates} = fakeDeps();
    expect((await updateCohortWith(deps, ID, {...CIRCUIT, rule: {all: []}})).ok).toBe(false);
    expect(updates).toEqual([]);
  });
  it('an edit onto a label that exists is refused', async () => {
    const {deps} = fakeDeps({dup: {id: 'other', rule: CIRCUIT_RULE, createdBy: ME}});
    const r = await updateCohortWith(deps, ID, CIRCUIT);
    expect(!r.ok && r.error).toBe('A cohort named Event · Circuit Makati already exists.');
  });
  it('a bad id or no session is refused', async () => {
    const {deps, deletes} = fakeDeps();
    expect((await deleteCohortWith(deps, 'not-a-uuid')).ok).toBe(false);
    expect((await deleteCohortWith(fakeDeps({actor: null}).deps, ID)).ok).toBe(false);
    expect(deletes).toEqual([]);
    expect(await deleteCohortWith(deps, ID)).toEqual({ok: true, id: ID});
  });
});

describe('9A the read: null when unavailable, stored rules re-checked', () => {
  const page = (rows: Record<string, unknown>[] | null, error: {code?: string; message: string} | null = null) => async () => ({data: rows, error});
  const stored = {id: ID, group_name: 'Event', name: 'Circuit Makati', rule: CIRCUIT_RULE, created_by: ME, created_at: '2026-11-12T02:00:00Z', updated_at: '2026-11-12T03:00:00Z'};
  it('rows are projected', async () => {
    expect(await loadCohortRows(page([stored]))).toEqual([
      {id: ID, group: 'Event', name: 'Circuit Makati', rule: CIRCUIT_RULE, createdBy: ME, createdAt: '2026-11-12T02:00:00Z', updatedAt: '2026-11-12T03:00:00Z'},
    ]);
  });
  it('a stored rule that no longer validates is left out (never evaluated)', async () => {
    expect(await loadCohortRows(page([{...stored, rule: {all: [{f: 'gone', op: 'is', v: 1}]}}]))).toEqual([]);
  });
  it.each([[{code: 'PGRST205', message: 'x'}], [{code: '42P01', message: 'x'}], [{code: '57014', message: 'timeout'}]])('%j gives null', async (error) => {
    expect(await loadCohortRows(page(null, error))).toBeNull();
  });
});

describe('9A cohortsOf: the labels one customer gets, live from the rules', () => {
  const cohort = (id: string, group: string, name: string, r: CohortRule): CustomerCohort => ({id, group, name, rule: r, createdBy: ME, createdAt: '', updatedAt: ''});
  const cohorts = [
    cohort('1', 'Promo', 'Big spenders', rule({f: 'life', op: 'gte', v: 1000})),
    cohort('2', 'Event', 'Circuit Makati', CIRCUIT_RULE),
    cohort('3', 'Event', 'Pet Expo', rule({f: 'code', op: 'is', v: 'PETEXPO'})),
  ];
  it('only matching cohorts, sorted by group then name', () => {
    expect(cohortsOf(row(), cohorts).map(cohortLabel)).toEqual(['Event · Circuit Makati', 'Promo · Big spenders']);
    expect(cohortsOf(row({spent: 0, orderCount: 2}), cohorts)).toEqual([]);
  });
  it('the input parse for the action combines label + rule', () => {
    expect(readCohortInput(CIRCUIT)).toEqual({group: 'Event', name: 'Circuit Makati', rule: CIRCUIT_RULE});
  });
});

describe('9A negative: no send path, no hand tagging, the table stays service-role only', () => {
  const read = (p: string) => readFileSync(p, 'utf8');
  it('no cohort module can send anything', () => {
    for (const f of ['src/customer-cohorts.ts', 'src/customer-cohorts-actions.ts', 'src/customer-cohorts-data.ts']) {
      expect(read(f), f).not.toMatch(/\bfetch\(|resend|sendEmail|sendMail|nodemailer|createCrmClient|postShopify/i);
    }
  });
  it('the DDL: group_name + name unique case-insensitively, rule jsonb, RLS on, no policy, no grant, no member list', () => {
    const sql = read('supabase/customer_cohorts.sql').replace(/--.*$/gm, '');
    expect(sql).toMatch(/create table if not exists public\.customer_cohorts/i);
    expect(sql).toMatch(/group_name\s+text not null/);
    expect(sql).toMatch(/rule\s+jsonb not null/);
    expect(sql).toMatch(/create unique index if not exists \w+ on public\.customer_cohorts \(lower\(group_name\), lower\(name\)\)/i);
    expect(sql).toMatch(/enable row level security/i);
    expect(sql).not.toMatch(/create policy|grant |\bkey\s+text|\bvalue\s+text|member/i);
  });
});

describe('RET-12 "Used code (any order)"', () => {
  const cust = (id: string) => ({shopifyCustomerId: id, email: `${id}@x.com`, firstName: null, lastName: null, phone: null, ordersCount: null, totalSpent: null, membershipTier: null, petName: null, petBirthday: null, emailMarketingState: null, createdAt: null, updatedAt: null});
  const ord = (id: string, n: number, codes: string[], over: Record<string, unknown> = {}) => ({
    shopifyOrderId: `${id}-${n}`, shopifyCustomerId: id, orderNumber: `#${id}${n}`, email: `${id}@x.com`, totalPrice: '500', currency: 'PHP',
    financialStatus: 'paid', fulfillmentStatus: null, createdAt: `2026-0${n}-01T00:00:00Z`, fulfilledAt: null, reviewRequestSentAt: null, reviewSubmittedAt: null,
    discountCodes: codes, ...over,
  });
  const rowsOf = (orders: ReturnType<typeof ord>[], ids: string[]) =>
    enrichCustomers(ids.map(cust), orders, '2026-01-01').map((c) => ({...row(), ...c, daysSinceLastOrder: 10}) as CohortRow);
  const any = (op: 'is' | 'is_not', v: string) => rule({f: 'anycode', op, v});

  it('a code on the 2nd order matches "used on any order" but not the first-order code field', () => {
    const [r] = rowsOf([ord('a', 1, []), ord('a', 2, ['GRAND300'])], ['a']);
    expect(r.codesUsed).toEqual(['GRAND300']);
    expect(matchesCohort(r, any('is', 'GRAND300'))).toBe(true);
    expect(matchesCohort(r, rule({f: 'code', op: 'is', v: 'GRAND300'}))).toBe(false);
  });
  it('"no code" = no code on any counted order; a code on order 3 puts the buyer out', () => {
    const [none, late, bday] = rowsOf([ord('a', 1, []), ord('a', 2, []), ord('b', 1, []), ord('b', 2, []), ord('b', 3, ['GRAND300']), ord('c', 1, ['BDAY-'])], ['a', 'b', 'c']);
    expect(matchesCohort(none, any('is', 'no code'))).toBe(true);
    expect(matchesCohort(late, any('is', 'no code'))).toBe(false);
    expect(matchesCohort(bday, any('is', 'no code'))).toBe(false); // a birthday code counts as a code
    expect(matchesCohort(none, any('is_not', 'no code'))).toBe(false);
    expect(matchesCohort(late, any('is_not', 'no code'))).toBe(true);
  });
  it('"is not X" includes code-less buyers and excludes X users', () => {
    const [x, other, none] = rowsOf([ord('a', 1, ['GRAND300']), ord('b', 1, ['RETURN30']), ord('c', 1, [])], ['a', 'b', 'c']);
    expect([x, other, none].map((r) => matchesCohort(r, any('is_not', 'GRAND300')))).toEqual([false, true, true]);
  });
  it('0 orders matches nothing, in all four forms', () => {
    const [r] = rowsOf([], ['a']);
    expect(r.codesUsed).toBeNull();
    for (const [op, v] of [['is', 'GRAND300'], ['is_not', 'GRAND300'], ['is', 'no code'], ['is_not', 'no code']] as const) {
      expect(matchesCohort(r, any(op, v)), `${op} ${v}`).toBe(false);
    }
  });
  it('a test order never counts; BDAY- reads as the birthday key; BUNDLE- collapses', () => {
    const [t, b, u] = rowsOf(
      [ord('a', 1, ['GRAND300'], {test: true}), ord('a', 2, []), ord('b', 1, ['BDAY-']), ord('c', 1, ['BUNDLE-1']), ord('c', 2, ['BUNDLE-2'])],
      ['a', 'b', 'c'],
    );
    expect(matchesCohort(t, any('is', 'GRAND300'))).toBe(false);
    expect(matchesCohort(t, any('is', 'no code'))).toBe(true);
    expect(matchesCohort(b, any('is', 'birthday voucher'))).toBe(true);
    expect(matchesCohort(b, any('is_not', 'birthday voucher'))).toBe(false);
    expect(u.codesUsed).toEqual(['BUNDLE (auto)']);
    expect(matchesCohort(u, any('is', 'bundle (auto)'))).toBe(true);
  });
  it('codesUsed equals the labels of customerVouchers for every customer', () => {
    const orders = [ord('a', 1, ['GRAND300', 'BDAY-']), ord('a', 2, ['RETURN30']), ord('b', 1, []), ord('c', 1, ['BUNDLE-9'])];
    for (const e of enrichCustomers(['a', 'b', 'c'].map(cust), orders, '2026-01-01')) {
      const labels = new Set((customerVouchers(e, orders as never) ?? []).map((v) => v.label.toUpperCase()));
      expect(new Set((e.codesUsed ?? []).map((k) => k.toUpperCase())), e.shopifyCustomerId).toEqual(labels);
    }
  });
  it('codesUsedList: codes with buyers, biggest first', () => {
    const rows = rowsOf([ord('a', 1, ['B']), ord('b', 1, ['A']), ord('c', 1, ['A']), ord('d', 1, [])], ['a', 'b', 'c', 'd']);
    expect(codesUsedList(rows)).toEqual(['A', 'B']);
  });
  it('sentences say it in words, never the field code', () => {
    expect(condText({f: 'anycode', op: 'is', v: 'GRAND300'})).toBe('Used code GRAND300 on any order');
    expect(condText({f: 'anycode', op: 'is_not', v: 'GRAND300'})).toBe('Never used code GRAND300');
    expect(condText({f: 'anycode', op: 'is', v: 'NO CODE'})).toBe('Never used any code');
    expect(condText({f: 'anycode', op: 'is_not', v: 'NO CODE'})).toBe('Used a code on some order');
    expect(condText({f: 'anycode', op: 'is', v: 'BIRTHDAY VOUCHER'})).toBe('Used a birthday voucher on some order');
    expect(condText({f: 'anycode', op: 'is_not', v: 'BIRTHDAY VOUCHER'})).toBe('Never used a birthday voucher');
    expect(ruleText(rule({f: 'anycode', op: 'is', v: 'GRAND300'}, {f: 'orders', op: 'eq', v: 1}))).not.toMatch(/anycode/);
  });
  it('readCohortRule accepts anycode is / is not and refuses gte', () => {
    expect(readCohortRule({all: [{f: 'anycode', op: 'is', v: 'grand300'}]})).toEqual({rule: {all: [{f: 'anycode', op: 'is', v: 'GRAND300'}]}});
    expect(readCohortRule({all: [{f: 'anycode', op: 'is_not', v: 'x'}]})).toHaveProperty('rule');
    expect(readCohortRule({all: [{f: 'anycode', op: 'gte', v: 'x'}]})).toHaveProperty('error');
  });
});
