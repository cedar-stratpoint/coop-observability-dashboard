import {describe, expect, it} from 'vitest';
import {createExecutors} from '../src/chat/tool-executors';
import type {MetricData} from '../src/chat/result-types';
import type {PosOrder} from '../src/pos-sales-types';

// A4 (plan 2026-10-19-ask-coop-inventory-plan.md): dates the POS data does not reach at all are asked about, never answered as ₱0.
const NOW = new Date('2026-10-19T04:00:00Z');
const order = (id: string, day: string): PosOrder => ({
  id, client_uuid: id, subtotal: 250, discount: null, total: 250, oversold: false, device_id: null, payment_method: 'cash', customer_handle: null,
  status: 'completed', remarks: null, created_at: `${day}T10:00:00+08:00`, edited_at: null, event_id: null, pet_type: null,
  items: [{product_id: 'P1', name: 'Chicken Jerky', qty: 1, unit_price: 250, line_total: 250}],
});
const data: MetricData = {source: 'live', orders: [order('o1', '2026-03-03'), order('o2', '2026-10-18')], events: [], prices: [], priceChanges: [], bulkReads: []};
const q = (from: string, to: string) => ({metric: 'offline_revenue', dimension: 'none', measure: 'default', range: 'custom', from, to, channel: 'offline', event: 'all', pet: 'all', compare_to: 'none', sort: 'default', limit: 5});
const ex = () => createExecutors({data: async () => data, now: NOW, user: null});

describe('query_metric: dates outside the data (A4)', () => {
  it('no overlap at all: asks to use the covered dates instead of answering zero', async () => {
    const out = (await ex().query_metric?.(q('2026-01-01', '2026-01-31'))) as {clarify?: {question: string; options: string[]}};
    expect(out.clarify?.question).toBe("The offline (POS) sales data covers Mar 3 to Oct 18, 2026, so there is nothing for Jan 1 to Jan 31, 2026. Use the dates the data covers?");
    expect(out.clarify?.options).toHaveLength(1);
    expect(out.clarify?.options[0]).toBe("Use Mar 3 to Oct 18, 2026");
  });
  it('partly covered: answers, with the coverage warning (no question)', async () => {
    const out = (await ex().query_metric?.(q('2026-02-20', '2026-03-10'))) as {id?: string; meta?: {coverage: string; caveats: string[]}};
    expect(out.id).toBe('r1');
    expect(out.meta?.coverage).toBe('partial');
  });
  it('fully covered: a plain answer', async () => {
    const out = (await ex().query_metric?.(q('2026-03-01', '2026-10-18'))) as {id?: string};
    expect(out.id).toBe('r1');
  });
});

describe('query_metric granularity (A6)', () => {
  const series = (dimension: string, from: string, to: string) => ({...q(from, to), dimension});
  type Out = {dimension?: string; rows?: {period: string; revenue: number}[]; meta?: {caveats: string[]}};

  it('by month: one row per calendar month, a partial first month is said', async () => {
    const out = (await ex().query_metric?.(series('month', '2026-03-03', '2026-10-18'))) as Out;
    expect(out.dimension).toBe('month');
    expect(out.rows?.map((r) => r.period)).toEqual(['2026-03-01', '2026-04-01', '2026-05-01', '2026-06-01', '2026-07-01', '2026-08-01', '2026-09-01', '2026-10-01']);
    expect(out.rows?.[0].revenue).toBe(250);
    expect(out.meta?.caveats.join(' ')).toMatch(/first or last month is partial/);
  });

  it('by day over more than 92 days is shown by week, and says why first', async () => {
    const out = (await ex().query_metric?.(series('day', '2026-03-03', '2026-10-18'))) as Out;
    expect(out.dimension).toBe('week');
    expect(out.meta?.caveats[0]).toMatch(/^Shown by week: by day would be 230 points/);
  });

  it('by day over a short range stays by day', async () => {
    const out = (await ex().query_metric?.(series('day', '2026-10-01', '2026-10-18'))) as Out;
    expect(out.dimension).toBe('day');
    expect(out.rows).toHaveLength(18);
  });
});
