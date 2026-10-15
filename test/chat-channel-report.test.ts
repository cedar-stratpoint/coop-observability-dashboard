import {describe, expect, it, vi} from 'vitest';
import {readReportInput, shapeChannelReport} from '../src/chat/channel-report';
import {createCrmClient} from '../src/chat/crm/client';
import {websiteOrdersForReport} from '../src/chat/crm/executors';
import {dispatchToolCall} from '../src/chat/tools';
import {createExecutors} from '../src/chat/tool-executors';
import type {DigestSource} from '../src/chat/digest-lookup';
import {manilaDayKey} from '../src/pos-sales-compute';
import {dedupeReruns, sameWindow, windowOf} from '../src/digest-windows';
import {goldenData} from './support/golden-cases';
import {runScripted} from './support/scripted-model';
import {SEPTEMBER_EXPECTED, SEPTEMBER_ROWS} from './support/channel-report-fixture';

const NOW = new Date('2026-10-07T04:00:00Z');
const sept = (): DigestSource => ({
  source: 'live', rows: SEPTEMBER_ROWS.slice(0, 2), index: dedupeReruns(SEPTEMBER_ROWS.map(windowOf), (w) => w),
  rowAt: async (w) => SEPTEMBER_ROWS.find((r) => sameWindow(windowOf(r), w)) ?? null,
});
const ASK = {from: '2026-09-01', to: '2026-09-30', channels: ['all'], granularity: 'total'};

