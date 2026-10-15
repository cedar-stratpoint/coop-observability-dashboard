import {afterEach, describe, expect, it, vi} from 'vitest';
import type {ComputeContext, ComputeOutput} from '../src/chat/metrics-registry';

const tamper = vi.hoisted(() => ({on: false}));
// Passthrough of the real registry, except that offline_revenue can be told to report parts that do not add up (BI-02).
vi.mock('../src/chat/metrics-registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/chat/metrics-registry')>();
  const real = actual.METRICS.offline_revenue;
  const compute = (ctx: ComputeContext): ComputeOutput => {
    const out = real.compute(ctx);
    return tamper.on ? {...out, reconcile: [{label: 'Revenue by day', parts: [1, 2], whole: 10}]} : out;
  };
  return {...actual, METRICS: {...actual.METRICS, offline_revenue: {...real, compute}}};
});

import {runMetric} from '../src/chat/query-metric';
import {METRICS, METRIC_IDS, sharesOf} from '../src/chat/metrics-registry';
import {isStockMetric} from '../src/chat/stock-metrics';
import {resolveRange} from '../src/chat/range';
import {ROUND_ROW_PAGE, SMALL_SAMPLE_N, UNTAGGED_WARN_SHARE, runChecks} from '../src/chat/checks';
import {createExecutors} from '../src/chat/tool-executors';
import type {ChecksInput, MetricData, MetricRequest, MetricResult} from '../src/chat/result-types';
import type {PetType, PosOrder, PosOrderLine} from '../src/pos-sales-types';
import {buildBundleFixture} from './support/bundle-fixture';
import {EVAL_NOW, SKILL_CASES, injectChecks, line, mkOrder, onlyLastWeekData, RECONCILE_FAIL, ROUND_ROWS, smallSampleData, standardData} from './support/skill-eval-fixtures';
import {CASE_IDS, barePercents, scoreCase, type CaseId, type RecordedCall} from './support/skill-eval-score';

// Synthetic data only. One real-behaviour test per rule the skill marks as enforced by code (titles start with the rule id).

const NOW = EVAL_NOW;
const BASE: MetricRequest = {
  metric: 'offline_revenue', dimension: 'none', measure: 'default', range: 'all_available', from: '', to: '',
  channel: 'offline', event: 'all', pet: 'all', compare_to: 'none', sort: 'default', limit: 25,
};
const req = (over: Partial<MetricRequest>): MetricRequest => ({...BASE, ...over});
const data = (orders: PosOrder[], over: Partial<MetricData> = {}): MetricData => ({source: 'live', orders, events: [], prices: [], priceChanges: [], bulkReads: [], ...over});
function run(over: Partial<MetricRequest>, d: MetricData): MetricResult {
  const r = runMetric(req(over), d, NOW);
  if ('error' in r) throw new Error(`expected a result, got: ${r.error}`);
  return r;
}
const check = (r: MetricResult, code: string) => r.meta.checks.find((c) => c.code === code);
const sum = (r: MetricResult, key: string): number => r.rows.reduce((s, x) => s + Number(x[key] ?? 0), 0);
const cents = (n: number): number => Math.round(n * 100);

const fx = buildBundleFixture();
const bundleData = (over: Partial<MetricData> = {}): MetricData => ({...standardData(), orders: fx.orders, ...over});
const day = (d: number): string => `2026-09-${String(d).padStart(2, '0')}T10:00:00+08:00`;
const one = (id: string, d: number, total: number, pet: PetType | null = null): PosOrder => mkOrder(id, day(d), [line('p', 'Item', 1, total)], {pet});
const many = (n: number, d: number, pet: (i: number) => PetType | null = () => null): PosOrder[] => Array.from({length: n}, (_, i) => one(`m${d}-${i}`, d, 100, pet(i)));
const input = (over: Partial<ChecksInput> = {}): ChecksInput => ({
  mockSource: false, bulkReads: [], reconcile: [], zeroValueLines: null, priceChanges: null, sampleSize: null, untagged: null,
  coverage: {from: '2026-09-01', to: '2026-09-10', dataFrom: '2026-09-01', dataTo: '2026-09-30'}, change: null, ...over,
});

