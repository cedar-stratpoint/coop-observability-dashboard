import {describe, expect, it, vi} from 'vitest';
import {createCrmClient, CrmError} from '../src/chat/crm/client';
import {crmHealth, crmReason} from '../src/chat/crm/health';
import {createExecutors} from '../src/chat/tool-executors';
import type {DigestSource} from '../src/chat/digest-lookup';
import {dailyRowsToDigests, type DailySalesRow} from '../src/daily-sales-digests';
import {dedupeReruns, sameWindow, windowOf} from '../src/digest-windows';
import {rollupChannels} from '../src/period-rollup';
import {goldenData} from './support/golden-cases';
import {SEPTEMBER_ROWS} from './support/channel-report-fixture';

// Staging live test 2026-10-23: the answers called imported daily facts "weekly digests", and the Website row said "could not be read" with no reason.

const ph = (day: string): string => new Date(Date.parse(`${day}T00:00:00+08:00`)).toISOString();
const rows = (channel: 'shopee' | 'lazada'): DailySalesRow[] =>
  ['2026-10-05', '2026-10-06', '2026-10-07'].map((day) => ({day, channel, revenue: 100, orders: 1, units: 2, window_from: ph('2026-10-05'), window_to: ph('2026-10-08'), captured_at: '2026-10-20T01:00:00Z'}));
const notesFor = (channel: 'shopee' | 'lazada', digests: Parameters<typeof rollupChannels>[0]['digests'], from: string, to: string): string[] =>
  rollupChannels({fromDay: from, toDay: to, channels: [channel], granularity: 'total', digests, website: null, offline: null})[0].channels[0].notes;

describe('source labels tell the truth', () => {
  it('figures from saved per-day rows say so, name the real source, and never say "from digests"', () => {
    const shopee = notesFor('shopee', dailyRowsToDigests(rows('shopee')), '2026-10-05', '2026-10-07').join('\n');
    expect(shopee).toMatch(/saved daily rows \(imported from the Shopee exports\)/);
    expect(shopee).not.toMatch(/from digests/);
    const lazada = notesFor('lazada', dailyRowsToDigests(rows('lazada')), '2026-10-05', '2026-10-07').join('\n');
    expect(lazada).toMatch(/saved daily rows \(imported from the Lazada API\)/);
    expect(lazada).not.toMatch(/from digests/);
  });
  it('figures from published digests still say digests', () => {
    const text = notesFor('shopee', SEPTEMBER_ROWS, '2026-09-01', '2026-09-27').join('\n');
    expect(text).toMatch(/per-day sales from digests/);
    expect(text).not.toMatch(/saved daily rows/);
  });
});

const NOW = new Date('2026-10-07T04:00:00Z');
const ASK = {from: '2026-09-01', to: '2026-09-30', channels: ['website'], granularity: 'total'};
const sept = (): DigestSource => ({
  source: 'live', rows: SEPTEMBER_ROWS.slice(0, 2), index: dedupeReruns(SEPTEMBER_ROWS.map(windowOf), (w) => w),
  rowAt: async (w) => SEPTEMBER_ROWS.find((r) => sameWindow(windowOf(r), w)) ?? null,
});
const websiteNote = async (err: unknown): Promise<string> => {
  const ex = createExecutors({data: async () => goldenData(), now: NOW, user: null, digest: async () => sept(), crmOrders: async () => { throw err; }});
  const r = (await ex.get_channel_report?.(ASK)) as {meta: {checks: {text: string}[]}};
  return r.meta.checks.map((c) => c.text).join('\n');
};

describe('the Website row says why the CRM read failed (safe class only)', () => {
  it.each([
    ['upstream_error', /Reason: the CRM answered with an error \(check CRM_API_READ_TOKEN/],
    ['too_large', /Reason: the CRM response was over the size cap/],
    ['timeout', /Reason: the CRM did not answer in time/],
    ['unreachable', /Reason: the CRM could not be reached/],
  ] as const)('%s', async (code, re) => {
    const text = await websiteNote(new CrmError(code));
    expect(text).toMatch(/Website: the CRM could not be read right now; no website figures\./);
    expect(text).toMatch(re);
  });
  it('an unknown error shows no upstream text (it may hold a URL or a token)', async () => {
    const text = await websiteNote(new Error('GET https://crm.example/api/orders token=secret123 failed'));
    expect(text).toMatch(/Reason: an unknown error/);
    expect(text).not.toMatch(/secret123|crm\.example/);
  });
  it('crmReason maps every client code to a sentence', () => {
    for (const c of ['refused', 'call_cap', 'timeout', 'unreachable', 'upstream_error', 'too_large', 'bad_shape'] as const) expect(crmReason(new CrmError(c)).length).toBeGreaterThan(10);
  });
});

const fakeFetch = (status: number, body: unknown = {}) => vi.fn(async () => new Response(JSON.stringify(body), {status})) as unknown as typeof fetch;

describe('crmHealth (for /api/chat/health)', () => {
  it('not configured: says so and probes nothing', async () => {
    const h = await crmHealth({});
    expect(h).toMatchObject({enabled: false, reason: 'not_configured', probes: []});
    expect(h.CRM_API_URL.set).toBe(false);
  });
  it('configured: env facts carry the host and lengths only, and one probe per endpoint reports ok and bytes', async () => {
    const f = fakeFetch(200, {orders: []});
    const h = await crmHealth({CRM_API_URL: 'https://crm.example/base', CRM_API_READ_TOKEN: 'tok-secret-123'}, {fetch: f});
    expect(h.enabled).toBe(true);
    expect(h.CRM_API_URL).toMatchObject({set: true, host: 'crm.example'});
    expect(h.CRM_API_READ_TOKEN).toMatchObject({set: true, length: 14});
    expect(h.probes.map((p) => [p.endpoint, p.ok])).toEqual([['metrics', true], ['orders', true]]);
    expect(h.probes[1].bytes).toBeGreaterThan(0);
    const dump = JSON.stringify(h);
    expect(dump).not.toMatch(/tok-secret-123|\/base|\/api\//); // never the token or any path
  });
  it('a 401 from the CRM shows the safe reason class, not the upstream text', async () => {
    const h = await crmHealth({CRM_API_URL: 'https://crm.example', CRM_API_READ_TOKEN: 'tok'}, {fetch: fakeFetch(401, {error: 'Unauthorized internal detail'})});
    expect(h.probes.every((p) => !p.ok)).toBe(true);
    expect(h.probes[0].reason).toMatch(/CRM_API_READ_TOKEN/);
    expect(JSON.stringify(h)).not.toMatch(/internal detail/);
  });
  it('a response over the size cap is reported as such (the likeliest failure on a busy store)', async () => {
    const big = vi.fn(async () => new Response('x'.repeat(10), {status: 200, headers: {'content-length': '9000000'}})) as unknown as typeof fetch;
    const h = await crmHealth({CRM_API_URL: 'https://crm.example', CRM_API_READ_TOKEN: 'tok'}, {fetch: big});
    expect(h.probes[0].reason).toMatch(/size cap/);
  });
});
