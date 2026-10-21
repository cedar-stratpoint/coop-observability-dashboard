import {describe, expect, it, vi} from 'vitest';
import {readDailyDigests, readDailyRows, DAILY_PAGE, type DailyReadClient} from '../src/chat/read/daily';
import {DAILY_COLUMNS, dailyRelationForMode} from '../src/chat/read/relations';
import {createGuardedFetch} from '../src/chat/read/guarded-fetch';
import {createExecutors} from '../src/chat/tool-executors';
import type {DigestSource} from '../src/chat/digest-lookup';
import {goldenData} from './support/golden-cases';
import {SEPTEMBER_ROWS} from './support/channel-report-fixture';

type Call = {relation: string; columns: string; range?: [number, number]; order?: [string, unknown]};
function fake(pages: unknown[][], error: {message: string} | null = null) {
  const calls: Call[] = [];
  const client = {
    from: (relation: string) => ({
      select: (columns: string) => {
        const call: Call = {relation, columns};
        calls.push(call);
        const b = {
          order: (c: string, o?: {ascending?: boolean}) => ((call.order = [c, o?.ascending]), b),
          range: (a: number, z: number) => ((call.range = [a, z]), b),
          then: (ok: (v: {data: unknown[] | null; error: {message: string} | null}) => unknown) => Promise.resolve({data: error ? null : (pages[calls.length - 1] ?? []), error}).then(ok),
        };
        return b;
      },
    }),
  };
  return {client: client as unknown as DailyReadClient, calls};
}
const row = (day: string, channel = 'shopee', win: [string, string] = ['2026-10-11T16:00:00Z', '2026-10-18T16:00:00Z']) => ({day, channel, revenue: '100.50', orders: 2, units: 3, window_from: win[0], window_to: win[1], captured_at: '2026-10-19T01:00:00Z'});

describe('the chat daily sales read', () => {
  it('reads only the allowed columns of the daily relation, oldest day first, and turns strings into numbers', async () => {
    const {client, calls} = fake([[row('2026-10-12'), row('2026-10-13', 'lazada')]]);
    const rows = await readDailyRows(client, 'guarded_service');
    expect(rows[0]).toMatchObject({day: '2026-10-12', channel: 'shopee', revenue: 100.5, orders: 2, units: 3});
    expect(calls[0]).toMatchObject({relation: 'marketplace_daily_sales', columns: DAILY_COLUMNS, order: ['day', true], range: [0, DAILY_PAGE - 1]});
    expect(DAILY_COLUMNS).toBe('day,channel,revenue,orders,units,window_from,window_to,captured_at');
    expect(dailyRelationForMode('ro_role')).toBe('coop_chat_marketplace_daily');
  });
  it('pages until a short page, and drops a row it cannot use instead of guessing', async () => {
    const full = Array.from({length: DAILY_PAGE}, (_, i) => row(`2026-01-${String((i % 28) + 1).padStart(2, '0')}`));
    const {client, calls} = fake([full, [row('2026-10-12'), {day: '2026-10-13', channel: 'ebay'}]]);
    const rows = await readDailyRows(client, 'ro_role');
    expect(calls).toHaveLength(2);
    expect(calls[1].range).toEqual([DAILY_PAGE, 2 * DAILY_PAGE - 1]);
    expect(rows).toHaveLength(DAILY_PAGE + 1);
  });
  it('throws on a read error (the server turns that into "no rows")', async () => {
    await expect(readDailyRows(fake([], {message: 'boom'}).client, 'ro_role')).rejects.toThrow(/daily sales read failed: boom/);
  });
  it('gives digests carrying daily, one per run window', async () => {
    const out = await readDailyDigests(fake([[row('2026-10-12'), row('2026-10-13')]]).client, 'guarded_service');
    expect(out).toHaveLength(1);
    expect(out[0].digest.daily?.shopee).toHaveLength(2);
  });
});

describe('the guard for the daily client', () => {
  const guard = (mode: 'ro_role' | 'guarded_service') => createGuardedFetch({baseUrl: 'https://x.example', relations: [dailyRelationForMode(mode)], underlying: vi.fn(async () => new Response('[]')) as never});
  it('allows the daily relation and refuses the digest table, a POS table, a write and a forbidden column', async () => {
    const {fetch: f} = guard('guarded_service');
    await expect(f('https://x.example/rest/v1/marketplace_daily_sales?select=day,channel')).resolves.toBeInstanceOf(Response);
    await expect(f('https://x.example/rest/v1/digest_archive?select=digest')).rejects.toThrow();
    await expect(f('https://x.example/rest/v1/pos_orders?select=id')).rejects.toThrow();
    await expect(f('https://x.example/rest/v1/marketplace_daily_sales', {method: 'POST'})).rejects.toThrow();
  });
});

describe('get_channel_report with the saved per-day rows', () => {
  // The August window has only whole-window totals, so a custom span in it cannot be cut by day.
  const src = (): DigestSource => ({source: 'live', rows: SEPTEMBER_ROWS.slice(3, 4), index: [], rowAt: async () => null});
  const ASK = {from: '2026-08-05', to: '2026-08-07', channels: ['shopee'], granularity: 'total'};
  it('without rows the span is not combinable; with the rows it sums exactly', async () => {
    const without = createExecutors({data: async () => goldenData(), now: new Date('2026-10-07T04:00:00Z'), user: null, digest: async () => src()});
    const r0 = (await without.get_channel_report?.(ASK)) as {rows: Record<string, unknown>[]};
    expect(r0.rows[0].revenue).toBeNull();

    const daily = async () => (await readDailyDigests(fake([['2026-08-05', '2026-08-06', '2026-08-07'].map((d) => row(d, 'shopee', ['2026-08-04T16:00:00Z', '2026-08-07T16:00:00Z']))]).client, 'guarded_service'));
    const withRows = createExecutors({data: async () => goldenData(), now: new Date('2026-10-07T04:00:00Z'), user: null, digest: async () => src(), daily});
    const r1 = (await withRows.get_channel_report?.(ASK)) as {rows: Record<string, unknown>[]};
    expect(r1.rows[0]).toMatchObject({channel: 'Shopee', revenue: 301.5, orders: 6, units: 9});
  });
  it('a failing daily read never breaks the report', async () => {
    const ex = createExecutors({data: async () => goldenData(), now: new Date('2026-10-07T04:00:00Z'), user: null, digest: async () => src(), daily: async () => { throw new Error('down'); }});
    const r = (await ex.get_channel_report?.(ASK)) as {rows: Record<string, unknown>[]};
    expect(r.rows[0].channel).toBe('Shopee');
  });
});
