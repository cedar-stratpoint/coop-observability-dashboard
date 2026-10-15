import {readdirSync, readFileSync, statSync} from 'node:fs';
import {join} from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';

vi.mock('server-only', () => ({}));

import {shapeDigest, DIGEST_SECTIONS, DIGEST_STALE_DAYS, type DigestSource} from '../src/chat/digest-lookup';
import {chatDigestClient} from '../src/chat/read/client';
import {readDigestRows, type DigestReadClient, type DigestRow} from '../src/chat/read/digest';
import {createGuardedFetch} from '../src/chat/read/guarded-fetch';
import {DIGEST_COLUMNS, digestRelationForMode, relationsForMode} from '../src/chat/read/relations';
import {createExecutors} from '../src/chat/tool-executors';
import {dispatchToolCall} from '../src/chat/tools';
import type {ChatToolContext} from '../src/chat/stream-types';
import type {ChatBlock} from '../src/chat/block-types';
import type {MetricData} from '../src/chat/result-types';
import type {DigestDocument} from '../src/types';
import {dedupeReruns, sameWindow, windowOf} from '../src/digest-windows';
import {SEPTEMBER_ROWS} from './support/channel-report-fixture';

// F10 get_digest (design Slice 5): the digest adapter and its guard, the shaping, and the executor.
const NOW = new Date('2026-09-30T04:00:00Z'); // Philippine time: Sep 30
const QUOTE = 'FICTIONAL verbatim quote about stiff hips';
const BUNDLE_MARKER = 'SHOULD-NEVER-BE-SELECTED';

const doc = (over: Partial<DigestDocument> = {}): DigestDocument => ({
  window: {label: 'week of Sep 21 to 27', from: '2026-09-21T00:00:00.000Z', to: '2026-09-27T23:59:59.000Z'},
  degraded: false,
  headline: 'Lazada and Shopee both grew.',
  themes: [{theme: 'joints', displayName: 'Joint pain', quote: QUOTE, conversationId: 'c-1'}],
  comparison: {
    shopee: {revenue: 18400.5, orders: 41, aov: 448.8, units: 77, adSpend: 3100, roas: 2.9},
    lazada: {revenue: 26250, orders: 52, aov: 504.81, units: 96, adSpend: 4200.25, roas: 3.4},
    website: {revenue: 9120, orders: 14, aov: 651.43, units: 25, adSpend: null, roas: null},
  },
  figures: [
    {label: 'Conversations this week', value: 37, timeBasis: 'window'},
    {label: 'Total conversations (all-time)', value: 412, timeBasis: 'allTime'},
  ],
  recommendations: [],
  sales: {
    headline: 'Steady.',
    figures: [{label: 'Net revenue this week (PHP)', value: 9120, timeBasis: 'window'}, {label: 'Revenue change vs prior week (%)', value: 5, timeBasis: 'window'}],
    topProducts: [{title: 'Joint Support Chews', revenue: 2400}],
    watch: [],
    recommendations: [],
  },
  customers: {
    headline: 'Two new.',
    figures: [{label: 'New customers this week', value: 2, timeBasis: 'window'}],
    outreach: [{name: 'Maria Santos', list: 'vip', canEmail: true, note: 'FICTIONAL outreach note'}],
    recommendations: [],
  },
  shopee: {
    sales: {headline: 'ok', figures: [{label: 'Sales (PHP)', value: 18400.5, timeBasis: 'window'}], recommendations: [], window: {from: '2026-09-21', to: '2026-09-27', label: '21/09/2026 - 27/09/2026'}},
    products: {headline: 'ok', figures: [], recommendations: [], topProducts: [{title: 'Freeze Dried Munchies', revenue: 5200, units: 21}]},
  },
  lazada: {
    sales: {headline: 'ok', figures: [{label: 'Orders', value: 52, timeBasis: 'window'}], recommendations: [], topProducts: [{title: 'Meaty Treats', revenue: 4100, units: 16}]},
  },
  ...over,
});
const row = (d: DigestDocument, from: string, to: string, created = '2026-09-28T01:00:00+00:00'): DigestRow => ({window_from: from, window_to: to, created_at: created, digest: d});
const LATEST = row(doc(), '2026-09-20T16:00:00+00:00', '2026-09-27T16:00:00+00:00');
const PREVIOUS = row(doc({headline: 'Quieter.'}), '2026-09-13T16:00:00+00:00', '2026-09-20T16:00:00+00:00', '2026-09-21T01:00:00+00:00');
const live = (rows: DigestRow[] = [LATEST, PREVIOUS]): DigestSource => ({source: 'live', rows});
const septSource = (): DigestSource => ({
  source: 'live',
  rows: SEPTEMBER_ROWS.slice(0, 3),
  index: dedupeReruns(SEPTEMBER_ROWS.map(windowOf), (w) => w),
  rowAt: async (w) => SEPTEMBER_ROWS.find((r) => sameWindow(windowOf(r), w)) ?? null,
});

