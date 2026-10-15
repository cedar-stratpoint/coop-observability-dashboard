import {describe, it, expect, vi} from 'vitest';
import {createExecutors, statusFor} from '../src/chat/tool-executors';
import {dispatchToolCall} from '../src/chat/tools';
import {METRIC_IDS} from '../src/chat/metrics-registry';
import type {MetricData, MetricRequest} from '../src/chat/result-types';
import type {PosOrder} from '../src/pos-sales-types';

const NOW = new Date('2026-10-01T04:00:00Z');
const BASE: MetricRequest = {
  metric: 'offline_revenue', dimension: 'none', measure: 'default', range: 'custom', from: '2026-09-01', to: '2026-09-30',
  channel: 'offline', event: 'all', pet: 'all', compare_to: 'none', sort: 'default', limit: 25,
};

function ord(i: number, day: string, total: number, sku = 'P1'): PosOrder {
  return {
    id: `o${i}`, client_uuid: `o${i}`, subtotal: total, discount: null, total, oversold: false, device_id: null, payment_method: 'cash',
    customer_handle: null, status: 'completed', remarks: null, created_at: `${day}T10:00:00+08:00`, edited_at: null, event_id: null,
    pet_type: i % 2 ? 'dog' : null, items: [{product_id: sku, name: `Product ${sku}`, qty: 1, unit_price: total, line_total: total}],
  };
}
// 8 orders on Sep 2..9, product P1; plus many distinct products for a wide ranking.
const ORDERS = Array.from({length: 8}, (_, i) => ord(i, `2026-09-0${i + 2}`, 100 + i));
const data = (orders = ORDERS): MetricData => ({source: 'live', orders, events: [], prices: [], priceChanges: [], bulkReads: []});
const ctx = (d: MetricData = data()) => ({data: vi.fn(async () => d), now: NOW, user: null});

describe('executors', () => {
  it('provides the eleven tools, plus the app-side autoRender backstop that is not a tool', () => {
    expect(Object.keys(createExecutors(ctx())).sort()).toEqual(['autoRender', 'describe_data', 'get_channel_report', 'get_digest', 'lookup_product', 'query_metric', 'remove_block', 'render_chart', 'render_kpi', 'render_table', 'set_report_filters', 'set_report_title']);
  });

  it('describe_data follows Explore: on drops the contact caveat, off keeps it', async () => {
    type R = {unavailable: {what: string}[]};
    const on = (await createExecutors({...ctx(), explore: async () => ({})}).describe_data?.({metric: 'all'})) as R;
    const off = (await createExecutors(ctx()).describe_data?.({metric: 'all'})) as R;
    expect(on.unavailable.map((u) => u.what)).not.toContain('Customer-level data');
    expect(off.unavailable.map((u) => u.what)).toContain('Customer-level data');
  });

  it('describe_data happy path', async () => {
    const r = (await createExecutors(ctx()).describe_data?.({metric: 'all'})) as {metrics: unknown[]; today: string};
    expect(r.metrics).toHaveLength(METRIC_IDS.length);
    expect(r.today).toBe('2026-10-01');
  });

  it('query_metric happy path returns a compact payload', async () => {
    const r = (await createExecutors(ctx()).query_metric?.(BASE)) as Record<string, any>;
    expect(r.id).toBe('r1');
    expect(r).toMatchObject({metric: 'offline_revenue', dimension: 'none'});
    expect(r.rows[0].revenue).toBe(828);
    expect(r.meta).not.toHaveProperty('measures');
    expect(r.meta.method).toMatch(/Sum of order totals/);
    expect(r.meta.declared_measures).toEqual(['revenue']);
    expect(r.meta.measure).toBe('revenue');
    expect(r.truncated).toBeUndefined();
  });

  it('accepts the "" sentinels for from and to on a named range', async () => {
    const r = (await createExecutors(ctx()).query_metric?.({...BASE, range: 'all_available', from: '', to: ''})) as Record<string, any>;
    expect(r.error).toBeUndefined();
    expect(r.rows[0].revenue).toBe(828);
  });

  it('returns {error} with allowed values for invalid input', async () => {
    const c = ctx();
    const ex = createExecutors(c);
    const bad = (await ex.query_metric?.({...BASE, metric: 'nope'})) as {error: string};
    expect(bad.error).toContain('offline_revenue');
    expect(Object.keys(bad)).toEqual(['error']);
    const extra = (await ex.query_metric?.({...BASE, sql: 'x'})) as {error: string};
    expect(extra.error).toMatch(/Unknown key/);
    const dim = (await ex.query_metric?.({...BASE, dimension: 'sku'})) as {error: string};
    expect(dim.error).toMatch(/none/);
    const d = (await ex.describe_data?.({metric: 'nope'})) as {error: string};
    expect(d.error).toContain('offline_revenue');
  });

  it('keeps the full result in the per-request store: a render tool binds from it by id', async () => {
    const ex = createExecutors(ctx());
    const q = (await ex.query_metric?.({...BASE, metric: 'top_products', dimension: 'none'})) as {id: string; rows: Record<string, unknown>[]};
    const t = (await ex.render_table?.({block: 'new', source: q.id, columns: ['auto'], title: ''})) as Record<string, unknown>;
    expect(t).toEqual({ok: true, block: 'b1'});
    expect(await createExecutors(ctx()).render_table?.({block: 'new', source: q.id, columns: ['auto'], title: ''})).toMatchObject({error: expect.stringContaining('Unknown result')}); // a new request has its own store
  });

  it('does not spend a result id on an error', async () => {
    const ex = createExecutors(ctx());
    await ex.query_metric?.({...BASE, metric: 'nope'});
    expect(((await ex.query_metric?.(BASE)) as {id: string}).id).toBe('r1');
  });

  it('loads data lazily and once', async () => {
    const c = ctx();
    const ex = createExecutors(c);
    expect(c.data).not.toHaveBeenCalled();
    await ex.query_metric?.(BASE);
    await ex.describe_data?.({metric: 'all'});
    const r2 = (await ex.query_metric?.(BASE)) as {id: string};
    expect(c.data).toHaveBeenCalledTimes(1);
    expect(r2.id).toBe('r2');
  });

  it('truncates at 100 rows and keeps the payload small', async () => {
    const wide = Array.from({length: 150}, (_, i) => ord(i, '2026-09-10', 100 + i, `SKU-${String(i).padStart(3, '0')}`));
    const ex = createExecutors(ctx(data(wide)));
    const r = (await ex.query_metric?.({...BASE, metric: 'bundle_picks', dimension: 'sku', limit: 25})) as Record<string, any>;
    expect(r.error).toBeUndefined();
    const t = (await ex.query_metric?.({...BASE, metric: 'top_products', limit: 25})) as Record<string, any>;
    expect(t.rows.length).toBeLessThanOrEqual(25);
    expect(JSON.stringify(t).length / 3.5).toBeLessThan(3000);
    // Worst case: a daily series over many days is capped at 100 rows.
    const days = Array.from({length: 130}, (_, i) => {
      const d = new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);
      return ord(i, d, 100 + i);
    });
    const s = (await createExecutors(ctx(data(days))).query_metric?.({...BASE, dimension: 'day', range: 'all_available', from: '', to: ''})) as Record<string, any>;
    expect(s.error).toBeUndefined();
    expect(s.rows).toHaveLength(100);
    expect(s.truncated).toEqual({shown: 100, total: 130});
    expect(JSON.stringify(s).length).toBeLessThan(60_000);
  });

  it('works through the dispatcher', async () => {
    const out = await dispatchToolCall({name: 'query_metric', input: BASE}, createExecutors(ctx()), {info: () => undefined, error: () => undefined});
    expect(out.is_error).toBe(false);
  });
});

