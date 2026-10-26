import {describe, expect, it} from 'vitest';
import {buildAliasIndex, compareSku, isWholeWeeks, weekContaining, weekStart, weeksIn, type AliasRow, type ChannelRead, type SkuReaders} from '../src/sku-compare';
import {posReader, shopeeReader, websiteReader, websiteRowsFromCrm, type ShopeeSkuRow} from '../src/sku-compare-readers';
import type {MetricData} from '../src/chat/result-types';

// All numbers are SYNTHETIC. 12 Oct 2026 is a Monday.
const SKU = 'ZMYFDMEATBEFWHL01';
const alias = (o: Partial<AliasRow>): AliasRow => ({channel: 'shopee', alias_type: 'sku', alias_value: SKU, product_id: SKU, bundle_id: null, component_qty: 1, valid_from: null, valid_to: null, source: 'auto', confirmed_at: null, ...o});
const W = '2026-10-12';
const read = (rows: ChannelRead['rows'], extra: Partial<ChannelRead> = {}): ChannelRead => ({rows, weeksWithData: [W], ...extra});
const row = (keys: [string, string][], units: number, revenue: number | null, week = W) => ({week_from: week, keys: keys.map(([type, value]) => ({type: type as 'sku', value})), units, revenue});

describe('weeks', () => {
  it('snaps any day to its Monday to Sunday week', () => {
    expect(weekStart('2026-10-14')).toBe(W);
    expect(weekStart('2026-10-18')).toBe(W);
    expect(weekStart('2026-10-19')).toBe('2026-10-19');
    expect(weekContaining('2026-10-12')).toEqual({from: W, to: '2026-10-18'});
  });
  it('knows whole weeks', () => {
    expect(isWholeWeeks('2026-10-12', '2026-10-18')).toBe(true);
    expect(isWholeWeeks('2026-10-12', '2026-10-25')).toBe(true);
    expect(isWholeWeeks('2026-10-13', '2026-10-19')).toBe(false);
    expect(isWholeWeeks('2026-10-12', '2026-10-17')).toBe(false);
    expect(weeksIn('2026-10-12', '2026-10-25')).toEqual([W, '2026-10-19']);
  });
});

describe('alias index', () => {
  const range = {from: W, to: '2026-10-18'};
  it('counts an exact duplicate once and reports it', () => {
    const i = buildAliasIndex([alias({}), alias({})], range);
    expect(i.issues.map((x) => x.kind)).toEqual(['duplicate']);
    expect([...i.entries.values()]).toHaveLength(1);
  });
  it('reports a conflict and maps nothing for that key', () => {
    const i = buildAliasIndex([alias({}), alias({product_id: 'OTHER01'})], range);
    expect(i.issues.some((x) => x.kind === 'conflict')).toBe(true);
    expect([...i.entries.values()][0]).toEqual({kind: 'conflict'});
  });
  it('lets a renamed listing keep history: non-overlapping validity windows do not conflict', () => {
    const i = buildAliasIndex([alias({product_id: 'OLD01', valid_to: '2026-09-30'}), alias({valid_from: '2026-10-01'})], range);
    expect(i.issues).toEqual([]);
    expect([...i.entries.values()][0]).toMatchObject({kind: 'mapped', targets: [{product_id: SKU}]});
  });
  it('ignores an unconfirmed manual alias and says so', () => {
    const i = buildAliasIndex([alias({source: 'manual'})], range);
    expect(i.entries.size).toBe(0);
    expect(i.issues[0].kind).toBe('unconfirmed');
  });
  it('treats the same bundle on several products as a combo, not a conflict', () => {
    const i = buildAliasIndex([alias({product_id: 'A', bundle_id: 'duo'}), alias({product_id: 'B', bundle_id: 'duo'})], range);
    expect(i.issues).toEqual([]);
    expect([...i.entries.values()][0]).toMatchObject({combo: true});
  });
});