type Out = Exclude<ReturnType<typeof shapeDigest>, {error: string}>;
const ok = (input: Record<string, string>, src: DigestSource | null = live(), now = NOW): Out => {
  const out = shapeDigest(input, src, now);
  if ('error' in out) throw new Error(out.error);
  return out;
};

describe('the digest adapter (src/chat/read/digest.ts)', () => {
  function fakeClient(data: unknown[] | null, error: {message: string} | null = null) {
    const calls: {relation: string; columns: string; order?: [string, unknown]; limit?: number}[] = [];
    const client: DigestReadClient = {
      from: (relation) => ({
        select: (columns) => {
          const call: (typeof calls)[number] = {relation, columns};
          calls.push(call);
          const b = {
            order: (c: string, o?: {ascending?: boolean}) => ((call.order = [c, o?.ascending]), b),
            limit: (n: number) => ((call.limit = n), b),
            then: (res: (v: {data: unknown[] | null; error: {message: string} | null}) => unknown) => Promise.resolve({data, error}).then(res),
          };
          return b as never;
        },
      }),
    };
    return {client, calls};
  }

  it('selects only the digest, its window and timestamp, newest first, up to twelve rows, and never bundle or *', async () => {
    const {client, calls} = fakeClient([{...LATEST}]);
    await readDigestRows(client, 'guarded_service');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({relation: 'digest_archive', columns: DIGEST_COLUMNS, order: ['window_to', false], limit: 12});
    expect(DIGEST_COLUMNS).toBe('window_from,window_to,digest,created_at');
    expect(calls[0].columns).not.toMatch(/bundle|\*/);
  });

  it('reads the definer view in ro_role mode and the table in guarded_service mode', () => {
    expect(digestRelationForMode('ro_role')).toBe('coop_chat_digest');
    expect(digestRelationForMode('guarded_service')).toBe('digest_archive');
  });

  it('masks customer names at the seam (outreach names become first name and initial)', async () => {
    const {client} = fakeClient([LATEST]);
    const [r] = await readDigestRows(client, 'ro_role');
    expect(r.digest.customers?.outreach[0].name).toBe('Maria S.');
  });

  it('drops a row it cannot use, and throws on a failed read', async () => {
    const {client} = fakeClient([{window_to: 5, digest: 'x'}, {window_to: '2026-09-27', digest: null}, LATEST]);
    expect(await readDigestRows(client, 'ro_role')).toHaveLength(1);
    await expect(readDigestRows(fakeClient(null, {message: 'boom'}).client, 'ro_role')).rejects.toThrow(/digest read failed: boom/);
  });
});