describe('get_channel_report input', () => {
  it('asks for the owner\'s dates instead of picking any', () => {
    const e = readReportInput({...ASK, from: '', to: ''});
    expect('error' in e && e.error).toMatch(/needs the owner's dates/);
    expect('error' in e && e.error).toMatch(/Do not pick dates yourself/);
  });
  it('refuses dates that are not real (Sep 31, month 13) with an honest error, never a roll-over or a throw', () => {
    for (const bad of [{from: '2026-09-31'}, {to: '2026-09-31'}, {from: '2026-13-01'}, {to: '2026-02-30'}]) {
      const e = readReportInput({...ASK, ...bad});
      expect('error' in e && e.error).toMatch(/is not a real date; ask the owner for the dates again/);
    }
    expect('error' in readReportInput({...ASK, from: '2024-02-29', to: '2024-03-01'})).toBe(false);
  });
  it('refuses reversed dates, unknown channels or granularity, and too many buckets', () => {
    expect('error' in readReportInput({...ASK, from: '2026-10-01'})).toBe(true);
    expect('error' in readReportInput({...ASK, channels: ['tiktok']})).toBe(true);
    expect('error' in readReportInput({...ASK, channels: []})).toBe(true);
    expect('error' in readReportInput({...ASK, granularity: 'day'})).toBe(true);
    expect('error' in readReportInput({...ASK, from: '2026-01-01', to: '2026-12-31', granularity: 'week'})).toBe(true);
  });
  it('"all" expands to the four channels in a fixed order', () => {
    expect(readReportInput(ASK)).toEqual({from: '2026-09-01', to: '2026-09-30', channels: ['shopee', 'lazada', 'website', 'offline'], granularity: 'total'});
  });
});

describe('golden: "Give me the September report per channel" (A8, offline replay)', () => {
  it('one row per channel, sums equal the hand-computed reference, AOV recomputed, coverage notes before any figure', async () => {
    const data = goldenData();
    const r = await runScripted({
      script: [
        {calls: [{name: 'get_channel_report', input: ASK}]},
        {text: 'Website is not connected, so it has no figure; Shopee and Lazada come from the stored digests.', calls: [{name: 'render_chart', input: {block: 'new', source: 'r1', kind: 'auto', orientation: 'auto', x: 'auto', y: ['auto'], title: 'Revenue by channel, September 2026'}}]},
        {text: 'September 2026 per channel.'},
      ],
      messages: [{role: 'user', content: 'Give me the September report per channel'}], data, now: NOW, digest: sept(),
    });
    expect(r.results[0].is_error).toBe(false);
    const out = r.results[0].content as {rows: Record<string, unknown>[]; meta: {checks: {status: string; text: string}[]; coverage: string}};
    expect(out.rows.map((x) => x.channel)).toEqual(['Shopee', 'Lazada', 'Website', 'Offline']);
    expect(out.rows[0]).toEqual({channel: 'Shopee', ...SEPTEMBER_EXPECTED.shopee});
    expect(out.rows[1]).toEqual({channel: 'Lazada', ...SEPTEMBER_EXPECTED.lazada});
    expect(out.rows[2]).toEqual({channel: 'Website', revenue: null, orders: null, units: null, aov: null});
    const sep = data.orders.filter((o) => o.status !== 'voided' && manilaDayKey(o.created_at).startsWith('2026-09'));
    const revenue = Math.round(sep.reduce((s, o) => s + o.total, 0) * 100) / 100;
    expect(out.rows[3]).toMatchObject({channel: 'Offline', revenue, orders: sep.length});
    const text = out.meta.checks.map((c) => c.text).join('\n');
    expect(text).toMatch(/newest digest wins per day/);
    expect(text).toMatch(/Website: the website CRM is not connected/);
    expect(text).not.toMatch(/Sep 15/); // a covered zero-sales day is not a gap
    expect(out.meta.coverage).toBe('partial');
    expect(r.blocks.map((b) => b.kind)).toEqual(['chart']);
  });
  it('autoRender draws a channel report no block was bound from (chart first, table twin); a one-row report is not drawn', async () => {
    const blocks: {kind: string}[] = [];
    const ex = createExecutors({data: async () => goldenData(), now: NOW, user: null, digest: async () => sept(), emitBlock: (b) => blocks.push(b)});
    await ex.get_channel_report?.(ASK);
    expect((await ex.autoRender?.())?.length).toBeGreaterThan(0);
    expect(blocks.map((b) => b.kind)).toEqual(['chart']);
    expect((await ex.autoRender?.())).toEqual([]); // already bound: never twice
    const one: {kind: string}[] = [];
    const ex1 = createExecutors({data: async () => goldenData(), now: NOW, user: null, digest: async () => sept(), emitBlock: (b) => one.push(b)});
    await ex1.get_channel_report?.({...ASK, channels: ['shopee']});
    expect(await ex1.autoRender?.()).toEqual([]);
    expect(one).toEqual([]);
  });
  it('Website comes from the CRM orders when connected', async () => {
    const ex = createExecutors({
      data: async () => goldenData(), now: NOW, user: null, digest: async () => sept(),
      crmOrders: async () => ({orders: [{createdAt: '2026-09-30T15:59:00Z', totalPrice: '1000', lineItems: JSON.stringify([{title: 'A', quantity: 2, price: 500}])}, {createdAt: '2026-09-30T16:00:00Z', totalPrice: '700'}], asOf: '2026-10-07T04:00:00Z'}),
    });
    const r = (await ex.get_channel_report?.(ASK)) as {rows: Record<string, unknown>[]};
    expect(r.rows[2]).toEqual({channel: 'Website', revenue: 1000, orders: 1, units: 2, aov: 1000});
  });
  it('Train 4: the Website row reads the GET-only CRM client and logs one chat_crm_call line', async () => {
    const info = vi.fn();
    const body = {orders: [{shopifyOrderId: 1, createdAt: '2026-09-30T15:59:00Z', totalPrice: '1000', lineItems: JSON.stringify([{title: 'A', quantity: 2, price: 500}])}, {shopifyOrderId: 2, createdAt: '2026-09-30T16:00:00Z', totalPrice: '700'}]};
    const fetch = (async () => new Response(JSON.stringify(body), {status: 200})) as typeof globalThis.fetch;
    const crm = createCrmClient({baseUrl: 'https://crm.example', token: 'tok', fetch});
    const ex = createExecutors({data: async () => goldenData(), now: NOW, user: null, digest: async () => sept(), crmOrders: () => websiteOrdersForReport({client: crm, user: null, sink: {info, error: vi.fn()}})});
    const r = (await ex.get_channel_report?.(ASK)) as {rows: Record<string, unknown>[]};
    expect(r.rows[2]).toEqual({channel: 'Website', revenue: 1000, orders: 1, units: 2, aov: 1000});
    expect(JSON.parse(info.mock.calls[0][0] as string)).toMatchObject({event: 'chat_crm_call', tool: 'get_channel_report', endpoints: ['orders'], ok: true, rows: 2});
    // Parity: the same orders through the injected function give the same notes and checks, not only the same row.
    vi.useFakeTimers({toFake: ['Date']});
    vi.setSystemTime(NOW);
    const same = createExecutors({data: async () => goldenData(), now: NOW, user: null, digest: async () => sept(), crmOrders: async () => ({orders: body.orders as never, asOf: '2026-10-07T04:00:00Z'})});
    const crm2 = createExecutors({data: async () => goldenData(), now: NOW, user: null, digest: async () => sept(), crmOrders: () => websiteOrdersForReport({client: crm, user: null, sink: {info: vi.fn(), error: vi.fn()}})});
    const r2 = (await same.get_channel_report?.(ASK)) as {meta: {checks: unknown[]; caveats: unknown[]}};
    const r3 = (await crm2.get_channel_report?.(ASK)) as typeof r2;
    vi.useRealTimers();
    expect(r3.meta.checks).toEqual(r2.meta.checks);
    expect(r3.meta.caveats).toEqual(r2.meta.caveats);
  });

  it('Train 4: an unreachable CRM says "could not be read", never "no orders" (Review Focus 3)', async () => {
    const fetch = (async () => { throw new TypeError('fetch failed'); }) as typeof globalThis.fetch;
    const crm = createCrmClient({baseUrl: 'https://crm.example', token: 'tok', fetch});
    const ex = createExecutors({data: async () => goldenData(), now: NOW, user: null, digest: async () => sept(), crmOrders: () => websiteOrdersForReport({client: crm, user: null, sink: {info: vi.fn(), error: vi.fn()}})});
    const r = (await ex.get_channel_report?.(ASK)) as {rows: Record<string, unknown>[]; meta: {checks: {text: string}[]}};
    expect(r.rows[2]).toEqual({channel: 'Website', revenue: null, orders: null, units: null, aov: null});
    expect(r.meta.checks.map((c) => c.text).join('\n')).toMatch(/Website: the CRM could not be read right now; no website figures\./);
  });

  it('a CRM read that throws says the CRM could not be read, not "live orders as of" or zero sales', async () => {
    const ex = createExecutors({data: async () => goldenData(), now: NOW, user: null, digest: async () => sept(), crmOrders: async () => { throw new Error('boom'); }});
    const r = (await ex.get_channel_report?.(ASK)) as {rows: Record<string, unknown>[]; meta: {checks: {text: string}[]}};
    expect(r.rows[2]).toEqual({channel: 'Website', revenue: null, orders: null, units: null, aov: null});
    const text = r.meta.checks.map((c) => c.text).join('\n');
    expect(text).toMatch(/Website: the CRM could not be read right now; no website figures\./);
    expect(text).not.toMatch(/live CRM orders as of/);
    expect(text).not.toMatch(/not connected/);
  });
  it('by week: one row per week (Monday start, clipped), one revenue column per channel', () => {
    const res = shapeChannelReport({from: '2026-09-01', to: '2026-09-30', channels: ['shopee', 'lazada'], granularity: 'week'}, {digests: SEPTEMBER_ROWS, mock: false, website: null, data: null});
    expect(res.columns.map((c) => [c.key, c.role, c.unit])).toEqual([['period', 'time', 'date'], ['shopee', 'measure', 'PHP'], ['lazada', 'measure', 'PHP']]);
    expect(res.rows.map((x) => x.period)).toEqual(['2026-09-01', '2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28']);
    expect(res.rows[3]).toEqual({period: '2026-09-21', shopee: 8400, lazada: 11200});
  });
  it('a refusal is flagged is_error through dispatch; the result holds no free text from the data', async () => {
    const ex = createExecutors({data: async () => goldenData(), now: NOW, user: null, digest: async () => sept()});
    expect((await dispatchToolCall({name: 'get_channel_report', input: {...ASK, from: ''}}, ex)).is_error).toBe(true);
    const ok = (await ex.get_channel_report?.(ASK)) as {rows: Record<string, unknown>[]};
    for (const row of ok.rows) for (const [k, v] of Object.entries(row)) if (k !== 'channel') expect(v === null || typeof v === 'number').toBe(true);
  });
});