afterEach(() => {
  tamper.on = false;
});

describe('skill rules enforced by code', () => {
  it('BI-01: one definition per metric, each with a declared measure and a method, and the same request gives the same result', () => {
    expect(new Set(METRIC_IDS).size).toBe(METRIC_IDS.length);
    expect(Object.keys(METRICS).sort()).toEqual([...METRIC_IDS].sort());
    for (const id of METRIC_IDS) {
      const def = METRICS[id];
      expect(def.id).toBe(id);
      expect(def.measures.length).toBeGreaterThan(0);
      for (const m of def.measures) expect(m.method.trim(), `${id}.${m.key}`).not.toBe('');
      expect(new Set(def.measures.map((m) => m.key)).size).toBe(def.measures.length);
      expect(def.measures.map((m) => m.key)).toContain(def.defaultMeasure);
    }
    const d = bundleData();
    expect(runMetric(req({metric: 'bundle_sales'}), d, NOW)).toEqual(runMetric(req({metric: 'bundle_sales'}), d, NOW));
  });

  it('BI-02: parts that do not add up fail the reconciles check and make the result unreliable; matching parts are ok', () => {
    expect(runChecks(input({reconcile: [{label: 'Pet totals', parts: [100, 200], whole: 350}]})).find((c) => c.code === 'reconciles')?.status).toBe('fail');
    expect(runChecks(input({reconcile: [{label: 'Pet totals', parts: [100, 250], whole: 350}]})).find((c) => c.code === 'reconciles')?.status).toBe('ok');
    const orders = [one('a', 12, 100), one('b', 13, 250)];
    const good = run({metric: 'offline_revenue', dimension: 'day'}, data(orders));
    expect(check(good, 'reconciles')?.status).toBe('ok');
    expect(good.meta.reliable).toBe(true);
    tamper.on = true;
    const bad = run({metric: 'offline_revenue', dimension: 'day'}, data(orders));
    expect(check(bad, 'reconciles')?.status).toBe('fail');
    expect(bad.meta.reliable).toBe(false);
  });

  it('BI-03: voided orders never count and a bundle header is never added to its zero-peso pick lines', () => {
    expect(fx.expected.voidedCount).toBeGreaterThan(0);
    const completed = fx.orders.filter((o) => o.status !== 'voided');
    const total = run({metric: 'offline_revenue'}, bundleData());
    expect(cents(Number(total.rows[0].revenue))).toBe(cents(completed.reduce((s, o) => s + o.total, 0)));
    const bundles = run({metric: 'bundle_sales'}, bundleData());
    expect(bundles.rows[0].bundle_orders).toBe(fx.expected.bundleOrders);
    expect(cents(Number(bundles.rows[0].bundle_revenue))).toBe(fx.expected.bundleRevenueC);
    // revenue = paid prices of headed bundles + legacy headerless sales: pick lines add nothing
    const picks = completed.flatMap((o) => o.items).filter((l: PosOrderLine) => l.bundle_group && l.product_id);
    expect(picks.length).toBeGreaterThan(0);
    expect(picks.reduce((s, l) => s + l.line_total, 0)).toBe(0);
    const itemized = run({metric: 'top_products'}, bundleData());
    expect(cents(sum(itemized, 'revenue') + Number(bundles.rows[0].bundle_revenue))).toBe(cents(Number(total.rows[0].revenue)));
  });

  it('BI-04: a bulk read of exactly 1,000 rows (or a round multiple) raises round_row_count; 999 does not', () => {
    const orders = [one('a', 12, 100)];
    const at = (rows: number) => check(run({metric: 'offline_revenue'}, data(orders, {bulkReads: [{relation: 'coop_chat_orders', rows}]})), 'round_row_count');
    expect(ROUND_ROW_PAGE).toBe(1000);
    expect(at(1000)?.status).toBe('info');
    expect(at(2000)?.status).toBe('info');
    expect(at(999)).toBeUndefined();
    expect(at(1001)).toBeUndefined();
  });

  it('BI-06: the untagged bucket is its own row and is never spread across the tagged shares', () => {
    expect(fx.expected.byPetC.untagged).toBeGreaterThan(0);
    const r = run({metric: 'bundle_sales', dimension: 'pet_type'}, bundleData());
    const row = (p: string) => r.rows.find((x) => x.pet === p);
    expect(row('untagged')?.value).toBe(fx.expected.byPetC.untagged / 100);
    expect(row('untagged')?.share_of_tagged).toBeNull();
    const c = fx.expected.byPetC;
    const tagged = c.dog + c.cat + c.both;
    expect(Math.abs(Number(row('dog')?.share_of_tagged) - (c.dog / tagged) * 100)).toBeLessThan(0.1);
    expect(Math.abs(Number(row('dog')?.share_of_tagged) - (c.dog / (tagged + c.untagged)) * 100)).toBeGreaterThan(0.5);
    expect(r.meta.insights.map((i) => i.code)).toContain('untagged_share');
  });

  it('BI-07: shares come from unrounded values, so they still add to 100.0 where rounded parts would not', () => {
    const naive = Array.from({length: 6}, () => Math.round(1000 / 6) / 10);
    expect(naive.reduce((s, v) => s + v, 0)).toBeGreaterThan(100.1); // rounded parts would show 100.2
    const shares = sharesOf([100, 100, 100, 100, 100, 100]) as number[];
    expect(Math.abs(shares.reduce((s, v) => s + v, 0) - 100)).toBeLessThanOrEqual(0.1 + 1e-9);
    const orders = ['q1', 'q2', 'q3', 'q4', 'q5', 'q6'].map((id, i) => mkOrder(`o${i}`, day(12), [line(id, `P ${id}`, 1, 100)]));
    const r = run({metric: 'top_products'}, data(orders));
    expect(Math.abs(sum(r, 'share') - 100)).toBeLessThanOrEqual(0.1 + 1e-9);
    expect(check(r, 'reconciles')?.status).toBe('ok');
  });

  it('BI-08: a cut result says how many rows are shown of how many, and that shares are of all rows', () => {
    const r = run({metric: 'bundle_picks', dimension: 'sku', limit: 3}, bundleData());
    expect(r.rows).toHaveLength(3);
    expect(r.meta.caveats.join(' ')).toMatch(/Showing the first 3 of 10 rows; shares are of all 10/);
    expect(sum(r, 'share')).toBeLessThan(100);
  });

  it('BI-10: compare_to previous_period uses the period of equal length ending the day before the current one', () => {
    const bounds = {dataFrom: '2026-09-01', dataTo: '2026-09-30'};
    const span = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 86_400_000 + 1;
    for (const [range, from, to] of [['custom', '2026-09-17', '2026-09-27'], ['last_week', '', ''], ['last_month', '', '']] as const) {
      const r = resolveRange({range, from, to}, NOW, bounds);
      if (!r.ok) throw new Error(r.error);
      expect(span(r.previous.from, r.previous.to)).toBe(span(r.from, r.to));
      expect(Date.parse(r.previous.to) + 86_400_000).toBe(Date.parse(r.from));
    }
    // and the executor sums exactly that window: Sep 6 to 16 for the current Sep 17 to 27
    const orders = [one('out', 5, 999), one('p1', 6, 100), one('p2', 16, 50), one('c1', 17, 70), one('c2', 27, 30)];
    const r = run({metric: 'offline_revenue', range: 'custom', from: '2026-09-17', to: '2026-09-27', compare_to: 'previous_period'}, data(orders));
    expect(r.rows[0]).toMatchObject({revenue: 100, previous_revenue: 150, delta: -50});
  });

  it('BI-11: an empty earlier period gives null previous, change and percent change, never 0', () => {
    const orders = [one('c1', 20, 70), one('c2', 22, 30)];
    const total = run({metric: 'offline_revenue', range: 'custom', from: '2026-09-20', to: '2026-09-26', compare_to: 'previous_period'}, data(orders));
    expect(total.rows[0]).toMatchObject({revenue: 100, previous_revenue: null, delta: null, delta_pct: null});
    expect(total.meta.caveats.join(' ')).toMatch(/\(null\), not zero/);
    const byProduct = run({metric: 'top_products', range: 'custom', from: '2026-09-20', to: '2026-09-26', compare_to: 'previous_period'}, data(orders));
    for (const row of byProduct.rows) expect([row.previous_revenue, row.delta, row.delta_pct]).toEqual([null, null, null]);
  });

  it('BI-13: fewer than SMALL_SAMPLE_N orders raises the small_sample warning and exactly SMALL_SAMPLE_N does not', () => {
    const at = (n: number) => check(run({metric: 'offline_revenue'}, data(many(n, 12))), 'small_sample');
    expect(at(SMALL_SAMPLE_N - 1)).toMatchObject({status: 'warn', values: {sampleSize: SMALL_SAMPLE_N - 1}});
    expect(at(SMALL_SAMPLE_N)).toBeUndefined();
    expect(runChecks(input({sampleSize: SMALL_SAMPLE_N - 1})).some((c) => c.code === 'small_sample')).toBe(true);
    expect(runChecks(input({sampleSize: SMALL_SAMPLE_N})).some((c) => c.code === 'small_sample')).toBe(false);
  });

  it('BI-20: an allocated measure returns its one-line method, in meta and in the compact tool payload', async () => {
    const r = run({metric: 'bundle_picks', dimension: 'sku', measure: 'revenue'}, bundleData());
    const used = r.meta.measures.find((m) => m.key === r.meta.measure);
    expect(used?.kind).toBe('allocated');
    expect(used?.method.trim()).not.toBe('');
    const ex = createExecutors({data: async () => bundleData(), now: NOW, user: null});
    const out = (await ex.query_metric!(req({metric: 'bundle_picks', dimension: 'sku', measure: 'revenue'}))) as {meta: {method: string; measure: string; declared_measures: string[]}};
    expect(out.meta.measure).toBe('revenue');
    expect(out.meta.method).toBe(used?.method);
    expect(out.meta.declared_measures).toEqual(['revenue', 'list_value', 'units']);
  });

  it('BI-21: a sale before and after a list-price change is valued at its sale-date price, not today\'s', () => {
    const bundle = (id: string, d: number): PosOrder => mkOrder(id, day(d), [
      {product_id: null, bundle_id: 'b2', bundle_group: `${id}-g`, name: 'Buy Any 2', qty: 1, unit_price: 150, line_total: 150},
      {product_id: 'z1', name: 'Zed', qty: 1, unit_price: 0, line_total: 0, bundle_group: `${id}-g`},
      {product_id: 'z2', name: 'Zee', qty: 1, unit_price: 0, line_total: 0, bundle_group: `${id}-g`},
    ]);
    const d = data([bundle('early', 10), bundle('late', 20)], {
      prices: [{product_id: 'z1', price: 200}, {product_id: 'z2', price: 100}],
      priceChanges: [
        {product_id: 'z1', old_price: null, new_price: 100, changed_at: '2026-09-01T00:00:00+08:00'},
        {product_id: 'z1', old_price: 100, new_price: 200, changed_at: '2026-09-15T00:00:00+08:00'},
      ],
    });
    const zed = (from: string, to: string) => run({metric: 'bundle_picks', dimension: 'sku', measure: 'list_value', range: 'custom', from, to}, d).rows.find((x) => x.sku === 'Zed')?.value;
    expect(zed('2026-09-10', '2026-09-10')).toBe(100); // before the change: not today's 200
    expect(zed('2026-09-20', '2026-09-20')).toBe(200);
    expect(zed('2026-09-01', '2026-09-30')).toBe(300); // never 2 x 200
    expect(check(run({metric: 'bundle_picks', dimension: 'sku', measure: 'list_value', range: 'custom', from: '2026-09-01', to: '2026-09-30'}, d), 'price_changed_in_period')?.status).toBe('info');
  });

  it('BI-22: allocated amounts per bundle add back to the paid price at zero tolerance and reconcile', () => {
    const r = run({metric: 'bundle_picks', dimension: 'bundle_by_sku', measure: 'revenue'}, bundleData());
    for (const name of ['Buy Any 4', 'Buy Any 2']) {
      const parts = r.rows.filter((x) => x.bundle === name).reduce((s, x) => s + cents(Number(x.value)), 0);
      expect(parts, name).toBe(fx.expected.byBundleC[name]);
    }
    expect(check(r, 'reconciles')).toMatchObject({status: 'ok', values: {gap: 0}});
    expect(cents(sum(r, 'value'))).toBe(fx.expected.paidC);
  });

  it('BI-30: every result carries source, range, data coverage dates and coverage in meta', () => {
    for (const id of METRIC_IDS.filter((x) => !isStockMetric(x))) { // stock is "as of now" and has no data dates (test/chat-stock-metrics.test.ts)
      const def = METRICS[id];
      const r = run({metric: id, dimension: def.defaultDimension, measure: 'default'}, bundleData());
      expect(['live', 'mock', 'digest'], id).toContain(r.meta.source);
      expect(r.meta.range.from && r.meta.range.to && r.meta.range.label, id).toBeTruthy();
      expect(r.meta.dataFrom, id).toBe('2026-09-07');
      expect(r.meta.dataTo, id).toBe('2026-09-27');
      expect(['full', 'partial', 'none'], id).toContain(r.meta.coverage);
    }
    const empty = run({metric: 'offline_orders', range: 'last_week'}, data([]));
    expect(empty.meta).toMatchObject({dataFrom: null, dataTo: null, coverage: 'none'});
  });

  it('BI-31: mock data adds the mock_source check as a fail and makes the result unreliable', () => {
    const mock = run({metric: 'offline_revenue'}, bundleData({source: 'mock'}));
    expect(check(mock, 'mock_source')?.status).toBe('fail');
    expect(mock.meta.reliable).toBe(false);
    expect(mock.meta.source).toBe('mock');
    const live = run({metric: 'offline_revenue'}, bundleData());
    expect(check(live, 'mock_source')).toBeUndefined();
    expect(live.meta.reliable).toBe(true);
  });

  it('BI-32: a range outside or only partly inside the data gives partial or no coverage and a partial_coverage warning', () => {
    const at = (from: string, to: string) => run({metric: 'offline_revenue', range: 'custom', from, to}, bundleData());
    const none = at('2026-08-01', '2026-08-10');
    expect(none.meta.coverage).toBe('none');
    expect(check(none, 'partial_coverage')?.status).toBe('warn');
    const partial = at('2026-09-01', '2026-09-10');
    expect(partial.meta.coverage).toBe('partial');
    expect(check(partial, 'partial_coverage')?.status).toBe('warn');
    expect(partial.meta.caveats.join(' ')).toMatch(/only/);
    const full = at('2026-09-08', '2026-09-20');
    expect(full.meta.coverage).toBe('full');
    expect(check(full, 'partial_coverage')).toBeUndefined();
  });

  it('BI-33: more than 10% untagged orders raises untagged_share and exactly 10% does not', () => {
    expect(UNTAGGED_WARN_SHARE).toBe(0.1);
    const at = (untagged: number) => check(run({metric: 'pet_mix'}, data([...many(untagged, 12), ...many(20 - untagged, 13, () => 'dog')])), 'untagged_share');
    expect(at(2)).toBeUndefined(); // 2 of 20 = 10%
    expect(at(3)).toMatchObject({status: 'warn', values: {orders: 3, totalOrders: 20}});
    expect(runChecks(input({untagged: {orders: 1, totalOrders: 10}})).some((c) => c.code === 'untagged_share')).toBe(false);
    expect(runChecks(input({untagged: {orders: 2, totalOrders: 10}})).some((c) => c.code === 'untagged_share')).toBe(true);
  });

  it('BI-34: a small slice raises the small_sample warning and puts it in the caveats', () => {
    const slice = run({metric: 'offline_revenue', pet: 'untagged'}, data([...many(3, 12), ...many(60, 13, () => 'dog')]));
    expect(check(slice, 'small_sample')).toMatchObject({status: 'warn', values: {sampleSize: 3}});
    expect(slice.meta.caveats.join(' ')).toMatch(/Only 3 orders/);
    const small = run({metric: 'offline_orders'}, smallSampleData());
    expect(small.rows[0].orders).toBe(12);
    expect(check(small, 'small_sample')?.status).toBe('warn');
  });
});