describe('the guard keeps `bundle` and every other table out of reach (Slice 5 criterion 3)', () => {
  const BASE = 'https://proj.supabase.co';
  const setup = (relations: readonly string[]) => {
    const underlying = vi.fn(async () => new Response('[]', {status: 200})) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
    return {...createGuardedFetch({baseUrl: BASE, relations, underlying}), underlying};
  };
  const url = (rel: string, select: string, extra = '') => `${BASE}/rest/v1/${rel}?select=${select}${extra}`;

  it('allows exactly the four digest columns', async () => {
    const {fetch: f, underlying} = setup(['digest_archive']);
    await f(url('digest_archive', DIGEST_COLUMNS, '&order=window_to.desc&limit=2'));
    expect(underlying).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['select=bundle', 'bundle'],
    ['bundle among columns', 'window_to,digest,bundle'],
    ['aliased bundle', 'b:bundle'],
    ['json path into bundle', 'digest->x,bundle->evidence'],
    ['select=*', '*'],
    ['percent-encoded bundle', '%62undle'],
  ])('blocks %s', async (_n, select) => {
    const {fetch: f, stats, underlying} = setup(['digest_archive']);
    await expect(f(url('digest_archive', select))).rejects.toThrow(/chat read guard/);
    expect(stats.attemptedNonRead).toBe(1);
    expect(underlying).not.toHaveBeenCalled();
  });

  it('blocks filtering or ordering by bundle, and a select that is absent', async () => {
    const {fetch: f, underlying} = setup(['digest_archive']);
    await expect(f(url('digest_archive', DIGEST_COLUMNS, '&order=bundle.asc'))).rejects.toThrow(/forbidden column bundle/);
    await expect(f(url('digest_archive', DIGEST_COLUMNS, '&bundle=ilike.*x*'))).rejects.toThrow(/forbidden column bundle/);
    await expect(f(`${BASE}/rest/v1/digest_archive?limit=2`)).rejects.toThrow(/select is required/);
    expect(underlying).not.toHaveBeenCalled();
  });

  it('keeps the POS reads unaffected (bundle_id and bundle_group are different words) and the digest tables out of the POS allowlist', async () => {
    const pos = setup(relationsForMode('guarded_service').allowed);
    await pos.fetch(url('pos_order_items', 'order_id,product_id,bundle_id,bundle_group,qty,unit_price,line_total'));
    expect(pos.underlying).toHaveBeenCalledTimes(1);
    expect(relationsForMode('guarded_service').allowed).not.toContain('digest_archive');
    expect(relationsForMode('ro_role').allowed).not.toContain('coop_chat_digest');
    await expect(pos.fetch(url('digest_archive', DIGEST_COLUMNS))).rejects.toThrow(/not allowlisted/);
  });

  it('the digest client reaches only its relation: a POS table or a write is refused before any request', async () => {
    const stub = vi.fn(async (_input: unknown) => new Response('[]', {status: 200}));
    vi.stubGlobal('fetch', stub);
    const env = {SUPABASE_URL_ARCHIVE: BASE, SUPABASE_SERVICE_ROLE_KEY_ARCHIVE: 'k'.repeat(40)};
    const {client, stats} = chatDigestClient({mode: 'guarded_service', env});
    // postgrest-js retries a failed GET with backoff (a guard refusal looks like a network error), so switch that off here.
    type Loose = {from(r: string): {select(c: string): {retry(on: boolean): PromiseLike<unknown>}}};
    const loose = client as unknown as Loose;
    const read = (rel: string, cols: string): PromiseLike<unknown> => loose.from(rel).select(cols).retry(false);

    await read('digest_archive', DIGEST_COLUMNS);
    expect(stub).toHaveBeenCalledTimes(1);
    expect(String(stub.mock.calls[0][0])).toContain('/rest/v1/digest_archive?select=window_from%2Cwindow_to%2Cdigest%2Ccreated_at');

    // supabase-js turns the guard's throw into an {error} result: the data never comes back.
    const refusal = async (rel: string, cols: string) => (await read(rel, cols)) as {data: unknown; error: {message: string} | null};
    expect((await refusal('digest_archive', 'window_to,bundle')).error?.message).toMatch(/chat read guard: select references forbidden column bundle/);
    expect((await refusal('pos_orders', 'id,total')).error?.message).toMatch(/chat read guard: relation pos_orders is not allowlisted/);
    expect(stub).toHaveBeenCalledTimes(1);
    expect(stats.attemptedNonRead).toBe(2);
  });

  afterEach(() => vi.unstubAllGlobals());
});

