// RET-10 Stage 9B (plan knowledge/tasks/2026-11-12-customer-cohorts-stage9.md, pattern knowledge/best-practices/chat-proposed-writes.md):
// Ask Coop drafts, suggests and reads saved cohorts. Every expected figure below is counted by hand from the fixture first. Rules under test:
// an invalid draft is refused (in plain words); the preview equals the Website CRM page's evaluator; a duplicate label is refused; the
// tool has no write path (the model cannot save without a person's click); list_crm_customers reads a saved cohort, a cohort group
// (only 5+ buyers ranked) and "not contacted in N days"; an unknown cohort is refused with the valid labels; field codes never show.
import {describe, expect, it, vi} from 'vitest';
import {createCrmExecutors} from '../src/chat/crm/executors';
import {readCustomersInput} from '../src/chat/crm/tools';
import type {ChatBlock, CohortDraftBlock} from '../src/chat/block-types';
import {runChatLoop, type ChatLoopOptions} from '../src/chat/loop';
import {chatTools} from '../src/chat/tool-defs';
import {createExecutors} from '../src/chat/tool-executors';
import type {ChatStreamEvent} from '../src/chat/stream-types';
import type {MetricResult} from '../src/chat/result-types';
import {COHORT_FIELDS, contactTally, customerRows, enrichCustomers, matchesCohort, membershipWindowStart, repeatRate, type CohortRule} from '../src/crm-compute';
import {projectCustomer, projectOrder} from '../src/crm-project';
import {createCohortWith, type CohortDeps, type CustomerCohort} from '../src/customer-cohorts';
import {fakeCrmClient} from './support/crm-fixtures';
import {FakeModel, sink, toolTurn, toolUse} from './support/fake-model';

const NOW = new Date('2026-11-20T04:00:00Z');
const ago = (d: number): string => new Date(NOW.getTime() - d * 86_400_000).toISOString();
const MEMBERSHIP = {platinumThreshold: 2000, programStart: '2026-07-01'};

// Eight customers. CIRCUIT10 first orders: Ana (1), Ben (2), Cy (1, contacted 10 days ago), Dee (1), Eve (1), Fay (2) = 6 buyers, 2 repeat.
// PETEXPO: Gus (1). Hal never ordered. Never contacted: everyone but Cy (no CRM email went out: checkouts, vouchers, membership all empty).
const PEOPLE: [string, string, string | null, number][] = [
  ['c1', 'Ana', 'CIRCUIT10', 1],
  ['c2', 'Ben', 'CIRCUIT10', 2],
  ['c3', 'Cy', 'CIRCUIT10', 1],
  ['c4', 'Dee', 'CIRCUIT10', 1],
  ['c5', 'Eve', 'CIRCUIT10', 1],
  ['c6', 'Fay', 'CIRCUIT10', 2],
  ['c7', 'Gus', 'PETEXPO', 1],
  ['c8', 'Hal', null, 0],
];
const CUSTOMERS = PEOPLE.map(([id, first]) => ({shopifyCustomerId: id, email: `${first.toLowerCase()}@example.com`, firstName: first, lastName: 'Surname', phone: null, membershipTier: 'gold', petName: null, petBirthday: null, emailMarketingState: 'subscribed', createdAt: ago(300), updatedAt: null}));
const ORDERS = PEOPLE.flatMap(([id, first, code, n]) =>
  Array.from({length: n}, (_, j) => ({shopifyOrderId: `${id}-${j}`, orderNumber: `#${id}${j}`, shopifyCustomerId: id, email: `${first.toLowerCase()}@example.com`, totalPrice: '500', currency: 'PHP', financialStatus: 'paid', fulfillmentStatus: null, createdAt: ago(60 - j * 20), lineItems: null, raw: JSON.stringify({test: false, discount_codes: j === 0 && code ? [{code}] : []})})),
);
const BODIES = {customers: {customers: CUSTOMERS}, orders: {orders: ORDERS}, checkouts: {checkouts: []}, birthdayVouchers: {birthdayVouchers: []}, membershipEvents: {membershipEvents: []}, membership: MEMBERSHIP};
const MANUAL = [{email: 'cy@example.com', channel: 'instagram', contactedAt: ago(10)}];

