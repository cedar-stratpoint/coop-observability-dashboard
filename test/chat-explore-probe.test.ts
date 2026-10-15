// Explore status in /api/chat/health: the pure probe and the status object. A fake runQuery stands in for the driver: no database, no network.
import {describe, expect, it, vi} from 'vitest';
vi.mock('server-only', () => ({}));
import {ExploreDbError} from '../src/chat/explore/errors';
import {PROBE_SQL, probeExplore} from '../src/chat/explore/probe';
import {describeExploreEnv} from '../src/chat/health';
import {exploreHealth} from '../src/chat/explore-setup';
import type {RawQueryResult} from '../src/chat/explore/result';

const okRows: RawQueryResult = {
  columns: [{name: 'role_name', type: 'text'}, {name: 'read_only', type: 'text'}, {name: 'statement_timeout', type: 'text'}, {name: 'orders_visible', type: 'number'}],
  rows: [['coop_explore_ro', 'on', '3s', 146]], fetched: 1, ms: 4,
};
const URL_ = 'postgresql://coop_explore_ro:SuperSecretPw@127.0.0.1:54322/postgres?sslmode=disable';
const dev = {NODE_ENV: 'development', EXPLORE_MODE: 'on', EXPLORE_DATABASE_URL: URL_, EXPLORE_ALLOWED_EMAILS: 'a@x.com, b@x.com'};

describe('probeExplore: one fixed statement through the read-only envelope, a short code on failure', () => {
  it('sends the fixed statement wrapped as a cursor, with a short statement timeout, and reports role and read-only', async () => {
    const runQuery = vi.fn(async () => okRows);
    const r = await probeExplore(runQuery);
    expect(r).toMatchObject({ok: true, role: 'coop_explore_ro', readOnly: 'on'});
    expect((r as {ms: number}).ms).toBeGreaterThanOrEqual(0);
    const [sent, opts] = runQuery.mock.calls[0] as unknown as [string, {timeoutMs: number; maxRows: number}];
    expect(sent).toBe(`DECLARE coop_explore_c NO SCROLL CURSOR FOR ${PROBE_SQL}`);
    expect(opts.timeoutMs).toBeLessThanOrEqual(5000);
    expect(PROBE_SQL).toMatch(/current_user as role_name/);
    expect(PROBE_SQL).toMatch(/transaction_read_only/);
  });
  it.each([
    ['ECONNREFUSED', 'E_UNAVAILABLE', 'connection_refused'],
    ['CONNECTION_REFUSED', 'E_UNAVAILABLE', 'connection_refused'],
    ['ENOTFOUND', 'E_UNAVAILABLE', 'connection_refused'],
    ['28P01', 'E_UNAVAILABLE', 'auth_failed'],
    ['28000', 'E_UNAVAILABLE', 'auth_failed'],
    ['CONNECT_TIMEOUT', 'E_UNAVAILABLE', 'timeout'],
    ['57014', 'E_TIMEOUT', 'timeout'],
    ['42P01', 'E_RELATION', 'undefined_table'],
    ['42501', 'E_DB_DENIED', 'permission_denied'],
    ['XX000', 'E_DB_OTHER', 'other'],
  ])('maps %s to %s -> %s and never echoes driver text', async (sqlstate, code, expected) => {
    const runQuery = async () => {
      throw new ExploreDbError(code as never, sqlstate);
    };
    expect(await probeExplore(runQuery)).toEqual({ok: false, code: expected});
  });
  it('an unknown thrown value (even raw driver text) becomes other, never leaked', async () => {
    const r = await probeExplore(async () => {
      throw new Error('password authentication failed for user "coop_explore_ro" at 10.0.0.5');
    });
    expect(r).toEqual({ok: false, code: 'other'});
  });
  it('a result that is not the Explore role or not read only is a failure, not ok', async () => {
    expect(await probeExplore(async () => ({...okRows, rows: [['postgres', 'on', '3s', 1]]}))).toEqual({ok: false, code: 'wrong_role'});
    expect(await probeExplore(async () => ({...okRows, rows: [['coop_explore_ro', 'off', '3s', 1]]}))).toEqual({ok: false, code: 'not_read_only'});
    expect(await probeExplore(async () => ({...okRows, rows: []}))).toEqual({ok: false, code: 'other'});
  });
  it('is capped overall: a hung query becomes timeout', async () => {
    vi.useFakeTimers();
    const p = probeExplore(() => new Promise<RawQueryResult>(() => undefined));
    await vi.advanceTimersByTimeAsync(5001);
    expect(await p).toEqual({ok: false, code: 'timeout'});
    vi.useRealTimers();
  });
});

