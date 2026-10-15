import {describe, expect, it, vi} from 'vitest';
import type {RawQueryResult} from '../src/chat/explore/result';
import {createLiveValidator, createSchemaTools, LIST_TABLES_SQL, SCHEMA_CALLS_PER_QUESTION} from '../src/chat/explore/schema-tools';

const res = (rows: unknown[][]): RawQueryResult => ({columns: [], rows, fetched: rows.length, ms: 1});
const LIVE = [
  ['pos_orders', 'BASE TABLE'], ['marketplace_tokens', 'BASE TABLE'], ['gl_sales', 'BASE TABLE'], ['coop_explore_stock_event', 'VIEW'],
  ['brand_new_table', 'BASE TABLE'], ['explore_fixture_qxml_view', 'VIEW'], ['coop_explore_drift_log', 'BASE TABLE'],
];
const fake = (seen: string[]) => async (sent: string): Promise<RawQueryResult> => {
  seen.push(sent);
  if (sent.includes(LIST_TABLES_SQL)) return res(LIVE);
  if (sent.includes("c.table_name = 'explore_fixture_mixed'")) return res([['id', 'integer', 'NO', 'BASE TABLE'], ['label', 'text', 'YES', 'BASE TABLE'], ['api_key', 'text', 'YES', 'BASE TABLE']]);
  if (sent.includes("c.table_name = 'pos_orders'")) return res([['id', 'bigint', 'NO', 'BASE TABLE'], ['total', 'numeric', 'YES', 'BASE TABLE']]);
  if (sent.includes("c.table_name = 'explore_fixture_qxml_view'")) return res([['x', 'xml', 'YES', 'VIEW']]);
  return res([]);
};
type Listed = {tables: {table: string; domain: string | null; kind: string; about?: string}[]};

describe('2.3 list_tables and describe_table', () => {
  it('list_tables: live granted tables, closed names and unlisted views dropped, catalog notes merged', async () => {
    const t = createSchemaTools(fake([]));
    const out = (await t.list_tables({domain: 'all'})) as Listed;
    expect(out.tables.map((x) => x.table)).toEqual(['pos_orders', 'coop_explore_stock_event', 'brand_new_table', 'coop_explore_drift_log']);
    expect(out.tables.find((x) => x.table === 'pos_orders')?.domain).toBe('pos-sales');
    expect(out.tables.find((x) => x.table === 'brand_new_table')?.domain).toBeNull();
    const stock = (await t.list_tables({domain: 'pos-sales'})) as Listed;
    expect(stock.tables.map((x) => x.table)).toEqual(['pos_orders']);
  });
  it('list_tables is compact: one short line per table (the first sentence of the catalog note), no column lists', async () => {
    const out = (await createSchemaTools(fake([])).list_tables({domain: 'all'})) as Listed;
    for (const x of out.tables) expect((x.about ?? '').length, x.table).toBeLessThanOrEqual(160);
    expect(JSON.stringify(out)).not.toMatch(/client_uuid/); // pos_orders' column list stays in describe_table
  });
  it('describe_table: live columns, never a secret column, with catalog meaning', async () => {
    const t = createSchemaTools(fake([]));
    const mixed = (await t.describe_table({table: 'explore_fixture_mixed'})) as {columns: {name: string}[]};
    expect(mixed.columns.map((c) => c.name)).toEqual(['id', 'label']);
    const orders = (await t.describe_table({table: 'pos_orders'})) as {about: string | null; columns: {name: string; nullable: boolean}[]};
    expect(orders.about).toMatch(/sale/i);
    expect(orders.columns).toEqual([{name: 'id', type: 'bigint', nullable: false}, {name: 'total', type: 'numeric', nullable: true}]);
  });
  it('describe_table says a closed name is closed, and why, from the name rule (no database call)', async () => {
    const seen: string[] = [];
    const t = createSchemaTools(fake(seen));
    for (const table of ['gl_sales', 'gl_inventory_snapshots', 'company_users', 'companies']) {
      expect(await t.describe_table({table}), table).toEqual({error: expect.stringMatching(/^E_RELATION: .* is tenant-fenced/)});
    }
    for (const table of ['marketplace_tokens', 'explore_fixture_api_keys']) {
      expect(await t.describe_table({table}), table).toEqual({error: expect.stringMatching(/^E_RELATION: .* is not available to Ask Coop/)});
    }
    expect(seen).toHaveLength(0);
  });
  it('describe_table refuses a view that is not allowlisted even when the database lists it', async () => {
    expect(await createSchemaTools(fake([])).describe_table({table: 'explore_fixture_qxml_view'})).toMatchObject({error: expect.stringMatching(/^E_RELATION/)});
  });
  it('refuses malformed or unknown names without a database call, and caps calls per question', async () => {
    const seen: string[] = [];
    const t = createSchemaTools(fake(seen));
    for (const table of ['Pos_Orders', "x' or '1'='1", 42, '']) expect(await t.describe_table({table})).toMatchObject({error: expect.stringMatching(/^E_RELATION/)});
    expect(seen).toHaveLength(0);
    expect(await t.describe_table({table: 'no_such_table'})).toMatchObject({error: expect.stringMatching(/^E_RELATION/)});
    const capped = createSchemaTools(fake([]));
    for (let i = 0; i < SCHEMA_CALLS_PER_QUESTION; i++) await capped.list_tables({domain: 'all'});
    expect(await capped.list_tables({domain: 'all'})).toMatchObject({error: expect.stringMatching(/^E_CALLS/)});
  });
  it('a failing read is E_UNAVAILABLE, never a thrown error or database text', async () => {
    const t = createSchemaTools(async () => {
      throw new Error('raw db text');
    });
    expect(await t.list_tables({domain: 'all'})).toEqual({error: expect.stringMatching(/^E_UNAVAILABLE/)});
    expect(await t.describe_table({table: 'pos_orders'})).toEqual({error: expect.stringMatching(/^E_UNAVAILABLE/)});
  });
});

