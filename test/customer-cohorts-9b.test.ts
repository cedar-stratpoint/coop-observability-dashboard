// RET-10 Stage 9B (plan knowledge/tasks/2026-11-12-customer-cohorts-stage9.md): the pure helpers the Website CRM page and Ask Coop
// share for drafts. Expected answers are written by hand first. Owner rules: code counts the preview (never the model), the preview
// shows first names only, suggestions are first-order codes with buyers that no saved cohort covers yet, and users see plain
// "Group · Name" labels (an `event:circuit-makati` style key still finds the cohort, but is never shown).
import {describe, expect, it} from 'vitest';
import {BIRTHDAY_COHORT, NO_CODE, matchesCohort, repeatRate, type CohortRow, type CohortRule} from '../src/crm-compute';
import {cohortPreview, cohortSuggestions, findCohort, ruleUsesContact, type CustomerCohort} from '../src/customer-cohorts';

type Row = CohortRow & {firstName: string | null; lastName?: string | null; email?: string | null};
const row = (o: Partial<Row> = {}): Row => ({
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
  firstName: 'Ana',
  lastName: 'Cruz',
  email: 'ana@example.com',
  ...o,
});
const rule = (...all: CohortRule['all']): CohortRule => ({all});
const saved = (group: string, name: string, r: CohortRule, id = `${group}-${name}`): CustomerCohort => ({id, group, name, rule: r, createdBy: 'me@zoomy.ph', createdAt: '', updatedAt: ''});

describe('9B cohortPreview: code counts the draft with the page evaluator', () => {
  const rows = [
    row({firstName: 'Ana', orderCount: 1}),
    row({firstName: 'Ben', orderCount: 2}),
    row({firstName: 'Cy', orderCount: 1, firstOrderCode: 'PETEXPO'}),
    row({firstName: 'Dee Ann', orderCount: 1}),
    row({firstName: null, orderCount: 1}),
    row({firstName: '  ', orderCount: 1}),
    row({firstName: 'Eve', orderCount: 0, firstOrderCode: null, firstOrderAt: null}),
  ];
  const circuit = rule({f: 'code', op: 'is', v: 'CIRCUIT10'});

  it('counts members, buyers and repeat buyers exactly as matchesCohort + repeatRate on the same rows', () => {
    const p = cohortPreview(rows, circuit);
    const members = rows.filter((r) => matchesCohort(r, circuit));
    expect(p.customers).toBe(members.length);
    expect({buyers: p.buyers, repeat: p.repeat, ratePct: p.ratePct}).toEqual(repeatRate(members.map((r) => r.orderCount)));
    // by hand: Ana, Ben, Dee Ann, the two nameless rows = 5 members; 5 buyers; Ben repeats → 1 of 5 = 20.0%
    expect(p).toMatchObject({customers: 5, buyers: 5, repeat: 1, ratePct: 20});
  });

  it('shows first names only (no last name, no email), at most five, skipping blanks', () => {
    const p = cohortPreview(rows, circuit);
    expect(p.names).toEqual(['Ana', 'Ben', 'Dee Ann']);
    expect(JSON.stringify(p)).not.toMatch(/Cruz|@example/);
    const many = Array.from({length: 9}, (_, i) => row({firstName: `P${i}`}));
    expect(cohortPreview(many, circuit).names).toEqual(['P0', 'P1', 'P2', 'P3', 'P4']);
  });

  it('nobody matches: zero customers, no rate (null, never 0%)', () => {
    expect(cohortPreview(rows, rule({f: 'code', op: 'is', v: 'NOPE'}))).toEqual({customers: 0, buyers: 0, repeat: 0, ratePct: null, names: []});
  });
});

describe('9B ruleUsesContact', () => {
  it('true only when a condition reads last contacted or times contacted', () => {
    expect(ruleUsesContact(rule({f: 'code', op: 'is', v: 'X'}))).toBe(false);
    expect(ruleUsesContact(rule({f: 'code', op: 'is', v: 'X'}, {f: 'lcdays', op: 'gte', v: 30}))).toBe(true);
    expect(ruleUsesContact(rule({f: 'times', op: 'eq', v: 0}))).toBe(true);
  });
});

describe('9B cohortSuggestions: first-order codes with buyers that no saved cohort covers', () => {
  const rows = [
    row({firstOrderCode: 'CIRCUIT10'}),
    row({firstOrderCode: 'CIRCUIT10', orderCount: 2}),
    row({firstOrderCode: 'PETEXPO'}),
    row({firstOrderCode: 'PETEXPO'}),
    row({firstOrderCode: 'PETEXPO'}),
    row({firstOrderCode: NO_CODE}),
    row({firstOrderCode: BIRTHDAY_COHORT}),
    row({firstOrderCode: null, orderCount: 0, firstOrderAt: null}),
  ];

  it('biggest first; "no code" and non-buyers are never suggested; each comes with a ready draft (group Promo, name = the code)', () => {
    const s = cohortSuggestions(rows, []);
    expect(s.map((x) => [x.code, x.buyers])).toEqual([
      ['PETEXPO', 3],
      ['CIRCUIT10', 2],
      [BIRTHDAY_COHORT, 1],
    ]);
    expect(s[0].draft).toEqual({group: 'Promo', name: 'PETEXPO', rule: {all: [{f: 'code', op: 'is', v: 'PETEXPO'}]}});
    expect(s[2].draft.name).toBe('Birthday voucher');
  });

  it('each draft matches exactly the buyers it advertises (one evaluator)', () => {
    for (const x of cohortSuggestions(rows, [])) {
      const members = rows.filter((r) => matchesCohort(r, x.draft.rule));
      expect(repeatRate(members.map((r) => r.orderCount)).buyers, x.code).toBe(x.buyers);
    }
  });

  it('a code a saved cohort already uses ("is", any case, among other conditions) is covered; "is not" does not cover it', () => {
    const s = cohortSuggestions(rows, [
      saved('Event', 'Circuit Makati', rule({f: 'code', op: 'is', v: 'circuit10'}, {f: 'orders', op: 'eq', v: 1})),
      saved('Promo', 'Not expo', rule({f: 'code', op: 'is_not', v: 'PETEXPO'})),
    ]);
    expect(s.map((x) => x.code)).toEqual(['PETEXPO', BIRTHDAY_COHORT]);
  });
});

describe('9B findCohort: the owner names a saved cohort in plain words', () => {
  const list = [saved('Event', 'Circuit Makati', rule({f: 'code', op: 'is', v: 'CIRCUIT10'})), saved('Promo', 'Pet Expo', rule({f: 'code', op: 'is', v: 'PETEXPO'}))];
  it.each(['Event · Circuit Makati', 'event · circuit makati', 'Event: Circuit Makati', 'event:circuit-makati', '  EVENT  circuit   makati '])('%s finds it', (q) => {
    expect(findCohort(list, q)?.id).toBe('Event-Circuit Makati');
  });
  it('the name alone finds it only when exactly one cohort has that name', () => {
    expect(findCohort(list, 'Circuit Makati')?.id).toBe('Event-Circuit Makati');
    expect(findCohort([...list, saved('Promo', 'Circuit Makati', rule({f: 'orders', op: 'gte', v: 1}))], 'Circuit Makati')).toBeNull();
  });
  it('unknown: null', () => {
    expect(findCohort(list, 'Event · Pet Expo')).toBeNull();
    expect(findCohort(list, '')).toBeNull();
  });
});