describe('supabase/coop_chat_digest.sql', () => {
  const raw = readFileSync(join(process.cwd(), 'supabase', 'coop_chat_digest.sql'), 'utf8');
  const sql = raw.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').toLowerCase();

  it('is a definer view of exactly the four digest columns, never the bundle', () => {
    expect(sql).toMatch(/create or replace view public\.coop_chat_digest as select window_from, window_to, digest, created_at from public\.digest_archive;/);
    expect(sql).not.toMatch(/bundle|\*|security_invoker/);
    expect(DIGEST_COLUMNS.split(',')).toEqual(['window_from', 'window_to', 'digest', 'created_at']);
  });

  it('grants select to coop_chat_ro only, revokes the rest, and grants no write', () => {
    expect(sql).toContain('revoke all on public.coop_chat_digest from public, anon, authenticated;');
    expect(sql).toContain('grant select on public.coop_chat_digest to coop_chat_ro;');
    expect(sql).not.toMatch(/grant (insert|update|delete|all)/);
    expect(digestRelationForMode('ro_role')).toBe('coop_chat_digest');
  });
});

describe('shapeDigest: a digest-sourced result (Slice 5 criterion 2)', () => {
  it('has meta.source "digest", the window, the checks and no figure left to compute', () => {
    const {result, headline, window} = ok({window: 'latest', section: 'comparison'});
    expect(result.meta.source).toBe('digest');
    expect(result.metric).toBe('digest');
    expect(result.dimension).toBe('comparison');
    expect(result.meta.range).toEqual({from: '2026-09-21', to: '2026-09-27', label: 'Sep 21 to Sep 27, 2026'});
    expect(window).toMatchObject({which: 'latest', label: 'Sep 21 to Sep 27, 2026'});
    expect(headline).toBe('Lazada and Shopee both grew.');
    expect(result.rows.map((r) => r.channel)).toEqual(['Shopee', 'Lazada', 'Website']);
    expect(result.rows[1]).toEqual({channel: 'Lazada', revenue: 26250, orders: 52, aov: 504.81, units: 96, ad_spend: 4200.25, roas: 3.4});
    expect(result.rows[2]).toMatchObject({ad_spend: null, roas: null}); // missing is null, never zero
    expect(result.meta.reliable).toBe(true);
    expect(result.meta.checks.some((c) => c.code === 'partial_coverage' && c.status === 'info' && /not a full month/.test(c.text))).toBe(true);
    expect(result.meta.measures[0].method).toMatch(/nothing is recomputed/);
  });

  it('returns the previous window from the second row', () => {
    const {result, headline, window} = ok({window: 'previous', section: 'figures'});
    expect(headline).toBe('Quieter.');
    expect(window.label).toBe('Sep 14 to Sep 20, 2026');
    expect(result.meta.range.from).toBe('2026-09-14');
  });

  it('pre-formats mixed-unit figures and keeps each time basis, so an all-time figure is never "this week"', () => {
    const {result} = ok({window: 'latest', section: 'sales'});
    expect(result.rows).toEqual([
      {area: 'website sales', figure: 'Net revenue this week (PHP)', value: '₱9,120', basis: 'this digest window'},
      {area: 'website sales', figure: 'Revenue change vs prior week (%)', value: '5%', basis: 'this digest window'},
    ]);
    expect(ok({window: 'latest', section: 'figures'}).result.rows[1]).toMatchObject({basis: 'all time', value: '412'});
    expect(ok({window: 'latest', section: 'shopee'}).result.rows[0]).toMatchObject({area: 'sales', basis: 'window 21/09/2026 - 27/09/2026'});
  });

  it('lists the top products per channel with units where the digest has them', () => {
    const {result} = ok({window: 'latest', section: 'products'});
    expect(result.rows).toEqual([
      {source: 'Website', product: 'Joint Support Chews', revenue: 2400, units: null},
      {source: 'Shopee', product: 'Freeze Dried Munchies', revenue: 5200, units: 21},
      {source: 'Lazada', product: 'Meaty Treats', revenue: 4100, units: 16},
    ]);
  });

  it('never returns a customer name, an outreach note, a verbatim quote, a conversation id or the bundle', () => {
    const everything = DIGEST_SECTIONS.map((s) => JSON.stringify(shapeDigest({window: 'latest', section: s}, live(), NOW))).join('\n');
    for (const secret of ['Maria', 'Santos', 'outreach', QUOTE, 'conversationId', 'c-1', 'bundle', BUNDLE_MARKER]) expect(everything).not.toContain(secret);
  });

  it('flags the digest as stale when even the newest stored one is old', () => {
    const old = new Date('2026-10-09T04:00:00Z'); // 12 days after Sep 27
    const {result} = ok({window: 'latest', section: 'comparison'}, live(), old);
    const stale = result.meta.checks.find((c) => c.status === 'warn');
    expect(stale?.code).toBe('partial_coverage');
    expect(stale?.text).toMatch(/ended 2026-09-27, 12 days ago/);
    expect(result.meta.caveats).toContain(stale?.text);
    expect(ok({window: 'latest', section: 'comparison'}).result.meta.checks.some((c) => c.status === 'warn')).toBe(false); // 3 days: fresh
    expect(DIGEST_STALE_DAYS).toBe(9);
  });

  it('flags sample digests and degraded digests', () => {
    const mock = ok({window: 'latest', section: 'comparison'}, {source: 'mock', rows: [LATEST, PREVIOUS]});
    expect(mock.result.meta.checks.some((c) => c.code === 'mock_source' && c.status === 'warn')).toBe(true);
    expect(mock.result.meta.source).toBe('digest');
    const degraded = ok({window: 'latest', section: 'comparison'}, live([row(doc({degraded: true}), LATEST.window_from, LATEST.window_to)]));
    expect(degraded.result.meta.checks.some((c) => /degraded/.test(c.text))).toBe(true);
  });
});