const cohort = (group: string, name: string, rule: CohortRule, id = `id-${name}`): CustomerCohort => ({id, group, name, rule, createdBy: 'owner@zoomy.ph', createdAt: '', updatedAt: ''});
const CIRCUIT = cohort('Event', 'Circuit Makati', {all: [{f: 'code', op: 'is', v: 'CIRCUIT10'}]});
const EXPO = cohort('Event', 'Pet Expo', {all: [{f: 'code', op: 'is', v: 'PETEXPO'}]});
const SAVED = [CIRCUIT, EXPO];

/** The Website CRM page's own rows (crm-view.tsx): enrichCustomers + contactTally + customerRows over the same CRM lists. */
function pageRows() {
  const customers = CUSTOMERS.map(projectCustomer);
  const orders = ORDERS.map(projectOrder);
  const enriched = enrichCustomers(customers, orders, membershipWindowStart(NOW, MEMBERSHIP.programStart));
  const tally = contactTally({checkouts: [], orders, birthdayVouchers: [], membershipEvents: [], manualContacts: MANUAL});
  return customerRows(enriched, tally, NOW, {automated: true, manual: true});
}

function exec(o: {saved?: readonly CustomerCohort[] | null; noEmit?: boolean} = {}) {
  const blocks: ChatBlock[] = [];
  const kept: MetricResult[] = [];
  const f = fakeCrmClient(BODIES);
  const read = vi.fn(async () => (o.saved === undefined ? SAVED : o.saved));
  const ex = createCrmExecutors({
    client: f.client, now: NOW, user: 'owner@zoomy.ph', sink: sink(),
    keep: (r) => {
      kept.push(r);
      return r;
    },
    emitBlock: o.noEmit ? undefined : (b) => blocks.push(b),
    manualContacts: async () => MANUAL,
    cohorts: o.saved === undefined || o.saved !== null ? read : async () => null,
  });
  return {ex, blocks, kept, gets: f.gets, read};
}
const drafts = (b: ChatBlock[]) => b.filter((x): x is CohortDraftBlock => x.kind === 'cohort_draft');
const NOT_REORDERED = {group: 'Event', name: "Circuit Makati, haven't reordered", rule: {all: [{f: 'code', op: 'is', v: 'circuit10'}, {f: 'orders', op: 'eq', v: '1'}]}};