describe('describeExploreEnv: flags only, never a value', () => {
  it('reports a good local setup', () => {
    const d = describeExploreEnv(dev);
    expect(d.EXPLORE_MODE).toEqual({set: true, on: true});
    expect(d.EXPLORE_DATABASE_URL).toEqual({set: true, length: URL_.length, roleOk: true, host: '127.0.0.1', kind: 'loopback'});
    expect(d.EXPLORE_ALLOWED_EMAILS).toEqual({set: true, count: 2});
    expect(d.ALLOWED_EMAILS).toEqual({set: false, count: 0});
  });
  it('derives the host kind and accepts the pooler role form', () => {
    const u = (s: string) => describeExploreEnv({EXPLORE_DATABASE_URL: s}).EXPLORE_DATABASE_URL;
    expect(u('postgresql://coop_explore_ro.abcref:pw@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres')).toMatchObject({roleOk: true, host: 'aws-0-ap-southeast-1.pooler.supabase.com', kind: 'pooler'});
    expect(u('postgresql://coop_explore_ro:pw@db.abcref.supabase.co:5432/postgres')).toMatchObject({roleOk: true, kind: 'direct'});
    expect(u('postgresql://postgres:pw@example.com/postgres')).toMatchObject({roleOk: false, kind: 'other'});
    expect(u('not a url')).toMatchObject({set: true, roleOk: false, host: null, kind: 'other'});
    expect(describeExploreEnv({}).EXPLORE_DATABASE_URL).toEqual({set: false});
  });
  it('EXPLORE_MODE is on only for exactly "on"', () => {
    expect(describeExploreEnv({EXPLORE_MODE: 'ON'}).EXPLORE_MODE).toEqual({set: true, on: false});
    expect(describeExploreEnv({}).EXPLORE_MODE).toEqual({set: false, on: false});
  });
  it('never contains the password, the user, the port, the query, or an email', () => {
    const json = JSON.stringify(describeExploreEnv(dev));
    for (const s of ['SuperSecretPw', 'coop_explore_ro', '54322', 'sslmode', 'a@x.com', 'postgresql://']) expect(json).not.toContain(s);
  });
});

describe('exploreHealth: the explore object of /api/chat/health', () => {
  it('off: a reason code, flags, and NO probe (and the runner is never built or called)', async () => {
    const runQuery = vi.fn(async () => okRows);
    const h = await exploreHealth({...dev, EXPLORE_MODE: 'off'}, 'a@x.com', {runQuery});
    expect(h.enabled).toBe(false);
    expect(h).toMatchObject({reason: 'mode_off'});
    expect(h).not.toHaveProperty('probe');
    expect(runQuery).not.toHaveBeenCalled();
  });
  it('a user who is not on the list gets user_not_allowed and no probe', async () => {
    const runQuery = vi.fn(async () => okRows);
    const h = await exploreHealth(dev, 'zed@x.com', {runQuery});
    expect(h).toMatchObject({enabled: false, reason: 'user_not_allowed'});
    expect(runQuery).not.toHaveBeenCalled();
  });
  it('enabled: probe ok', async () => {
    const h = await exploreHealth(dev, 'A@x.com', {runQuery: async () => okRows});
    expect(h).toMatchObject({enabled: true, probe: {ok: true, role: 'coop_explore_ro', readOnly: 'on'}});
    expect(h).not.toHaveProperty('reason');
    expect(JSON.stringify(h)).not.toContain('SuperSecretPw');
    console.log(JSON.stringify(h, null, 2));
  });
  it('enabled: probe failure is a short code, and a throwing runner never throws out', async () => {
    const bad = await exploreHealth(dev, 'a@x.com', {runQuery: async () => { throw new ExploreDbError('E_RELATION', '42P01'); }});
    expect(bad).toMatchObject({enabled: true, probe: {ok: false, code: 'undefined_table'}});
    const weird = await exploreHealth(dev, 'a@x.com', {runQuery: () => { throw 'boom'; }});
    expect(weird).toMatchObject({enabled: true, probe: {ok: false, code: 'other'}});
  });
  it('Train 3: explore health carries the drift status (counts only, no names)', async () => {
    const runQuery = async (sent: string): Promise<RawQueryResult> => sent.includes('coop_explore_drift_log')
      ? {columns: [{name: 'checked_at', type: 'timestamp'}, {name: 'findings_count', type: 'number'}], rows: [['2026-10-07T22:00:00Z', 0]], fetched: 1, ms: 1}
      : okRows;
    const h = await exploreHealth(dev, 'a@x.com', {runQuery});
    expect(h).toMatchObject({enabled: true, probe: {ok: true}});
    expect(h.drift).toMatchObject({checkedAt: '2026-10-07T22:00:00Z', findings: 0});
    expect(JSON.stringify(h)).not.toMatch(/marketplace_tokens|api_key/);
  });
  it('Train 3: a failing drift read is stale, and the probe still reports; off has no drift', async () => {
    const runQuery = async (sent: string): Promise<RawQueryResult> => {
      if (sent.includes('coop_explore_drift_log')) throw new ExploreDbError('E_RELATION', '42P01');
      return okRows;
    };
    expect(await exploreHealth(dev, 'a@x.com', {runQuery})).toMatchObject({enabled: true, probe: {ok: true}, drift: {checkedAt: null, findings: null, stale: true}});
    expect(await exploreHealth({...dev, EXPLORE_MODE: 'off'}, 'a@x.com', {runQuery})).not.toHaveProperty('drift');
  });
  it('Task 7: explore health counts open live tables the data catalog does not know (uncatalogued); null when the read fails', async () => {
    const runQuery = async (sent: string): Promise<RawQueryResult> => sent.includes('information_schema.tables')
      ? {columns: [], rows: [['pos_orders', 'BASE TABLE'], ['brand_new_table', 'BASE TABLE'], ['marketplace_tokens', 'BASE TABLE'], ['explore_fixture_qxml_view', 'VIEW']], fetched: 4, ms: 1}
      : okRows;
    expect(await exploreHealth(dev, 'a@x.com', {runQuery})).toMatchObject({enabled: true, uncatalogued: 1});
    const failing = async (sent: string): Promise<RawQueryResult> => {
      if (sent.includes('information_schema.tables')) throw new ExploreDbError('E_DB_OTHER');
      return okRows;
    };
    expect(await exploreHealth(dev, 'a@x.com', {runQuery: failing})).toMatchObject({enabled: true, probe: {ok: true}, uncatalogued: null});
  });
  it('off example for the docs', async () => {
    console.log(JSON.stringify(await exploreHealth({...dev, EXPLORE_ALLOWED_EMAILS: ''}, 'a@x.com'), null, 2));
  });
});