describe('shapeDigest: steering errors', () => {
  const err = (input: unknown, src: DigestSource | null = live()): string => {
    const out = shapeDigest(input, src, NOW);
    if (!('error' in out)) throw new Error('expected an error');
    return out.error;
  };

  it('names the allowed values for a bad window or section', () => {
    expect(err({window: 'last_month', section: 'comparison'})).toMatch(/Allowed values for window: latest, previous/);
    expect(err({window: 'latest', section: 'bundle'})).toMatch(/Allowed values for section: comparison, figures, sales, customers, shopee, lazada, products/);
    expect(err(null)).toMatch(/window/);
  });

  it('says so plainly when there is no digest, and when there is no previous one', () => {
    expect(err({window: 'latest', section: 'figures'}, null)).toMatch(/No stored digest is available right now/);
    expect(err({window: 'latest', section: 'figures'}, live([]))).toMatch(/No stored digest is available right now/);
    expect(err({window: 'previous', section: 'figures'}, live([LATEST]))).toMatch(/no previous window/);
  });

  it('lists the sections the digest does have when one is missing', () => {
    const bare = row(doc({comparison: undefined, shopee: null, lazada: undefined, customers: null}), LATEST.window_from, LATEST.window_to);
    expect(err({window: 'latest', section: 'comparison'}, live([bare]))).toMatch(/no comparison section\. Sections it has: figures, sales, products/);
  });
});