describe('9B propose_crm_cohort: drafts', () => {
  it('the owner example: validated, counted by code, drawn as a draft with plain sentences; the model is told it is NOT saved', async () => {
    const {ex, blocks} = exec();
    const out = (await ex.propose_crm_cohort(NOT_REORDERED)) as Record<string, unknown>;
    // by hand: Ana, Cy, Dee, Eve (CIRCUIT10, exactly 1 order) = 4 customers, 4 buyers, 0 repeat, 0.0%
    expect(out).toMatchObject({draft: 'not saved', label: "Event · Circuit Makati, haven't reordered", rule: 'First order used code CIRCUIT10, and has exactly 1 order', customers: 4, buyers: 4, repeat_buyers: 0, repeat_rate_pct: 0, shown: true, block: 'cd1'});
    expect(String(out.say)).toMatch(/NOT saved[\s\S]*Never say it was saved/);
    const [b] = drafts(blocks);
    expect(b).toMatchObject({kind: 'cohort_draft', id: 'cd1', title: "Event · Circuit Makati, haven't reordered", reliable: true, sentences: ['First order used code CIRCUIT10', 'Has exactly 1 order']});
    expect(b.draft.rule).toEqual({all: [{f: 'code', op: 'is', v: 'CIRCUIT10'}, {f: 'orders', op: 'eq', v: 1}]}); // normalised by the builder's validator
    expect(b.preview).toEqual({customers: 4, buyers: 4, repeat: 0, ratePct: 0, names: ['Ana', 'Cy', 'Dee', 'Eve']});
  });

  it('the preview equals the Website CRM page evaluator for the same rule (count and repeat rate), contact conditions included', async () => {
    const rules: CohortRule[] = [
      {all: [{f: 'code', op: 'is', v: 'CIRCUIT10'}]},
      {all: [{f: 'code', op: 'is', v: 'CIRCUIT10'}, {f: 'lcdays', op: 'gte', v: 30}]},
      {all: [{f: 'times', op: 'gte', v: 1}]},
      {all: [{f: 'orders', op: 'eq', v: 0}]},
    ];
    const rows = pageRows();
    for (const [i, rule] of rules.entries()) {
      const {ex, blocks} = exec();
      await ex.propose_crm_cohort({group: 'Test', name: `Rule ${i}`, rule});
      const members = rows.filter((r) => matchesCohort(r, rule));
      const {buyers, repeat, ratePct} = repeatRate(members.map((r) => r.orderCount));
      expect(drafts(blocks)[0].preview, `rule ${i}`).toMatchObject({customers: members.length, buyers, repeat, ratePct});
    }
    // and by hand for the contact one: CIRCUIT10 not contacted in 30 days = everyone but Cy = 5
    const {ex, blocks} = exec();
    await ex.propose_crm_cohort({group: 'Test', name: 'Quiet', rule: rules[1]});
    expect(drafts(blocks)[0].preview.customers).toBe(5);
  });

  it('first names only in the block; nothing personal goes back to the model', async () => {
    const {ex, blocks} = exec();
    const out = await ex.propose_crm_cohort(NOT_REORDERED);
    expect(JSON.stringify(out)).not.toMatch(/Ana|Surname|@example/);
    expect(JSON.stringify(blocks)).not.toMatch(/Surname|@example/);
  });

  it('an invalid draft is refused in plain words: no CRM read, no block', async () => {
    const cases: [unknown, RegExp][] = [
      [{group: 'Event', name: 'X', rule: {all: [{f: 'pet_name', op: 'is', v: 'Mochi'}]}}, /field Coop does not know\. Use one of: First-order code, First order date, Orders/],
      [{group: 'Event', name: 'X', rule: {all: [{f: 'orders', op: 'is', v: '1'}]}}, /Orders takes the operator "at least" or "at most" or "exactly"/],
      [{group: 'Event', name: 'X', rule: {all: []}}, /at least one condition/],
      [{group: '', name: 'X', rule: {all: [{f: 'orders', op: 'eq', v: 1}]}}, /Give the cohort a group/],
      [{group: 'Event', name: 'X', rule: {all: [{f: 'orders', op: 'eq', v: 1}]}, created_by: 'evil@x'}, /Use only these parameters/],
      [{suggest: true, group: 'Event'}, /suggest true takes no other parameter/],
      [null, /Pass \{group, name, rule/],
    ];
    for (const [input, err] of cases) {
      const {ex, blocks, gets} = exec();
      const out = (await ex.propose_crm_cohort(input)) as {error?: string};
      expect(out.error, JSON.stringify(input)).toMatch(err);
      expect(blocks).toEqual([]);
      expect(gets).toEqual([]);
    }
  });

  it('the unknown-field error names the fields in plain words, never their codes', async () => {
    const {ex} = exec();
    const out = (await ex.propose_crm_cohort({group: 'E', name: 'X', rule: {all: [{f: 'nope', op: 'is', v: 'x'}]}})) as {error: string};
    for (const code of COHORT_FIELDS.filter((f) => f.length > 4)) expect(out.error).not.toContain(` ${code},`);
    expect(out.error).toMatch(/Days since last contacted, Times contacted, Email consent/);
  });

  it('a duplicate label (any case) is refused with the saved rule; nothing drawn', async () => {
    const {ex, blocks} = exec();
    const out = (await ex.propose_crm_cohort({group: 'event', name: 'CIRCUIT MAKATI', rule: {all: [{f: 'orders', op: 'gte', v: 1}]}})) as {error: string};
    expect(out.error).toMatch(/A cohort named event · CIRCUIT MAKATI already exists \(First order used code CIRCUIT10\)\. Nothing was drafted/);
    expect(blocks).toEqual([]);
  });

  it('cohorts not set up (table not applied): says so, draws no Save button, reads no CRM', async () => {
    const {ex, blocks, gets} = exec({saved: null});
    const out = (await ex.propose_crm_cohort(NOT_REORDERED)) as {error: string};
    expect(out.error).toMatch(/not set up[\s\S]*no cohort can be saved here yet/);
    expect(blocks).toEqual([]);
    expect(gets).toEqual([]);
  });

  it('no block channel: the model is told the draft could not be shown (so it cannot be saved)', async () => {
    const {ex} = exec({noEmit: true});
    const out = (await ex.propose_crm_cohort(NOT_REORDERED)) as Record<string, unknown>;
    expect(out).toMatchObject({shown: false});
    expect(String(out.note)).toMatch(/cannot be saved from this chat/);
  });
});

describe('9B propose_crm_cohort: suggestions ("what cohorts should we track?")', () => {
  it('only codes no saved cohort covers, biggest first, drawn as one-click drafts', async () => {
    const {ex, blocks} = exec({saved: [EXPO]});
    const out = (await ex.propose_crm_cohort({suggest: true})) as {suggestions: Record<string, unknown>[]; shown: number};
    expect(out.suggestions).toEqual([{label: 'Promo · CIRCUIT10', rule: 'First order used code CIRCUIT10', buyers: 6, repeat_buyers: 2, repeat_rate_pct: 33.3, small_group: false, block: 'cd1'}]);
    expect(drafts(blocks).map((b) => [b.title, b.preview.customers])).toEqual([['Promo · CIRCUIT10', 6]]);
  });

  it('every code covered: says so, nothing drawn', async () => {
    const {ex, blocks} = exec();
    const out = (await ex.propose_crm_cohort({suggest: true})) as {suggestions: unknown[]; say: string};
    expect(out.suggestions).toEqual([]);
    expect(out.say).toMatch(/already covered/);
    expect(blocks).toEqual([]);
  });
});

describe('9B the model cannot save without a click (no write path)', () => {
  it('an obedient model drafts, then "saves": the save tool does not exist, nothing is written, and the turn shows only the draft', async () => {
    const insert = vi.fn();
    const db = {read: vi.fn(async () => SAVED), insert}; // the executors are only ever handed db.read
    const blocks: ChatBlock[] = [];
    const executors = createExecutors({data: async () => ({source: 'live', orders: [], events: [], prices: [], priceChanges: [], bulkReads: []}), now: NOW, user: 'owner@zoomy.ph', crm: fakeCrmClient(BODIES).client, manualContacts: async () => MANUAL, cohorts: db.read, emitBlock: (b) => blocks.push(b)} as Parameters<typeof createExecutors>[0]);
    const model = new FakeModel((n) =>
      n === 1 ? toolTurn('', toolUse('t1', 'propose_crm_cohort', NOT_REORDERED))
      : n === 2 ? toolTurn('', toolUse('t2', 'save_cohort', NOT_REORDERED), toolUse('t3', 'create_cohort', NOT_REORDERED))
      : {text: ['Here is the draft.']},
    );
    const events: ChatStreamEvent[] = [];
    const s = sink();
    const opts: ChatLoopOptions = {
      client: model, model: 'claude-sonnet-5-5', maxTokens: 4096, effort: 'medium',
      system: [{type: 'text', text: 'STATIC', cache_control: {type: 'ephemeral'}}, {type: 'text', text: 'LIVE', cache_control: {type: 'ephemeral'}}],
      tools: chatTools({explore: false, crm: true}),
      messages: [{role: 'user', content: "Make a cohort: Circuit Makati buyers who haven't reordered"}],
      preamble: '[context] Today.', executors, emit: (e) => events.push(e), user: 'owner@zoomy.ph', sink: s,
    };
    await runChatLoop(opts);
    expect(chatTools({explore: true, crm: true, contacts: true, sku: true}).map((t) => t.name).filter((n) => /save|create|delete|update|cohort/.test(n))).toEqual(['propose_crm_cohort']);
    expect(insert).not.toHaveBeenCalled();
    expect(drafts(blocks)).toHaveLength(1);
    // the save attempts came back to the model as refused tool calls
    expect(model.requests[2]).toMatch(/save_cohort/);
    expect(s.error.mock.calls.map((c) => JSON.parse(c[0] as string)).filter((l) => l.event === 'chat_guard_trip').length).toBeGreaterThanOrEqual(1);
  });

  it('Save itself is the 9A action: created_by is the viewer, never the payload, origin ask_coop in the audit line', async () => {
    const rows: unknown[] = [];
    const deps: CohortDeps = {
      actor: async () => 'viewer@zoomy.ph',
      insert: async (row) => {
        rows.push(row);
        return {error: null, id: 'new-id'};
      },
      findByLabel: async () => null,
      updateOwn: async () => ({error: null, updated: 0}),
      deleteOwn: async () => ({error: null, deleted: 0}),
    };
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const {ex, blocks} = exec();
    await ex.propose_crm_cohort(NOT_REORDERED);
    const draft = drafts(blocks)[0].draft;
    const res = await createCohortWith(deps, {...draft, created_by: 'model@evil.example'}, 'ask_coop');
    expect(res).toEqual({ok: true, id: 'new-id'});
    expect(rows).toEqual([{group_name: 'Event', name: "Circuit Makati, haven't reordered", rule: draft.rule, created_by: 'viewer@zoomy.ph'}]);
    expect(JSON.parse(String(info.mock.calls.at(-1)?.[0]))).toEqual({event: 'cohort_saved', id: 'new-id', by: 'viewer@zoomy.ph', origin: 'ask_coop'});
    info.mockRestore();
  });
});

describe('9B list_crm_customers reads saved cohorts', () => {
  const CUS = {joined_from: '', joined_to: '', tier: 'all', buyers: 'all', group_by: 'none', sort: 'newest', min_orders: 0, audience: 'all', limit: 25, offset: 0};

  it('defaults keep the old behaviour; the new inputs are closed', () => {
    expect(readCustomersInput(CUS)).toMatchObject({cohort: '', cohort_group: '', not_contacted_days: 0});
    expect(readCustomersInput({...CUS, not_contacted_days: 45})).toEqual({error: 'not_contacted_days must be one of: 0, 7, 14, 30, 60, 90, 180.'});
    expect(readCustomersInput({...CUS, group_by: 'cohort_group'})).toMatchObject({error: expect.stringMatching(/go together/)});
    expect(readCustomersInput({...CUS, cohort_group: 'Event'})).toMatchObject({error: expect.stringMatching(/go together/)});
  });

  it('cohort filters with the page evaluator; with not_contacted_days 30 = "who from Circuit Makati haven\'t we contacted in 30 days"', async () => {
    const {ex, kept} = exec();
    await ex.list_crm_customers({...CUS, cohort: 'event:circuit-makati'});
    expect(kept[0].rows.map((r) => String(r.name).split(' ')[0]).sort()).toEqual(['Ana', 'Ben', 'Cy', 'Dee', 'Eve', 'Fay']);
    expect(kept[0].meta.checks.map((c) => c.text).join('\n')).toMatch(/in the saved cohort Event · Circuit Makati \(First order used code CIRCUIT10\)/);
    await ex.list_crm_customers({...CUS, cohort: 'Event · Circuit Makati', not_contacted_days: 30});
    expect(kept[1].rows.map((r) => String(r.name).split(' ')[0]).sort()).toEqual(['Ana', 'Ben', 'Dee', 'Eve', 'Fay']); // Cy was contacted 10 days ago
    expect(kept[1].meta.checks.map((c) => c.text).join('\n')).toMatch(/last contacted 30\+ days ago or never/);
  });

  it('an unknown cohort is refused with the valid labels, before any CRM read', async () => {
    const {ex, gets} = exec();
    const out = (await ex.list_crm_customers({...CUS, cohort: 'Event · Pet Fair'})) as {error: string};
    expect(out.error).toBe('No saved cohort is called "Event · Pet Fair". Saved cohorts: Event · Circuit Makati, Event · Pet Expo. Use one of these names exactly, or offer to draft it with propose_crm_cohort.');
    expect(gets).toEqual([]);
    const g = (await exec().ex.list_crm_customers({...CUS, group_by: 'cohort_group', cohort_group: 'Promo'})) as {error: string};
    expect(g.error).toMatch(/No saved cohort is in the group "Promo"\. Groups: Event\./);
    const none = (await exec({saved: null}).ex.list_crm_customers({...CUS, cohort: 'Event · Circuit Makati'})) as {error: string};
    expect(none.error).toMatch(/not set up/);
  });

  it('"repeat rate by event": every Event cohort with the page\'s counts; only 5+ buyers ranked, small ones flagged and kept out of the chart', async () => {
    const {ex, kept} = exec();
    await ex.list_crm_customers({...CUS, group_by: 'cohort_group', cohort_group: 'events'});
    const r = kept[0];
    // by hand: Circuit Makati 6 buyers, 2 repeat = 33.3%; Pet Expo 1 buyer, 0 repeat = 0.0% (small)
    expect(r.rows).toEqual([
      {group: 'Circuit Makati', rule: 'First order used code CIRCUIT10', customers: 6, buyers: 6, repeat: 2, rate_pct: 33.3},
      {group: 'Pet Expo', rule: 'First order used code PETEXPO', customers: 1, buyers: 1, repeat: 0, rate_pct: 0},
    ]);
    expect(r.columns[0].label).toBe('Event');
    expect(r.meta.chart_view).toMatchObject({key: 'group', omit: ['Pet Expo']});
    expect(r.meta.headline).toMatch(/Best repeat rate among cohorts of 5\+ buyers: Circuit Makati 2 of 6 \(33\.3%\)\. Target 25%[\s\S]*1 smaller cohort is too small for a rate/);
    expect(JSON.stringify(r.rows)).not.toMatch(/event:|lcdays|"f":|"op":/);
  });
});

describe('9B the drawer keeps a cohort draft block across a reload, and drops a malformed one', () => {
  it('sanitizeBlocks', async () => {
    const {sanitizeBlocks} = await import('../components/analyst/chat-blocks-format');
    const good = {kind: 'cohort_draft', id: 'cd1', source: 'propose_crm_cohort', title: 'Event · Circuit Makati', reliable: true, caveats: [], basis: null, draft: {group: 'Event', name: 'Circuit Makati', rule: {all: [{f: 'code', op: 'is', v: 'CIRCUIT10'}]}}, sentences: ['First order used code CIRCUIT10'], preview: {customers: 6, buyers: 6, repeat: 2, ratePct: 33.3, names: ['Ana']}};
    expect(sanitizeBlocks([{at: 0, block: good}])).toHaveLength(1);
    expect(sanitizeBlocks([{at: 0, block: {...good, preview: {...good.preview, names: [{x: 1}]}}}, {at: 0, block: {...good, id: 'cd2', draft: 'save me'}}])).toEqual([]);
  });
});