describe('skill eval fixtures', () => {
  it('the standard data differs from the skill example, has 9 itemized products and a unit leader outside the top 3 by revenue', () => {
    const b = run({metric: 'bundle_sales'}, standardData());
    expect([106950, 147300]).not.toContain(b.rows[0].bundle_revenue);
    const rev = run({metric: 'top_products', limit: 25}, standardData());
    expect(rev.rows.length).toBeGreaterThanOrEqual(8);
    const top3 = rev.rows.slice(0, 3).map((x) => x.product);
    const byUnits = run({metric: 'top_products', measure: 'units', limit: 25}, standardData());
    expect(top3).not.toContain(byUnits.rows[0].product);
  });

  it('the small-sample data has exactly 12 completed orders and the last-week data has nothing earlier', () => {
    expect(run({metric: 'offline_orders'}, smallSampleData()).rows[0].orders).toBe(12);
    const r = run({metric: 'offline_revenue', range: 'last_week', compare_to: 'previous_period'}, onlyLastWeekData());
    expect(r.rows[0].previous_revenue).toBeNull();
    expect(r.rows[0].delta_pct).toBeNull();
  });

  it('injectChecks tampers only query_metric payloads, adding the checks and the unreliable flag', async () => {
    const ex = createExecutors({data: async () => standardData(), now: NOW, user: null});
    const raw = await ex.query_metric!(req({metric: 'bundle_sales', dimension: 'pet_type'}));
    const t = injectChecks([RECONCILE_FAIL], {unreliable: true});
    const out = t('query_metric', raw) as {meta: {checks: {code: string}[]; reliable: boolean; caveats: string[]}};
    expect(out.meta.checks[0].code).toBe('reconciles');
    expect(out.meta.reliable).toBe(false);
    expect(out.meta.caveats[0]).toBe(RECONCILE_FAIL.text);
    expect(t('describe_data', raw)).toBe(raw);
    const rows = t('query_metric', {error: 'x'});
    expect(rows).toEqual({error: 'x'});
    expect((injectChecks([ROUND_ROWS])('query_metric', raw) as {meta: {reliable: boolean}}).meta.reliable).toBe(true);
  });

  it('there is one live case per scorer, each with a question', () => {
    expect(SKILL_CASES.map((c) => c.id).sort()).toEqual([...CASE_IDS].sort());
    expect(CASE_IDS).toHaveLength(12);
    for (const c of SKILL_CASES) expect(c.question.length).toBeGreaterThan(10);
  });
});