describe('the get_digest executor', () => {
  const data: MetricData = {source: 'live', orders: [], events: [], prices: [], priceChanges: [], bulkReads: []};
  const make = (digest?: ChatToolContext['digest']) => {
    const blocks: ChatBlock[] = [];
    const reports: unknown[] = [];
    const ctx: ChatToolContext = {data: async () => data, now: NOW, user: null, digest, emitBlock: (b) => blocks.push(b), emitReport: (s) => reports.push(s)};
    return {ex: createExecutors(ctx), blocks, reports};
  };

  it('returns a stored, compact result with the window and headline, and the result can be drawn as a table', async () => {
    const {ex, blocks, reports} = make(async () => live());
    const r = (await ex.get_digest?.({window: 'latest', section: 'comparison'})) as Record<string, any>;
    expect(r.id).toBe('r1');
    expect(r.meta.source).toBe('digest');
    expect(r.window).toMatchObject({which: 'latest'});
    expect(r.headline).toBe('Lazada and Shopee both grew.');
    expect(r.meta.method).toMatch(/exactly as published/);
    expect(r.meta).not.toHaveProperty('measures');

    await ex.render_chart?.({block: 'new', source: 'r1', kind: 'auto', orientation: 'auto', x: 'auto', y: ['auto'], title: 'Chart'});
    const drawn = (await ex.render_table?.({block: 'new', source: 'r1', columns: ['auto'], title: 'Channels'})) as {ok?: boolean; error?: string};
    expect(drawn.error).toBeUndefined();
    expect(blocks).toHaveLength(2); // the chart first (the default), then its table companion
    expect(blocks[1]).toMatchObject({kind: 'table', source: 'r1'});
    expect(reports).toEqual([null, null]); // no recipe to re-run, so nothing is recorded into a saved report
  });

  it('shares the r-counter with query_metric and lookup_product', async () => {
    const {ex} = make(async () => live());
    expect(((await ex.get_digest?.({window: 'latest', section: 'figures'})) as {id: string}).id).toBe('r1');
    expect(((await ex.get_digest?.({window: 'previous', section: 'figures'})) as {id: string}).id).toBe('r2');
  });

  it('degrades to a steering error when no loader is wired or the read fails (never a crash)', async () => {
    const input = {window: 'latest', section: 'figures'};
    for (const digest of [undefined, async () => Promise.reject(new Error('relation does not exist'))]) {
      const out = (await make(digest).ex.get_digest?.(input)) as {error: string};
      expect(Object.keys(out)).toEqual(['error']);
      expect(out.error).toMatch(/No stored digest is available right now/);
      expect(out.error).not.toMatch(/relation does not exist/);
    }
  });

  it('is flagged is_error through dispatch when it refuses, and not when it answers', async () => {
    const {ex} = make(async () => live());
    expect((await dispatchToolCall({name: 'get_digest', input: {window: 'latest', section: 'nope'}}, ex)).is_error).toBe(true);
    expect((await dispatchToolCall({name: 'get_digest', input: {window: 'latest', section: 'comparison'}}, ex)).is_error).toBe(false);
  });
});

