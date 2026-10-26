// compare_sku in Ask Coop (contract knowledge/tasks/2026-10-26-sku-compare-contract.md). All numbers are SYNTHETIC. 12 Oct 2026 is a Monday.
// Golden scripted case for acceptance question 7: "Compare Shopee, website and offline units for SKU ZMYFDMEATBEFWHL01 for the week of 12 Oct".
import {describe, expect, it, vi} from 'vitest';
import {assertRequestShape} from '../src/chat/request-shape';
import type {MetricData, MetricResult} from '../src/chat/result-types';
import {readCompareInput} from '../src/chat/sku-compare-tool';
import {COMPARE_SKU_TOOL, chatTools} from '../src/chat/tool-defs';
import {createExecutors, statusFor} from '../src/chat/tool-executors';
import {CrmError, type CrmClient, type CrmRead} from '../src/chat/crm/client';
import type {AliasRow} from '../src/sku-compare';
import type {ShopeeSkuRow} from '../src/sku-compare-readers';

const SKU = 'ZMYFDMEATBEFWHL01';
const NOW = new Date('2026-10-26T04:00:00Z');
const line = (qty: number, total: number) => ({product_id: SKU, name: 'Beef Whole', qty, unit_price: total / qty, line_total: total});
const order = (id: string, created_at: string, items: unknown[]) => ({id, client_uuid: id, subtotal: 0, discount: null, total: 0, oversold: false, device_id: null, payment_method: 'cash', customer_handle: null, status: 'completed', remarks: null, created_at, edited_at: null, event_id: null, pet_type: null, items});
const POS = {source: 'live', orders: [order('a', '2026-10-13T03:00:00Z', [line(4, 600)]), order('b', '2026-10-25T03:00:00Z', [line(9, 900)])], events: [], prices: [], priceChanges: [], bulkReads: []} as unknown as MetricData;
const alias = (o: Partial<AliasRow>): AliasRow => ({channel: 'shopee', alias_type: 'sku', alias_value: SKU, product_id: SKU, bundle_id: null, component_qty: 1, valid_from: null, valid_to: null, source: 'auto', confirmed_at: '2026-10-20T00:00:00Z', ...o});
const shopee = (o: Partial<ShopeeSkuRow>): ShopeeSkuRow => ({period_from: '2026-10-12', period_to: '2026-10-18', item_id: '1', product: 'Beef Whole', variation_id: null, sku: SKU, sales_confirmed: 700, units_confirmed: 5, ...o});
const WEBSITE = {products: [{key: SKU, sku: SKU, variant_id: 'v1', product_id: 'p1', title: 'Beef Whole', units: 3, gross: 500, discounts: 50, net: 450, orders: 3}, {key: null, sku: null, variant_id: null, product_id: null, title: 'Gift card', units: 1, gross: 100, discounts: 0, net: 100, orders: 1}], truncated: false, unmapped: {lines: 1, of_lines: 4, gross: 100, share_of_gross: 0.17}};

function world(opts: {website?: unknown | CrmError | 'none'; aliases?: AliasRow[]; shopeeRows?: ShopeeSkuRow[]; aliasFail?: boolean} = {}) {
  const gets: {endpoint: string; query: unknown; opts: unknown}[] = [];
  const sink = {info: vi.fn(), error: vi.fn()};
  const crm: CrmClient | undefined =
    opts.website === 'none'
      ? undefined
      : {
          async get(endpoint, query, o): Promise<CrmRead> {
            gets.push({endpoint, query, opts: o});
            if (opts.website instanceof CrmError) throw opts.website;
            return {endpoint, body: opts.website ?? WEBSITE, bytes: 200, ms: 1, cached: false};
          },
          async postShopify() {
            throw new CrmError('refused');
          },
        };
  const ex = createExecutors({
    data: async () => POS,
    now: NOW,
    user: 'owner@example.test',
    crm,
    sink,
    sku: {
      aliases: async () => {
        if (opts.aliasFail) throw new Error('table missing');
        return opts.aliases ?? [alias({}), alias({channel: 'website', confirmed_at: '2026-10-20T00:00:00Z'})];
      },
      shopee: async () => opts.shopeeRows ?? [shopee({}), shopee({item_id: '2', product: 'Mystery', sku: 'ZZ-UNKNOWN', units_confirmed: 2, sales_confirmed: 100})],
    },
  });
  return {ex, gets, sink};
}
const text = (r: MetricResult | {meta: MetricResult['meta']}) => r.meta.checks.map((c) => c.text).join('\n');