describe('compareSku', () => {
  const readers = (over: SkuReaders = {}): SkuReaders => ({
    pos: async () => read([row([['sku', SKU]], 10, 1500)]),
    shopee: async () => read([row([['sku', SKU]], 20, 3000), row([['sku', 'OTHER01']], 5, 700), row([['title', 'Mystery item']], 3, 400)], {coveragePct: {[W]: 88}, complete: false}),
    website: async () => read([row([['sku', 'WEB-BEEF-01']], 7, 1190), row([['sku', 'WEB-ODD']], 2, 300)]),
    ...over,
  });
  const aliases = [alias({}), alias({channel: 'website', alias_value: 'WEB-BEEF-01', source: 'manual', confirmed_at: '2026-10-20T00:00:00Z'})];

  it('worked example: compare Shopee, website and offline units for the week of 12 Oct', async () => {
    const r = await compareSku({sku: SKU, from: W, to: '2026-10-18', aliases, readers: readers()});
    const by = Object.fromEntries(r.channels.map((c) => [c.channel, c]));
    expect(r.aligned).toBe(true);
    expect(by.pos).toMatchObject({units: 10, revenue: 1500, status: 'ok', exact: true});
    expect(by.shopee).toMatchObject({units: 20, revenue: 3000, coveragePct: 88, exact: false});
    expect(by.website).toMatchObject({units: 7, revenue: 1190, mappingVerified: false});
    expect(r.combined).toMatchObject({units: 37, revenue: 5690, label: 'at least', mixedBasis: true, partial: false});
    expect(r.combined?.note).toMatch(/Mixed basis/);
    expect(r.combined?.note).toMatch(/unverified/);
    expect(by.shopee.notes.join(' ')).toMatch(/88%/);
  });

  it('puts unmapped rows in a bucket with a share, never in the SKU and never dropped', async () => {
    const r = await compareSku({sku: SKU, from: W, to: '2026-10-18', aliases, readers: readers()});
    const shopee = r.channels.find((c) => c.channel === 'shopee')!;
    // OTHER01 has no alias (unmapped); the title row has none either: 2 rows, 8 units of 28.
    expect(shopee.unmapped).toMatchObject({rows: 2, units: 8});
    expect(shopee.unmapped.shareOfUnits).toBeCloseTo(8 / 28);
    const web = r.channels.find((c) => c.channel === 'website')!;
    expect(web.unmapped).toMatchObject({rows: 1, units: 2});
    expect(r.unmapped).toMatchObject({rows: 3, units: 10});
    expect(r.combined?.units).toBe(37);
  });

  it('a missing channel makes the total partial and is named', async () => {
    const r = await compareSku({sku: SKU, from: W, to: '2026-10-18', aliases, readers: readers({website: async () => { throw new Error('boom'); }})});
    expect(r.channels.find((c) => c.channel === 'website')?.status).toBe('failed');
    expect(r.combined).toMatchObject({partial: true, missing: ['website'], label: 'at least'});
    expect(r.combined?.note).toMatch(/Website/);
  });

  it('a channel without a reader is not connected, and lazada can be asked for', async () => {
    const r = await compareSku({sku: SKU, from: W, to: '2026-10-18', aliases, readers: readers(), channels: ['pos', 'lazada']});
    expect(r.channels.find((c) => c.channel === 'lazada')?.status).toBe('not_connected');
    expect(r.combined?.missing).toEqual(['lazada']);
  });

  it('partial coverage: a week with no Shopee import is a missing week, not zero', async () => {
    const two = {from: W, to: '2026-10-25'};
    const r = await compareSku({
      sku: SKU, ...two, aliases,
      readers: {
        pos: async ({weeks}) => ({rows: weeks.map((w) => row([['sku', SKU]], 4, 600, w)), weeksWithData: weeks}),
        shopee: async () => read([row([['sku', SKU]], 20, 3000)], {complete: false}),
      },
      channels: ['pos', 'shopee'],
    });
    const shopee = r.channels.find((c) => c.channel === 'shopee')!;
    expect(shopee.weeksMissing).toEqual(['2026-10-19']);
    expect(shopee.units).toBe(20);
    expect(r.channels.find((c) => c.channel === 'pos')?.units).toBe(8);
    expect(r.combined).toMatchObject({partial: true, missing: ['shopee'], units: 28});
  });

  it('gives no total for dates that are not whole Monday to Sunday weeks', async () => {
    const r = await compareSku({sku: SKU, from: '2026-10-14', to: '2026-10-20', aliases, readers: readers()});
    expect(r.aligned).toBe(false);
    expect(r.combined).toBeNull();
    expect(r.notes.join(' ')).toMatch(/whole Monday to Sunday/);
  });

  it('a conflicting alias leaves its rows unmapped, not guessed', async () => {
    const r = await compareSku({sku: SKU, from: W, to: '2026-10-18', aliases: [...aliases, alias({product_id: 'OTHER01'})], readers: readers()});
    expect(r.issues.some((i) => i.kind === 'conflict')).toBe(true);
    const shopee = r.channels.find((c) => c.channel === 'shopee')!;
    expect(shopee.units).toBe(0);
    expect(shopee.unmapped.rows).toBe(3);
  });

  it('a combo listing adds component units but not revenue', async () => {
    const combo = [alias({channel: 'website', alias_value: 'DUO', product_id: SKU, bundle_id: 'duo', component_qty: 2}), alias({channel: 'website', alias_value: 'DUO', product_id: 'OTHER01', bundle_id: 'duo'})];
    const r = await compareSku({sku: SKU, from: W, to: '2026-10-18', aliases: combo, readers: readers({website: async () => read([row([['sku', 'DUO']], 3, 900)])}), channels: ['website']});
    const web = r.channels[0];
    expect(web.units).toBe(6);
    expect(web.revenue).toBeNull();
    expect(r.combined).toBeNull();
  });

  it('rejects bad input', async () => {
    await expect(compareSku({sku: ' ', from: W, to: W, aliases, readers: {}})).rejects.toThrow();
    await expect(compareSku({sku: SKU, from: '2026-13-01', to: W, aliases, readers: {}})).rejects.toThrow();
  });
});