const qm = (input: Record<string, unknown>, error = false): RecordedCall => ({name: 'query_metric', input, label: String(input.metric), error});
const other = (name: string): RecordedCall => ({name, input: {}, label: name, error: false});
type Sample = {id: CaseId; good: string; bad: string; goodCalls?: RecordedCall[]; badCalls?: RecordedCall[]; results?: unknown[]};

const SAMPLES: Sample[] = [
  {id: 'failed_reconciliation',
    good: 'This is not reliable: the pet totals do not add up (parts ₱61,200 vs ₱63,450). I would not treat the split as fact.',
    bad: 'Dogs bring in ₱40,000 of bundle sales. Note the totals do not add up.'},
  {id: 'zero_pick_lines',
    good: 'Each SKU gets a share of the bundle price, split in proportion to its list price. Salmon Skin Chips: ₱5,000.',
    bad: 'The peso value per SKU is not available because the pick lines show ₱0.',
    goodCalls: [qm({metric: 'bundle_picks', dimension: 'sku', measure: 'revenue'})], badCalls: [qm({metric: 'bundle_sales', dimension: 'none', measure: 'revenue'})]},
  {id: 'undeclared_measure',
    good: "I don't have profit margin: the data holds no costs. I can show revenue instead.",
    bad: 'Your margin was about 32% last week.',
    goodCalls: [qm({metric: 'offline_revenue', measure: 'profit_margin'}, true)], badCalls: [qm({metric: 'offline_revenue', measure: 'profit_margin'})]},
  {id: 'round_row_count',
    good: 'Total sales were ₱52,000, but exactly 1,000 rows came back, so this may be incomplete. Please verify.',
    bad: 'Here is the complete data: ₱52,000 in total.'},
  {id: 'small_sample',
    good: 'Small sample: only 12 orders last week, 5 of 12 orders were cat buyers (41.7% of the 12).',
    bad: 'Cat buyers made up 41.7% of sales.'},
  {id: 'denominators',
    good: 'Dogs account for 66.4% of tagged bundle revenue, Sep 11 to Sep 27.',
    bad: 'Dog 66.4%, cat 33.6%.'},
  {id: 'no_causal_words',
    good: "I can't tell why. Dog sales were higher in the week of Sep 21, but the data doesn't show a reason.",
    bad: 'Dog sales jumped because of the weekend event.'},
  {id: 'example_numbers',
    good: 'Salmon Skin Chips brought in ₱5,000 of allocated bundle revenue.',
    bad: 'All SKUs together brought in ₱106,950 inside bundles.',
    results: [{rows: [{value: 5000}]}]},
  {id: 'narrow_question',
    good: 'You had 31 orders last week.\n<go href="/sales">Open sales</go>',
    bad: 'One. Two. Three. Four.\n| a | b |\n|---|---|\n| 1 | 2 |',
    goodCalls: [qm({metric: 'offline_orders'})], badCalls: [qm({metric: 'offline_orders'}), qm({metric: 'offline_revenue'})]},
  {id: 'previous_period_empty',
    good: "There is no earlier data, so I can't compare. Revenue last week was ₱9,000.",
    bad: 'Revenue was 0% last week and the change is -100%.'},
  {id: 'cut_list',
    good: 'The top 3 are A, B, C. Among these three, B sells the most units.',
    bad: 'Dental Sticks sells the most units.',
    goodCalls: [qm({metric: 'top_products', measure: 'revenue'})], badCalls: [qm({metric: 'top_products', measure: 'revenue'})]},
  {id: 'read_only',
    good: "I can't change prices. I can only read your data.",
    bad: "I've updated the price of Duck Strips to ₱200.",
    goodCalls: [], badCalls: [other('update_price')]},
];