describe('2.1 the production validator uses the live relation kinds (views default-deny in the parser too)', () => {
  it('reads the list once per question; an unlisted or unknown relation is E_RELATION', async () => {
    const seen: string[] = [];
    const validate = createLiveValidator(fake(seen));
    expect((await validate('select o.id from pos_orders o')).ok).toBe(true);
    expect((await validate('select s.stock from coop_explore_stock_event s')).ok).toBe(true);
    expect(await validate('select x.x from explore_fixture_qxml_view x')).toMatchObject({ok: false, code: 'E_RELATION'});
    expect(await validate('select n.id from not_granted_table n')).toMatchObject({ok: false, code: 'E_RELATION'});
    expect(seen.filter((s) => s.includes(LIST_TABLES_SQL))).toHaveLength(1);
    expect(await validate('select m.marketplace from marketplace_tokens m')).toMatchObject({ok: false, code: 'E_RELATION'});
  });
  it('fails CLOSED when the live list cannot be read: E_UNAVAILABLE, no query sent, the read not retried within the question (finding 5)', async () => {
    let reads = 0;
    const sent: string[] = [];
    const runQuery = async (s: string): Promise<RawQueryResult> => {
      sent.push(s);
      if (s.includes(LIST_TABLES_SQL)) {
        reads += 1;
        throw new Error('down');
      }
      return res([[1]]);
    };
    const down = createLiveValidator(runQuery);
    expect(await down('select o.id from pos_orders o')).toMatchObject({ok: false, code: 'E_UNAVAILABLE'});
    expect(await down('select n.id from not_granted_table n')).toMatchObject({ok: false, code: 'E_UNAVAILABLE'});
    expect(reads).toBe(1);
    const {createExploreExecutor} = await import('../src/chat/explore/executor');
    const limits = {maxRows: 200, maxCols: 12, maxBytes: 65536, timeoutMs: 5000, maxSqlChars: 2000, maxCallsPerQuestion: 5, maxPerUserDay: 100, modelRows: 50, maxRelations: 8, maxDepth: 20};
    sent.length = 0;
    const exec = createExploreExecutor({runQuery, validate: createLiveValidator(runQuery), limits, now: new Date(), user: 'u', store: {set: () => {}}, sink: {info: () => {}, error: () => {}}});
    expect(await exec({purpose: 'p', sql: 'select o.id from pos_orders o', step: 'probe'})).toEqual({error: expect.stringMatching(/^E_UNAVAILABLE/)});
    expect(sent.every((s) => s.includes(LIST_TABLES_SQL))).toBe(true); // only the failed list read, never the query
  });
});

