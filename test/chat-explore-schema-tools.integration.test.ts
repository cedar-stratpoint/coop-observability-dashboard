// LOCAL INTEGRATION (skipped unless pointed at the throwaway local stack built by `scripts/local-supabase/up.sh --explore`):
//   set -a; . scripts/local-supabase/.local-env; set +a; npx vitest run test/chat-explore-schema-tools.integration.test.ts
// list_tables, describe_table and the live validator against the REAL login coop_explore_ro: the database hides what it must
// (information_schema shows only granted relations and columns), and the TS rules agree with it. Prints names only, never row data.
import {describe, expect, it, vi} from 'vitest';
vi.mock('server-only', () => ({}));
import {EXPLORE_VIEW_ALLOWLIST} from '../src/chat/explore/access';
import {createRunQuery} from '../src/chat/explore/client';
import {DEFAULT_EXPLORE_LIMITS} from '../src/chat/explore/limits';
import {wrapCursor} from '../src/chat/explore/parse';
import {createLiveValidator, createSchemaTools, describeTableSql, listOpenTables} from '../src/chat/explore/schema-tools';
import {assertLocalPostgres} from './support/local-only';

const URL_ = process.env.EXPLORE_DATABASE_URL;
const PSQL = process.env.SB_PSQL_CMD;
if (URL_) assertLocalPostgres(URL_);
const local = !!URL_ && !!PSQL && /^docker exec -i coop-local-db /.test(PSQL);
const run = local ? createRunQuery({enabled: true, limits: DEFAULT_EXPLORE_LIMITS, databaseUrl: URL_!}) : (undefined as never);
const TRAPS = ['explore_fixture_qxml_view', 'explore_fixture_tsstat_view', 'explore_fixture_domain_view', 'explore_fixture_wrap_view', 'explore_fixture_op_view', 'explore_fixture_sd_view', 'explore_fixture_row_view', 'explore_fixture_token_view', 'explore_fixture_alias_view'];

describe.skipIf(!local)('Task 7 schema tools and the live validator on the real login (local Postgres only)', () => {
  it('the DATABASE hides the secret column: information_schema.columns as the login lists id, label only', async () => {
    const r = await run(wrapCursor(describeTableSql('explore_fixture_mixed')), {timeoutMs: 3000, maxRows: 50});
    expect(r.rows.map((x) => x[0])).toEqual(['id', 'label']);
  });
  it('list_tables: no closed name, no trap view, every allowlisted view present, the drift log listed', async () => {
    const names = (await listOpenTables(run)).map((t) => t.name);
    for (const n of ['marketplace_tokens', 'gl_fixture_stores', 'companies', ...TRAPS]) expect(names, n).not.toContain(n);
    for (const v of EXPLORE_VIEW_ALLOWLIST) expect(names, v).toContain(v);
    expect(names).toEqual(expect.arrayContaining(['pos_orders', 'explore_fixture_mixed', 'coop_explore_drift_log']));
    const out = (await createSchemaTools(run).list_tables({domain: 'all'})) as {tables: unknown[]};
    console.log(`list_tables(all): ${out.tables.length} tables, ${JSON.stringify(out).length} chars`);
  });
  it('describe_table: real columns for pos_orders, closed and trap names refused', async () => {
    const t = createSchemaTools(run);
    const orders = (await t.describe_table({table: 'pos_orders'})) as {columns: {name: string}[]};
    expect(orders.columns.map((c) => c.name)).toEqual(expect.arrayContaining(['id', 'total', 'status', 'created_at']));
    console.log(`describe_table(pos_orders): ${JSON.stringify(orders).length} chars`);
    expect(await t.describe_table({table: 'gl_fixture_stores'})).toMatchObject({error: expect.stringMatching(/tenant-fenced/)});
    expect(await t.describe_table({table: 'marketplace_tokens'})).toMatchObject({error: expect.stringMatching(/not available to Ask Coop/)});
    expect(await t.describe_table({table: 'explore_fixture_qxml_view'})).toMatchObject({error: expect.stringMatching(/^E_RELATION/)});
  });
  it('the live validator refuses every trap view and an unknown name before the database, and passes real tables and allowlisted views', async () => {
    const validate = createLiveValidator(run);
    for (const v of TRAPS) expect(await validate(`select x.j from ${v} x`), v).toMatchObject({ok: false, code: 'E_RELATION'});
    expect(await validate('select n.id from no_such_table n')).toMatchObject({ok: false, code: 'E_RELATION'});
    for (const sql of ['select o.id from pos_orders o', 'select i.stock from pos_inventory i', 'select o.id from coop_explore_orders o', 'select d.findings_count from coop_explore_drift_log d']) {
      expect((await validate(sql)).ok, sql).toBe(true);
    }
  });
  it('JSON read as text (Task 7 review finding 1): refused by name, and what passes is hidden by the KEY rule, not by luck of the hex shape', async () => {
    const validate = createLiveValidator(run);
    expect(await validate('select n::text as v from explore_fixture_notes n')).toMatchObject({ok: false, code: 'E_SELECT_STAR'});
    expect(await validate("select n.payload->'lazada'->>'access_token' as v from explore_fixture_notes n")).toMatchObject({ok: false, code: 'E_BLOCKED_COLUMN'});
    expect(await validate("select jsonb_extract_path_text(n.payload, 'lazada', 'access_token') as v from explore_fixture_notes n")).toMatchObject({ok: false, code: 'E_BLOCKED_COLUMN'});
    for (const sql of ["select n.payload::text as v from explore_fixture_notes n where n.id = 1", "select n.payload->>'lazada' as v from explore_fixture_notes n where n.id = 1"]) {
      const ok = await validate(sql);
      if (!ok.ok) throw new Error(`${sql}: ${ok.code}`);
      const r = await run(ok.sent, {timeoutMs: 3000, maxRows: 5});
      expect(r.rows, sql).toEqual([[expect.stringMatching(/"access_token":"\[hidden\]"/)]]); // the whole value, the fixture- prefix too
      expect(r.hidden, sql).toBe(1);
    }
  });
});