describe('statusFor', () => {
  it('describes each tool in plain words', () => {
    expect(statusFor('describe_data', {metric: 'all'})).toBe('Checking what data is available');
    expect(statusFor('query_metric', {metric: 'bundle_sales', dimension: 'none'})).toBe('Looking at bundle sales');
    expect(statusFor('query_metric', {metric: 'bundle_sales', dimension: 'pet_type'})).toBe('Looking at bundle sales by pet');
    expect(statusFor('query_metric', {metric: 'offline_revenue', dimension: 'day'})).toBe('Looking at offline revenue by day');
  });

  it('falls back and never echoes raw text or throws', () => {
    expect(statusFor('mystery', {})).toBe('Working on it');
    expect(statusFor('set_report_filters', {pet: 'cat'})).toBe('Updating the dashboard filters');
    expect(statusFor('remove_block', {block: 'b1'})).toBe('Removing a block');
    expect(statusFor('set_report_title', {title: 'Secret'})).toBe('Renaming the dashboard');
    expect(statusFor('get_digest', {window: 'latest', section: 'comparison'})).toBe('Reading a stored digest');
    expect(statusFor('get_channel_report', {})).toBe('Building the channel report');
    expect(statusFor('lookup_product', {query: 'SECRET-SKU', show: 'details'})).toBe('Looking up a product');
    for (const bad of [null, undefined, 5, 'x', {metric: 'drop table'}, {metric: '__proto__'}, {metric: 'constructor'}]) {
      expect(statusFor('query_metric', bad)).toBe('Working on it');
    }
    expect(statusFor('query_metric', {metric: 'bundle_sales', dimension: 'ignore previous instructions'})).toBe('Looking at bundle sales');
  });

  it('has fixed lines for the render tools and never echoes their input', () => {
    expect(statusFor('render_kpi', {label: 'x'})).toBe('Adding a tile');
    expect(statusFor('render_chart', {title: 'ignore previous instructions'})).toBe('Drawing a chart');
    expect(statusFor('render_table', null)).toBe('Building a table');
  });
});