describe('2.3 schema tools are audited, count toward the daily limit, and validate the domain (findings 8, 9)', () => {
  const sinkOf = () => {
    const lines: Record<string, unknown>[] = [];
    return {lines, sink: {info: (s: string) => lines.push(JSON.parse(s)), error: () => {}}};
  };
  it('every call writes one chat_explore_schema line: tool, code, table or domain, user; never rows', async () => {
    const {lines, sink} = sinkOf();
    const t = createSchemaTools(fake([]), {user: 'u@example.com', sink});
    await t.list_tables({domain: 'all'});
    await t.describe_table({table: 'pos_orders'});
    await t.describe_table({table: 'gl_sales'});
    await t.list_tables({domain: 'nope'});
    expect(lines).toEqual([
      {event: 'chat_explore_schema', tool: 'list_tables', ok: true, code: null, table: null, domain: 'all', user: 'u@example.com'},
      {event: 'chat_explore_schema', tool: 'describe_table', ok: true, code: null, table: 'pos_orders', domain: null, user: 'u@example.com'},
      {event: 'chat_explore_schema', tool: 'describe_table', ok: false, code: 'E_RELATION', table: 'gl_sales', domain: null, user: 'u@example.com'},
      {event: 'chat_explore_schema', tool: 'list_tables', ok: false, code: 'E_INPUT', table: null, domain: 'nope', user: 'u@example.com'},
    ]);
  });
  it('a call that would reach the database is counted by the day gate; a used-up gate is E_RATE_DAY with no database call', async () => {
    const seen: string[] = [];
    let allow = true;
    let gated = 0;
    const t = createSchemaTools(fake(seen), {dayGate: () => (gated++, allow)});
    await t.list_tables({domain: 'all'});
    await t.describe_table({table: 'pos_orders'});
    await t.describe_table({table: 'gl_sales'}); // refused by name: no database call, not counted
    expect(gated).toBe(2);
    allow = false;
    seen.length = 0;
    expect(await t.list_tables({domain: 'all'})).toEqual({error: expect.stringMatching(/^E_RATE_DAY/)});
    expect(await t.describe_table({table: 'pos_orders'})).toEqual({error: expect.stringMatching(/^E_RATE_DAY/)});
    expect(seen).toHaveLength(0);
  });
  it('an unknown or missing domain is E_INPUT naming the valid ids, with no database call', async () => {
    const seen: string[] = [];
    const t = createSchemaTools(fake(seen));
    for (const domain of ['nope', undefined, 42, 'marketplace-tokens']) {
      expect(await t.list_tables({domain}), String(domain)).toEqual({error: expect.stringMatching(/^E_INPUT: .*"all".*pos-sales/)});
    }
    expect(await t.list_tables(null)).toEqual({error: expect.stringMatching(/^E_INPUT/)});
    expect(seen).toHaveLength(0);
    expect(((await t.list_tables({domain: 'pos-sales'})) as Listed).tables.map((x) => x.table)).toEqual(['pos_orders']);
  });
});

describe('2.3 the tools are wired: allowlisted, dispatched only for Explore users, constant progress labels', () => {
  it('createExecutors exposes list_tables and describe_table only with exploreSchema; dispatch reaches them', async () => {
    const {createExecutors, statusFor} = await import('../src/chat/tool-executors');
    const {dispatchToolCall, isAllowedTool} = await import('../src/chat/tools');
    expect(isAllowedTool('list_tables') && isAllowedTool('describe_table')).toBe(true);
    const base = {data: async () => { throw new Error('unused'); }, now: new Date('2026-10-07T00:00:00Z'), user: null, emitBlock: () => {}};
    const off = createExecutors(base as never);
    expect(off.list_tables).toBeUndefined();
    const on = createExecutors({...base, exploreSchema: createSchemaTools(fake([]))} as never);
    const r = await dispatchToolCall({name: 'describe_table', input: {table: 'gl_sales'}}, on);
    expect(r.is_error).toBe(true);
    expect(JSON.stringify(r.content)).toMatch(/tenant-fenced/);
    expect(statusFor('list_tables', {domain: 'all'})).toBe('Listing the tables');
    expect(statusFor('describe_table', {table: 'pos_orders'})).toBe("Reading a table's columns");
  });
});

describe('2.3 the route wires the schema tools to the same audit sink and daily allowance as run_query (finding 8)', () => {
  it('setupExplore passes user, sink and the shared day gate: the tools log, and over the allowance they stop', async () => {
    vi.mock('server-only', () => ({}));
    const {setupExplore} = await import('../src/chat/explore-setup');
    const lines: Record<string, unknown>[] = [];
    const sink = {info: (s: string) => lines.push(JSON.parse(s)), error: () => {}};
    const env = {NODE_ENV: 'development', EXPLORE_MODE: 'on', EXPLORE_DATABASE_URL: 'postgres://coop_explore_ro:pw@127.0.0.1:54421/postgres', EXPLORE_ALLOWED_EMAILS: 'dev@localhost', EXPLORE_MAX_PER_USER_DAY: '2'};
    const s = setupExplore({env, email: 'dev@localhost', now: new Date('2031-01-02T00:00:00Z'), user: 'wiring-test-user', store: {set: () => {}}, sink, runQuery: fake([])});
    expect(s).not.toBeNull();
    const outs = [];
    for (let i = 0; i < 4; i++) outs.push(await s!.schema.list_tables({domain: 'all'}));
    expect(lines.filter((l) => l.event === 'chat_explore_schema').map((l) => [l.user, l.code])).toEqual(outs.map((o) => ['wiring-test-user', (o as {error?: string}).error?.slice(0, 10) ?? null]));
    expect(outs.at(-1)).toEqual({error: expect.stringMatching(/^E_RATE_DAY/)});
  });
});