describe('a digest read goes through the digest adapter, not src/data.ts (Slice 5 criterion 3)', () => {
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? files(join(dir, n)) : n.endsWith('.ts') ? [join(dir, n)] : []));
  const chat = files(join(process.cwd(), 'src', 'chat'));

  it('no file under src/chat imports the legacy digest reader', () => {
    const offenders = chat.filter((f) => /from\s+['"](?:@\/src\/data|(?:\.\.?\/)+data)['"]/.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('the chat server glue reads the digest through readDigestRows and the digest client', () => {
    const server = readFileSync(join(process.cwd(), 'src', 'chat', 'server.ts'), 'utf8');
    expect(server).toMatch(/readDigestRows\(client, mode\)/);
    expect(server).toMatch(/chatDigestClient\(/);
    expect(server).not.toMatch(/createClient/);
  });
});

const err = (input: Record<string, string>, src: DigestSource | null = live(), now = NOW): string => {
  const out = shapeDigest(input, src, now);
  if (!('error' in out)) throw new Error('expected an error');
  return out.error;
};

describe('F.5 get_digest window "covering" (PH days, re-runs removed)', () => {
  it('picks the digest that covers a date: PH 28 Sep is the 28 Sep to 4 Oct digest, never the week before', () => {
    const out = ok({window: 'covering', section: 'comparison', from: '2026-09-28', to: ''}, septSource());
    expect(out.window).toEqual({which: 'covering', label: 'Sep 28 to Oct 4, 2026', from: '2026-09-28', to: '2026-10-04'});
    expect(out.result.meta.range).toEqual({from: '2026-09-28', to: '2026-10-04', label: 'Sep 28 to Oct 4, 2026'});
  });
  it('a range picks the window that overlaps it most and warns which part it covers', () => {
    const out = ok({window: 'covering', section: 'comparison', from: '2026-09-01', to: '2026-09-30'}, septSource());
    expect(out.window.label).toBe('Sep 1 to Sep 27, 2026');
    const warn = out.result.meta.checks.find((c) => c.status === 'warn' && /covers Sep 1 to Sep 27, 2026 of it/.test(c.text));
    expect(warn?.text).toMatch(/You asked about Sep 1 to Sep 30, 2026/);
    expect(out.result.meta.checks.some((c) => /weekly or about a month/.test(c.text) && /not a full month/.test(c.text))).toBe(true);
  });
  it('a tie on overlap prefers the shorter window', () => {
    expect(ok({window: 'covering', section: 'comparison', from: '2026-09-24', to: ''}, septSource()).window.label).toBe('Sep 21 to Sep 27, 2026');
  });
  it('no overlap returns the nearest windows, not "not available"', () => {
    const e = err({window: 'covering', section: 'comparison', from: '2026-06-01', to: ''}, septSource());
    expect(e).toMatch(/^No stored digest covers Jun 1, 2026\. The nearest stored windows are: Jul 10, 2026 11:40 to Aug 9, 2026 11:40 \(PH time\); Aug 1, 2026 08:00/);
    expect(e).not.toMatch(/not available/);
  });
  it('covering rejects an impossible date instead of rolling it over', () => {
    for (const bad of ['2026-02-30', '2026-13-01', '2026-09-31']) {
      expect(err({window: 'covering', section: 'comparison', from: bad, to: ''}, septSource())).toMatch(/needs the owner's date|not a real date/);
      expect(err({window: 'covering', section: 'comparison', from: '2026-09-01', to: bad}, septSource())).toMatch(/needs the owner's date|not a real date/);
    }
    expect(ok({window: 'covering', section: 'comparison', from: '2026-09-28', to: ''}, septSource()).window.which).toBe('covering');
  });
  it('covering without the owner\'s date asks for it; a pick that is not loaded says so', () => {
    expect(err({window: 'covering', section: 'comparison', from: '', to: ''}, septSource())).toMatch(/needs the owner's date/);
    expect(err({window: 'covering', section: 'comparison', from: '2026-08-15', to: ''}, septSource())).toMatch(/could not be loaded/);
  });
  it('"previous" is never a re-run of "latest" (same window within an hour)', () => {
    const reruns: DigestSource = {source: 'live', rows: SEPTEMBER_ROWS.slice(4)};
    expect(err({window: 'previous', section: 'comparison'}, reruns)).toMatch(/Only one digest is stored/);
    expect(ok({window: 'latest', section: 'comparison'}, reruns).result.rows[0]).toMatchObject({channel: 'Shopee', revenue: 28000});
  });
});

describe('F.5 the get_digest executor loads an older digest for "covering"', () => {
  it('reads it through rowAt and labels it with exact PH boundaries', async () => {
    const data: MetricData = {source: 'live', orders: [], events: [], prices: [], priceChanges: [], bulkReads: []};
    const ex = createExecutors({data: async () => data, now: NOW, user: null, digest: async () => septSource()});
    const r = (await ex.get_digest?.({window: 'covering', section: 'comparison', from: '2026-08-15', to: ''})) as Record<string, any>;
    expect(r.window).toEqual({which: 'covering', label: 'Aug 1, 2026 08:00 to Sep 1, 2026 08:00 (PH time)', from: '2026-08-01', to: '2026-09-01'});
    expect(r.rows.find((x: {channel: string}) => x.channel === 'Shopee')).toMatchObject({revenue: 30000, orders: 60});
  });
});
