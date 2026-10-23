import {afterEach, describe, expect, it, vi} from 'vitest';
import {createCrmClient, CrmError} from '../src/chat/crm/client';
import {crmReason} from '../src/chat/crm/health';
import {describeCrmEnv, resolveCrmAccess} from '../src/chat/crm/config';
import {dailyRowsToDigests, type DailySalesRow} from '../src/daily-sales-digests';
import {rollupChannels, type RollupDigest} from '../src/period-rollup';
import {shapeChannelReport} from '../src/chat/channel-report';
import {SEPTEMBER_ROWS} from './support/channel-report-fixture';

// Staging re-test 2026-10-23 (after #254): the per-channel line still said "from digests" for figures that come from the imported daily rows,
// and the staging CRM probes failed with no hint why. Synthetic data only.

const ph = (day: string): string => new Date(Date.parse(`${day}T00:00:00+08:00`)).toISOString();
const dayRows = (from: string, to: string): DailySalesRow[] => {
  const out: DailySalesRow[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) {
    const day = new Date(t).toISOString().slice(0, 10);
    out.push({day, channel: 'shopee', revenue: 100, orders: 1, units: 2, window_from: ph(from), window_to: ph(new Date(Date.parse(`${to}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)), captured_at: '2026-10-22T06:00:00.000Z'});
  }
  return out;
};
const shopeeNotes = (digests: RollupDigest[], from: string, to: string): string => rollupChannels({fromDay: from, toDay: to, channels: ['shopee'], granularity: 'total', digests, website: null, offline: null})[0].channels[0].notes.join('\n');

describe('the per-channel source line names where the per-day figures came from', () => {
  it('all from saved daily rows', () => {
    const t = shopeeNotes(dailyRowsToDigests(dayRows('2026-10-05', '2026-10-11')), '2026-10-05', '2026-10-11');
    expect(t).toMatch(/per-day sales from saved daily rows/);
    expect(t).not.toMatch(/from digests/);
  });
  it('all from published digests', () => {
    const t = shopeeNotes(SEPTEMBER_ROWS, '2026-09-21', '2026-09-27');
    expect(t).toMatch(/per-day sales from digests/);
    expect(t).not.toMatch(/saved daily rows/);
  });
  it('a mix says both lines', () => {
    const rows = dailyRowsToDigests(dayRows('2026-10-05', '2026-10-11')); // newest run for those days
    const t = shopeeNotes([...SEPTEMBER_ROWS, ...rows], '2026-09-21', '2026-10-11');
    expect(t).toMatch(/saved daily rows/);
    expect(t).toMatch(/digests/);
  });
  it('through the tool result: the sources line of get_channel_report reads right', () => {
    const r = shapeChannelReport({from: '2026-10-05', to: '2026-10-11', channels: ['shopee'], granularity: 'total'}, {digests: dailyRowsToDigests(dayRows('2026-10-05', '2026-10-11')), website: null, data: null} as never);
    const text = JSON.stringify(r);
    expect(text).toMatch(/saved daily rows/);
    expect(text).not.toMatch(/per-day sales from digests/);
  });
});

describe('the CRM env paste mistake', () => {
  const env = {CRM_API_URL: 'https://crm.example.workers.dev \n', CRM_API_READ_TOKEN: 'tok-123\n'};
  it('the chat client builds a clean URL and a clean header from a value with a trailing space or newline', async () => {
    const access = resolveCrmAccess(env);
    expect(access.enabled).toBe(true);
    if (!access.enabled) return;
    const calls: {url: string; auth: string | null}[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      calls.push({url: String(url), auth: new Headers(init.headers).get('authorization')});
      return new Response('{}', {status: 200});
    }) as unknown as typeof fetch;
    await createCrmClient({baseUrl: access.baseUrl, token: access.token, fetch: fake}).get('metrics');
    expect(calls[0].url).toBe('https://crm.example.workers.dev/api/metrics');
    expect(calls[0].auth).toBe('Bearer tok-123');
  });
  it('health still reports the paste mistake and says the code trims it, never the value', () => {
    const d = describeCrmEnv(env);
    expect(d.CRM_API_URL).toMatchObject({set: true, hasEdgeWhitespace: true, trimmedByCode: true, host: 'crm.example.workers.dev'});
    expect(JSON.stringify(d)).not.toContain('tok-123');
  });
  it('the pages reader (src/crm-data.ts) trims the same way', async () => {
    vi.resetModules();
    vi.stubEnv('CRM_API_URL', env.CRM_API_URL);
    vi.stubEnv('CRM_API_READ_TOKEN', env.CRM_API_READ_TOKEN);
    vi.doMock('server-only', () => ({}));
    vi.doMock('next/cache', () => ({unstable_cache: (fn: unknown) => fn}));
    vi.doMock('react', () => ({cache: (fn: unknown) => fn}));
    const calls: {url: string; auth: string | null}[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({url: String(url), auth: new Headers(init.headers).get('authorization')});
      return new Response(JSON.stringify({leads: []}), {status: 200});
    });
    const mod = await import('../src/crm-data');
    expect(mod.crmConfigured()).toBe(true);
    await mod.fetchCrmSpinLeads();
    expect(calls[0].url).toBe('https://crm.example.workers.dev/api/spin-leads');
    expect(calls[0].auth).toBe('Bearer tok-123');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.doUnmock('server-only');
    vi.doUnmock('next/cache');
    vi.doUnmock('react');
  });
});

describe('the CRM failure reason says which kind of error, with the HTTP status', () => {
  it.each([
    [401, /refused the token \(HTTP 401\).*CRM_API_READ_TOKEN/],
    [403, /refused the token \(HTTP 403\)/],
    [404, /no such endpoint \(HTTP 404\).*right worker/],
    [500, /error of its own \(HTTP 500\)/],
    [418, /HTTP 418/],
  ])('HTTP %i', async (status, re) => {
    const fake = (async () => new Response('secret upstream text', {status})) as unknown as typeof fetch;
    const err = await createCrmClient({baseUrl: 'https://crm.example.workers.dev', token: 't', fetch: fake}).get('metrics').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CrmError);
    expect(crmReason(err)).toMatch(re);
    expect(crmReason(err)).not.toMatch(/secret upstream text|crm\.example/);
  });
  it('other failures keep their old wording and an unknown error stays generic', () => {
    expect(crmReason(new CrmError('timeout'))).toMatch(/did not answer in time/);
    expect(crmReason(new Error('https://host/path?token=abc'))).toBe('an unknown error');
  });
});
