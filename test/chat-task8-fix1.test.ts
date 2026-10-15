// Train 3 Task 8 fix round 1: one rule per behaviour (stock has no period, test orders have no marker, one stock default),
// Manila time on the stock caveat, parallel stock read, basis notes for mixed queries, one "completed" predicate.
import {readFileSync} from 'node:fs';
import {describe, expect, it, vi} from 'vitest';
vi.mock('server-only', () => ({}));
import {buildLiveContextBlock} from '../src/chat/context';
import {tableBasisNotes} from '../src/chat/explore/basis';
import {loadMetricData} from '../src/chat/read/metric-data';
import {runMetric} from '../src/chat/query-metric';
import {buildCoverage} from '../src/chat/coverage';
import {isCompletedOrder} from '../src/chat/order-status';
import type {MetricData, MetricResult, StockData} from '../src/chat/result-types';
import type {ReadClient} from '../src/pos-orders-read';

const SKILL = readFileSync('src/chat/skills/ask-coop-data-analyst/SKILL.md', 'utf8');
const EXPLORE = readFileSync('src/chat/skills/ask-coop-data-analyst/topics/sql-explore.md', 'utf8');

describe('F1 stock needs no period (one rule, every place that says "ask which dates")', () => {
  it('both THINK-01 variants own the stock exception; every Period block points to THINK-01 instead of restating it (final review finding 11)', () => {
    const think = SKILL.split('\n').filter((l) => l.startsWith('[THINK-01]'));
    expect(think).toHaveLength(2);
    for (const l of think) expect(l).toMatch(/stock[^.]*as of now[^.]*no period/i);
    for (const explore of [true, false]) {
      for (const website of [true, false]) {
        const block = buildLiveContextBlock({explore, website});
        expect(block).not.toMatch(/as of now/i);
        expect(block).toMatch(/except where THINK-01 says otherwise \(stock\)/);
      }
    }
  });
});

describe('F4 test orders: no marker exists, nothing claims they are excluded', () => {
  it('EXP-05 says plainly that test orders cannot be separated and completed means status only', () => {
    const exp05 = EXPLORE.split('\n').find((l) => l.startsWith('[EXP-05'))!;
    expect(exp05).toMatch(/no test-order marker/i);
    expect(exp05).toMatch(/status only/i);
    expect(exp05).not.toMatch(/voided or test/i);
    expect(EXPLORE.split('\n').find((l) => l.startsWith('[EXP-10]'))).not.toMatch(/\btest\b/i);
  });
  it('the catalog texts do not promise a test-order exclusion', () => {
    const catalog = readFileSync('src/chat/catalog/catalog.json', 'utf8');
    expect(catalog).not.toMatch(/not test orders, if a marker exists/);
    expect(catalog).not.toMatch(/voided or test rows/);
  });
});

describe('F5 the stock default is stated once', () => {
  it('EXP-06 Stock bullet points to the data index instead of restating the default view', () => {
    const bullet = EXPLORE.split('\n').find((l) => l.startsWith('- Stock:'))!;
    expect(bullet).toMatch(/data index/i);
    expect(bullet).not.toMatch(/coop_explore_stock_event/);
  });
});

const NOW = new Date('2026-09-28T04:00:00Z'); // 12:00 PHT
const stock: StockData = {
  byLocation: [{product_id: 'P1', location: 'event', stock: 12}],
  names: {P1: 'Chicken Jerky'}, sales: [],
  config: {threshold: 5, thresholdOverrides: {}, targetCoverEventDays: 6, leadTimeDays: 3, earlyWarningEvents: 3, eventWeekdays: [5, 6, 0]},
  asOf: NOW.toISOString(),
};
describe('F6 the stock caveat time is Philippine time', () => {
  it('shows 12:00 PHT, not 04:00 UTC', () => {
    const data: MetricData = {source: 'live', orders: [], events: [], prices: [], priceChanges: [], bulkReads: [], stock};
    const r = runMetric({metric: 'stock_on_hand', dimension: 'sellable', measure: 'default', range: 'all_available', from: '', to: '', channel: 'offline', event: 'all', pet: 'all', compare_to: 'none', sort: 'default', limit: 25}, data, NOW) as MetricResult;
    const c = r.meta.caveats.join(' ');
    expect(c).toMatch(/2026-09-28 12:00 PHT/);
    expect(c).not.toMatch(/UTC/);
  });
});

describe('F7 the stock read runs alongside the other reads, not after them', () => {
  it('the first stock read starts before the orders read has finished', async () => {
    const log: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const client: ReadClient = {
      from(relation) {
        return {
          select() {
            log.push(`start ${relation}`);
            const b = {
              order: () => b, range: () => b, eq: () => b, gte: () => b, limit: () => b,
              then: <R1, R2>(ok?: (v: {data: never[]; error: null}) => R1, no?: (e: unknown) => R2) =>
                (relation === 'coop_chat_orders' ? gate : Promise.resolve()).then(() => ({data: [], error: null as null})).then(ok, no),
            };
            return b as never;
          },
        };
      },
    };
    const p = loadMetricData(client, 'ro_role');
    await new Promise((r) => setTimeout(r, 20));
    expect(log).toContain('start coop_chat_stock_by_location'); // while orders is still pending
    release();
    await p;
  });
});

describe('F8 basis notes for mixed queries and the registry views', () => {
  it('completed + raw orders gets both notes', () => {
    const n = tableBasisNotes(['pos_orders_completed', 'pos_orders']);
    expect(n).toHaveLength(2);
    expect(n.join(' ')).toMatch(/completed orders only/);
    expect(n.join(' ')).toMatch(/all orders/);
  });
  it('coop_chat_* views get a note', () => {
    expect(tableBasisNotes(['coop_chat_orders']).join(' ')).toMatch(/all orders/);
    expect(tableBasisNotes(['coop_chat_stock_by_location'])).toEqual(['Basis: stock per location.']);
  });
});

describe('F10 one definition of completed: the dashboard rule, any status but voided (final review finding 8)', () => {
  it('isCompletedOrder is false only for status voided (a null, empty or unknown status counts, as on the Offline Sales page)', () => {
    expect(isCompletedOrder({status: 'completed'})).toBe(true);
    expect(isCompletedOrder({status: 'voided'})).toBe(false);
    expect(isCompletedOrder({status: ''})).toBe(true);
    expect(isCompletedOrder({status: 'weird'})).toBe(true);
    expect(isCompletedOrder({status: null as unknown as string})).toBe(true);
  });
  it('the registry and the coverage use it: an unknown status is counted, a voided one is not', () => {
    const o = (id: string, status: string) => ({id, status, total: 100, created_at: '2026-09-10T04:00:00Z', event_id: null, pet_type: null, items: [], subtotal: 100, discount: 0, oversold: false, payment_method: 'cash', edited_at: null});
    const data = {source: 'live', orders: [o('1', 'completed'), o('2', 'weird'), o('3', 'voided')], events: [], prices: [], priceChanges: [], bulkReads: [], stock: null} as unknown as MetricData;
    expect(buildCoverage(data).orders).toBe(2);
  });
  it('the pos_orders_completed view uses the same rule (null-safe), and its comment says so', () => {
    const sql = readFileSync('supabase/coop_chat_default_views.sql', 'utf8');
    expect(sql).toMatch(/where o\.status is distinct from 'voided';/);
    expect(sql).not.toMatch(/status = 'completed'/);
  });
});