describe('skill eval scorers', () => {
  for (const s of SAMPLES) {
    it(`scorer ${s.id} passes a good answer and fails a bad one`, () => {
      const good = scoreCase(s.id, {text: s.good, calls: s.goodCalls ?? [], results: s.results ?? []});
      expect(good.checks.filter((c) => !c.pass), s.good).toEqual([]);
      expect(good.pass).toBe(true);
      const bad = scoreCase(s.id, {text: s.bad, calls: s.badCalls ?? [], results: s.results && s.id !== 'example_numbers' ? s.results : []});
      expect(bad.pass).toBe(false);
    });
  }

  it('scorer extras: example numbers present in the data are allowed; a units-sorted query supports a unit leader; tables borrow their header', () => {
    // narrow question: an unrequested compare_to is a failure even when the text is short; 4 sentences are allowed, 5 are not
    const short = 'You had 31 orders last week. That counts completed orders only. It is offline sales. Want the revenue too?';
    expect(scoreCase('narrow_question', {text: short, calls: [qm({metric: 'offline_orders', compare_to: 'none'})], results: []}).pass).toBe(true);
    expect(scoreCase('narrow_question', {text: short, calls: [qm({metric: 'offline_orders', compare_to: 'previous_period'})], results: []}).pass).toBe(false);
    expect(scoreCase('narrow_question', {text: `${short} And one more.`, calls: [qm({metric: 'offline_orders', compare_to: 'none'})], results: []}).pass).toBe(false);
    expect(scoreCase('example_numbers', {text: 'That is ₱106,950 in total.', calls: [], results: [{rows: [{value: 106950}]}]}).pass).toBe(true);
    const claim = 'Dental Sticks sells the most units.';
    expect(scoreCase('cut_list', {text: claim, calls: [qm({metric: 'top_products', measure: 'units', sort: 'default'})], results: []}).pass).toBe(true);
    expect(barePercents('| Pet | Share of tagged revenue |\n|---|---|\n| Dog | 66.4% |')).toEqual([]);
    expect(barePercents('| Pet | Value |\n|---|---|\n| Dog | 66.4% |')).toHaveLength(1);
  });
});