describe('input', () => {
  it('takes sku, from, to; the sku is upper-cased; SQL, urls and long ranges are refused', () => {
    expect(readCompareInput({sku: ' zmyfdmeatbefwhl01 ', from: '2026-10-12', to: '2026-10-18'})).toEqual({sku: SKU, from: '2026-10-12', to: '2026-10-18'});
    for (const bad of [
      null,
      {sku: SKU, from: '2026-10-12'},
      {sku: SKU, from: '2026-10-12', to: '2026-10-18', url: 'https://evil.example'},
      {sku: "x'; drop table pos_orders; --", from: '2026-10-12', to: '2026-10-18'},
      {sku: 'Beef Whole', from: '2026-10-12', to: '2026-10-18'},
      {sku: SKU, from: '12 Oct', to: '18 Oct'},
      {sku: SKU, from: '2026-10-18', to: '2026-10-12'},
      {sku: SKU, from: '2026-02-30', to: '2026-03-01'},
      {sku: SKU, from: '2026-01-05', to: '2026-12-27'},
    ]) expect(readCompareInput(bad), JSON.stringify(bad)).toEqual({error: expect.any(String)});
  });
});

describe('golden, acceptance 7: Shopee, website and offline units for one SKU for the week of 12 Oct', () => {
  it('one answer with each channel\'s basis, coverage, mixed basis, "at least", the unmapped share and the unverified website mapping', async () => {
    const {ex, gets} = world();
    const out = (await ex.compare_sku?.({sku: SKU, from: '2026-10-12', to: '2026-10-18'})) as MetricResult & {id: string};
    expect(out).toMatchObject({id: 'r1', metric: 'sku_compare', dimension: 'channel'});
    expect(out.rows).toEqual([
      {channel: 'Offline (POS)', units: 4, revenue: 600, unmapped_units: 0},
      {channel: 'Shopee', units: 5, revenue: 700, unmapped_units: 2},
      {channel: 'Website', units: 3, revenue: 450, unmapped_units: 1},
    ]);
    const t = text(out);
    // basis per channel
    expect(t).toMatch(/Offline \(POS\): 4 units, revenue ₱600\. Basis: /);
    expect(t).toMatch(/Shopee: 5 units, revenue ₱700\. Basis: /);
    expect(t).toMatch(/Website: 3 units, revenue ₱450\. Basis: Website orders from the CRM, line gross minus discounts, before returns/);
    expect(t).toMatch(/Website counts paid orders only/);
    // coverage and "at least"
    expect(t).toMatch(/Shopee is NOT the whole channel: it lists only the top performing products and its coverage of the shop is unknown/);
    expect(t).toMatch(/label "at least"/);
    expect(t).toMatch(/Say "at least 12 units" for the total/);
    // mixed basis
    expect(t).toMatch(/MIXED BASIS \(the channels count sales differently: say so\)/);
    // unmapped share
    expect(t).toMatch(/Shopee: 1 row \(2 units, 28\.6% of the channel's units\) have no confirmed alias and are NOT in any SKU\. State this unmapped share\./);
    expect(t).toMatch(/Website: 1 row \(1 unit, 25\.0% of the channel's units\) have no confirmed alias/);
    expect(t).toMatch(/Offline \(POS\): no unmapped rows/);
    // the website mapping is unverified, and the answer must say so
    expect(t).toMatch(/Website mapping is UNVERIFIED/);
    // the total, computed in code
    expect(out.meta.totals?.[0]).toMatchObject({units: 12, revenue: 1750, status: 'partial', calculated_in_code: true});
    expect(out.meta.totals?.[0].label).toMatch(/at least/);
    // the website read: one GET for the week, typed parameters, counted apart from the CRM tools' own cap
    expect(gets).toEqual([{endpoint: 'productSales', query: {from: '2026-10-12', to: '2026-10-18', group_by: 'sku', limit: 200, financial_status: 'paid'}, opts: {paged: true}}]);
    expect(JSON.stringify(out.meta)).not.toMatch(/[–—]/);
  });
  it('writes one chat_crm_call line for the whole call, with no figure in it', async () => {
    const {ex, sink} = world();
    await ex.compare_sku?.({sku: SKU, from: '2026-10-12', to: '2026-10-18'});
    const calls = sink.info.mock.calls.map((c) => JSON.parse(c[0] as string)).filter((l) => l.event === 'chat_crm_call');
    expect(calls).toEqual([expect.objectContaining({tool: 'compare_sku', endpoints: ['productSales'], ok: true, rows: 3})]);
  });
  it('with no confirmed alias at all, every Shopee and website row is unmapped and the SKU shows POS only', async () => {
    const {ex} = world({aliases: []});
    const out = (await ex.compare_sku?.({sku: SKU, from: '2026-10-12', to: '2026-10-18'})) as MetricResult;
    expect(out.rows.map((r) => [r.channel, r.units])).toEqual([['Offline (POS)', 4], ['Shopee', 0], ['Website', 0]]);
    expect(text(out)).toMatch(/have no confirmed alias/);
  });
  it('an unreadable alias table degrades to "unmapped", it does not fail the answer', async () => {
    const {ex} = world({aliasFail: true});
    const out = (await ex.compare_sku?.({sku: SKU, from: '2026-10-12', to: '2026-10-18'})) as MetricResult;
    expect(out.rows[0]).toMatchObject({channel: 'Offline (POS)', units: 4});
  });
});

describe('a channel that cannot be read is named, never a silent zero', () => {
  it('the CRM is unreachable: Website is failed and named, the total is partial, and the audit line says so', async () => {
    const {ex, sink} = world({website: new CrmError('unreachable')});
    const out = (await ex.compare_sku?.({sku: SKU, from: '2026-10-12', to: '2026-10-18'})) as MetricResult;
    expect(out.rows.map((r) => r.channel)).toEqual(['Offline (POS)', 'Shopee']);
    expect(text(out)).toMatch(/Website: could not be read just now\. Its figure is missing, so the total is partial\. Say so and give no Website number\./);
    expect(out.meta.totals?.[0]).toMatchObject({status: 'partial'});
    const calls = sink.info.mock.calls.map((c) => JSON.parse(c[0] as string)).filter((l) => l.event === 'chat_crm_call');
    expect(calls[0]).toMatchObject({ok: false, code: 'unreachable'});
  });
  it('no CRM in this deployment: Website is "not connected here"', async () => {
    const {ex} = world({website: 'none'});
    const out = (await ex.compare_sku?.({sku: SKU, from: '2026-10-12', to: '2026-10-18'})) as MetricResult;
    expect(text(out)).toMatch(/Website: is not connected here/);
    expect(out.rows.map((r) => r.channel)).toEqual(['Offline (POS)', 'Shopee']);
  });
  it('Shopee weeks that were not imported say "no data for the week", not zero', async () => {
    const {ex} = world({shopeeRows: []});
    const out = (await ex.compare_sku?.({sku: SKU, from: '2026-10-12', to: '2026-10-18'})) as MetricResult;
    expect(text(out)).toMatch(/Shopee: no data for these weeks|Shopee has no data for this week/);
    expect(out.rows.map((r) => r.channel)).not.toContain('Shopee');
  });
});

describe('dates and refusals', () => {
  it('dates that are not whole Monday to Sunday weeks give each channel alone and no total, and say why', async () => {
    const {ex, gets} = world();
    const out = (await ex.compare_sku?.({sku: SKU, from: '2026-10-13', to: '2026-10-18'})) as MetricResult;
    expect(out.meta.totals).toBeUndefined();
    expect(text(out)).toMatch(/not whole Monday to Sunday weeks/);
    expect(text(out)).toMatch(/No total is given/);
    expect(gets.length).toBeLessThanOrEqual(1);
  });
  it('a bad request is refused with the reason and nothing is read', async () => {
    const {ex, gets} = world();
    expect(await ex.compare_sku?.({sku: "x'; drop table pos_orders; --", from: '2026-10-12', to: '2026-10-18'})).toEqual({error: expect.stringMatching(/product code/)});
    expect(await ex.compare_sku?.({sku: SKU, from: '2026-10-12', to: '2026-10-18', limit: 9999})).toEqual({error: expect.any(String)});
    expect(gets).toHaveLength(0);
  });
  it('a multi-week range reads the CRM once per week, counted as paged reads', async () => {
    const {ex, gets} = world();
    await ex.compare_sku?.({sku: SKU, from: '2026-10-05', to: '2026-10-18'});
    expect(gets.map((g) => (g.query as {from: string}).from)).toEqual(['2026-10-05', '2026-10-12']);
    expect(gets.every((g) => (g.opts as {paged: boolean}).paged)).toBe(true);
  });
});

describe('the tool definition and wiring', () => {
  it('is not strict, valid for the request-shape guard, closed, and sent only when asked for', () => {
    expect(COMPARE_SKU_TOOL.strict).toBe(false);
    expect(COMPARE_SKU_TOOL.input_schema.additionalProperties).toBe(false);
    expect(Object.keys(COMPARE_SKU_TOOL.input_schema.properties)).toEqual(['sku', 'from', 'to']);
    expect(() => assertRequestShape({model: 'm', max_tokens: 1, messages: [], tools: chatTools({explore: true, crm: true, contacts: true, sku: true})})).not.toThrow();
    expect(() => assertRequestShape({model: 'm', max_tokens: 1, messages: [], tools: [{...COMPARE_SKU_TOOL, strict: undefined}]})).toThrow(/strict/);
    expect(chatTools({explore: false, crm: false}).some((t) => t.name === 'compare_sku')).toBe(false);
    expect(chatTools({explore: false, crm: false, sku: true}).some((t) => t.name === 'compare_sku')).toBe(true);
    expect(createExecutors({data: async () => POS, now: NOW, user: null}).compare_sku).toBeUndefined();
  });
  it('the description names the week rule, the lookup_product route, get_channel_report for plain totals, and the unverified website mapping; no dashes', () => {
    const d = COMPARE_SKU_TOOL.description;
    expect(d).toMatch(/week of 12 Oct/);
    expect(d).toMatch(/lookup_product/);
    expect(d).toMatch(/get_channel_report/);
    expect(d).toMatch(/UNVERIFIED/);
    expect(d).toMatch(/at least/);
    expect(JSON.stringify(COMPARE_SKU_TOOL)).not.toMatch(/[–—]/);
    expect(statusFor('compare_sku', {sku: SKU})).toBe('Comparing one product across channels');
  });
});