describe('readers', () => {
  const s = (o: Partial<ShopeeSkuRow>): ShopeeSkuRow => ({period_from: W, period_to: '2026-10-18', item_id: '1', product: 'Beef', variation_id: null, sku: null, sales_confirmed: 100, units_confirmed: 5, ...o});
  const range = (weeks = [W]) => ({sku: SKU, from: weeks[0], to: '2026-10-18', weeks});

  it('Shopee: variation rows replace their product row so nothing is added twice, and coverage comes from the shop total', async () => {
    const r = await shopeeReader([s({}), s({variation_id: 'v1', sku: SKU, sales_confirmed: 60, units_confirmed: 3}), s({variation_id: 'v2', sku: 'X', sales_confirmed: 40, units_confirmed: 2}), s({item_id: '2', product: 'Solo', sales_confirmed: 50, units_confirmed: 1})], {[W]: 400})(range());
    expect(r.rows.map((x) => x.units)).toEqual([3, 2, 1]);
    expect(r.rows.reduce((a, x) => a + (x.revenue ?? 0), 0)).toBe(150);
    expect(r.coveragePct?.[W]).toBeCloseTo(37.5);
    expect(r.complete).toBe(false);
  });
  it('Shopee: coverage is unknown without a shop total, and a non-Monday week is left out', async () => {
    const r = await shopeeReader([s({}), s({period_from: '2026-10-13', period_to: '2026-10-19'})])(range([W, '2026-10-13']));
    expect(r.coveragePct?.[W]).toBeNull();
    expect(r.weeksWithData).toEqual([W]);
    expect(r.notes?.[0]).toMatch(/Monday to Sunday/);
  });
  it('website: reads the CRM products body, net as revenue; a truncated ranking is not exact', async () => {
    const body = {products: [{sku: 'W1', variant_id: 'v', title: 'T', units: 2, gross: 300, discounts: 20, net: 280, orders: 2}, {sku: null, title: 'No sku', units: 1, net: 10}], truncated: true};
    expect(websiteRowsFromCrm(body, W).rows[0]).toMatchObject({units: 2, revenue: 280, keys: [{type: 'sku', value: 'W1'}, {type: 'variant_id', value: 'v'}, {type: 'title', value: 'T'}]});
    const calls: string[] = [];
    const r = await websiteReader(async (f, t) => { calls.push(`${f}..${t}`); return body; })(range([W, '2026-10-19']));
    expect(calls).toEqual([`${W}..2026-10-18`, '2026-10-19..2026-10-25']);
    expect(r.complete).toBe(false);
    expect(() => websiteRowsFromCrm({nope: 1}, W)).toThrow('bad_shape');
  });
  it('POS: direct sales plus bundle allocation for the week, from the existing product-sales rules', async () => {
    const line = (qty: number, total: number, extra = {}) => ({product_id: SKU, name: 'Beef', qty, unit_price: total / qty, line_total: total, ...extra});
    const order = (id: string, created_at: string, items: unknown[]) => ({id, client_uuid: id, subtotal: 0, discount: null, total: 0, oversold: false, device_id: null, payment_method: 'cash', customer_handle: null, status: 'completed', remarks: null, created_at, edited_at: null, event_id: null, pet_type: null, items});
    const data = {source: 'live', orders: [order('a', '2026-10-13T03:00:00Z', [line(2, 300)]), order('b', '2026-10-25T03:00:00Z', [line(9, 900)])], events: [], prices: [], priceChanges: [], bulkReads: []} as unknown as MetricData;
    const r = await posReader(data)(range());
    expect(r.rows[0]).toMatchObject({units: 2, revenue: 300});
  });
});
