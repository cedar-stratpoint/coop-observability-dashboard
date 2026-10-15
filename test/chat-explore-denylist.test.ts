import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';
import {
  EXPLORE_APP_CLOSED_RELATIONS, EXPLORE_VIEW_ALLOWLIST, closedReason, relationRule,
} from '../src/chat/explore/access';
import {EXPLORE_DENIED_FUNCTIONS, createExploreValidator, validateExploreSql} from '../src/chat/explore/parse';

const ok = async (sql: string) => expect((await validateExploreSql(sql)).ok, sql).toBe(true);
const code = async (sql: string, c: string) => expect(await validateExploreSql(sql), sql).toMatchObject({ok: false, code: c});

describe('2.1 the parser allows any open public relation and denies secret and tenant names', () => {
  it('reads base tables, registry and default views, with or without public.', async () => {
    await ok('select o.id, o.total from pos_orders o');
    await ok('select o.id from public.pos_orders o');
    await ok('select l.lot_code, l.qty_on_hand from pos_inventory_lots l');
    await ok('select r.title, r.pinned from coop_reports r');
    await ok('select l.lead_id from spin_wheel_leads l join pos_events e on e.event_id = l.campaign');
    await ok('select o.id from coop_explore_orders o'); // the Train 1 aliases still work
    await ok("select s.key, s.value from pos_settings s where s.key = 'stock_forecast_config'"); // the reviewed exception
    await ok('select x.shipping_fee from lazada_orders x'); // whole-word rule
  });
  it('denies secret and tenant tables, other schemas, and names that are not plain lower-case', async () => {
    await code('select m.marketplace from marketplace_tokens m', 'E_RELATION');
    await code('select s.store_code from gl_stores s', 'E_RELATION');
    await code('select c.name from companies c', 'E_RELATION');
    await code('select u.email from company_users u', 'E_RELATION');
    await code('select u.id from auth.users u', 'E_RELATION');
    await code('select o.id from other.pos_orders o', 'E_RELATION');
    await code('select m.marketplace from "Marketplace_Tokens" m', 'E_RELATION');
    await code('select m.marketplace from U&"marketplace\\005ftokens" m', 'E_RELATION');
    await code('select o.id from pos_оrders o', 'E_RELATION'); // Cyrillic o
  });
  it('denies secret columns anywhere, except pos_settings.key with pos_settings in the query', async () => {
    await code('select x.api_key from explore_fixture_mixed x', 'E_BLOCKED_COLUMN');
    await code("select o.id from pos_orders o where o.pin_hash = 'x'", 'E_BLOCKED_COLUMN');
    await code('select o.key from pos_orders o', 'E_BLOCKED_COLUMN');
  });
  it('the orders status warning covers the base table too', async () => {
    const r = await validateExploreSql('select count(*) as orders_count from pos_orders o');
    expect(r.ok && r.lints.map((l) => l.code)).toEqual(['W_NO_STATUS_FILTER']);
  });
  it('mutation: a validator that allows every name lets the secret table through (the rule is load-bearing)', async () => {
    const open = createExploreValidator({relationAllowed: () => true});
    expect((await open('select m.marketplace from marketplace_tokens m')).ok).toBe(true);
  });
});

describe('2.1 JSON read as text cannot carry a secret-named key past the scanner (Task 7 review finding 1)', () => {
  it('a secret-named JSON key in -> / ->> / jsonb_extract_path_text is E_BLOCKED_COLUMN, at any position and case', async () => {
    await code("select s.value->>'api_key' as v from pos_settings s", 'E_BLOCKED_COLUMN');
    await code("select s.value->'lazada'->>'access_token' as v from pos_settings s", 'E_BLOCKED_COLUMN');
    await code("select s.value->'Refresh_Token' as v from pos_settings s", 'E_BLOCKED_COLUMN');
    await code("select s.key from pos_settings s where s.value->>'password' is not null", 'E_BLOCKED_COLUMN');
    await code("select jsonb_extract_path_text(s.value, 'access_token') as v from pos_settings s", 'E_BLOCKED_COLUMN');
    await code("select jsonb_extract_path_text(s.value, 'lazada', 'token') as v from pos_settings s", 'E_BLOCKED_COLUMN');
  });
  it('Task 7 re-review R1: camelCase, PascalCase, UPPER and glued secret JSON keys are E_BLOCKED_COLUMN too', async () => {
    for (const k of ['apiKey', 'accessToken', 'clientSecret', 'refreshToken', 'APIKey', 'ACCESS_TOKEN', 'apikey', 'x-api-key']) {
      await code(`select s.value->>'${k}' as v from pos_settings s`, 'E_BLOCKED_COLUMN');
    }
    await code("select jsonb_extract_path_text(s.value, 'lazada', 'refreshToken') as v from pos_settings s", 'E_BLOCKED_COLUMN');
    await ok("select s.value->>'shopName' as v from pos_settings s");
    await ok("select s.value->>'isPinned' as v from pos_settings s");
  });
  it('a JSON key must be a plain literal: a computed key is E_BLOCKED_COLUMN (the name cannot be judged)', async () => {
    await code("select s.value->>('api'||'_key') as v from pos_settings s", 'E_BLOCKED_COLUMN');
    await code("select s.value->>lower('API_KEY') as v from pos_settings s", 'E_BLOCKED_COLUMN');
    await code('select s.value->>s.key as v from pos_settings s', 'E_BLOCKED_COLUMN');
    await code("select jsonb_extract_path_text(s.value, upper('token')) as v from pos_settings s", 'E_BLOCKED_COLUMN');
  });
  it('ordinary JSON keys and array indexes stay readable', async () => {
    await ok("select s.value->>'threshold' as v from pos_settings s");
    await ok("select s.value->'lazada'->>'shop_name' as v from pos_settings s");
    await ok("select s.value->0->>'sku' as v from pos_settings s");
    await ok("select jsonb_extract_path_text(s.value, 'lazada', 'shop_name') as v from pos_settings s");
  });
  it('a whole-row reference (t, t::text, concat(t), public.t) is E_SELECT_STAR: name the columns', async () => {
    await code('select n::text as v from explore_fixture_notes n', 'E_SELECT_STAR');
    await code('select n from explore_fixture_notes n', 'E_SELECT_STAR');
    await code('select concat(n) as v from explore_fixture_notes n', 'E_SELECT_STAR');
    await code('select length(explore_fixture_notes::text) as v from explore_fixture_notes', 'E_SELECT_STAR');
    await code('select public.explore_fixture_notes::text as v from public.explore_fixture_notes', 'E_SELECT_STAR');
    await code('with c as (select s.value from pos_settings s) select c::text as v from c', 'E_SELECT_STAR');
    await code('select q::text as v from (select s.value from pos_settings s) q', 'E_SELECT_STAR');
    await code('select o.id from pos_orders o where o::text like \'%x%\'', 'E_SELECT_STAR');
  });
  it('columns, CTE columns and a generate_series alias stay readable', async () => {
    await ok('select n.id, n.note::text as v from explore_fixture_notes n');
    await ok('with c as (select s.value from pos_settings s) select c.value from c');
    await ok("select d.day from generate_series(date '2025-03-01', date '2025-03-05', interval '1 day') as d(day)");
    await ok("select d from generate_series(date '2025-03-01', date '2025-03-05', interval '1 day') as d");
  });
});

describe('2.1 views are default-deny in the parser too (Task 3 ruling): one allowlist, equal to the SQL', () => {
  const SQL = readFileSync('supabase/coop_chat_explore_direct.sql', 'utf8');
  const sqlAllowlist = (): string[] => {
    const m = /function coop_explore_admin\.view_allowlist\(\)[\s\S]*?array\[([^\]]*)\]/.exec(SQL);
    if (!m) throw new Error('view_allowlist not found in the SQL');
    return [...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1]);
  };
  it('the TS view allowlist equals coop_explore_admin.view_allowlist() (29 names, no duplicates)', () => {
    expect([...EXPLORE_VIEW_ALLOWLIST].sort()).toEqual(sqlAllowlist().sort());
    expect(EXPLORE_VIEW_ALLOWLIST).toHaveLength(29);
    expect(new Set(EXPLORE_VIEW_ALLOWLIST).size).toBe(29);
  });
  it('with the live relation kinds: tables open unless closed, views only when allowlisted, unknown names refused', async () => {
    const kinds = new Map<string, 'table' | 'view'>([
      ['pos_orders', 'table'], ['coop_explore_orders', 'view'], ['pos_inventory', 'view'], ['explore_fixture_qxml_view', 'view'],
      ['marketplace_tokens', 'table'], ['coop_explore_drift_log', 'table'],
    ]);
    const live = createExploreValidator({relationAllowed: relationRule(kinds)});
    for (const sql of ['select o.id from pos_orders o', 'select o.id from coop_explore_orders o', 'select i.stock from pos_inventory i', 'select d.findings_count from coop_explore_drift_log d']) {
      expect((await live(sql)).ok, sql).toBe(true);
    }
    for (const sql of ['select x.x from explore_fixture_qxml_view x', 'select m.marketplace from marketplace_tokens m', 'select n.id from brand_new_unknown n']) {
      expect(await live(sql), sql).toMatchObject({ok: false, code: 'E_RELATION'});
    }
  });
  it('mutation: a live rule that forgets the view allowlist lets an unlisted view through', async () => {
    const kinds = new Map<string, 'table' | 'view'>([['explore_fixture_qxml_view', 'table']]); // lies about the kind
    expect((await createExploreValidator({relationAllowed: relationRule(kinds)})('select x.x from explore_fixture_qxml_view x')).ok).toBe(true);
  });
  it('closedReason names why: tenant, secret, or the one-line app list (empty: the drift log is readable, Task 4 review)', () => {
    expect(closedReason('gl_sales')).toBe('tenant');
    expect(closedReason('company_users')).toBe('tenant');
    expect(closedReason('companies')).toBe('tenant');
    expect(closedReason('marketplace_tokens')).toBe('secret');
    expect(closedReason('pos_orders')).toBeNull();
    expect(EXPLORE_APP_CLOSED_RELATIONS).toEqual([]);
    expect(closedReason('coop_explore_drift_log')).toBeNull();
  });
});

describe('2.1 query-running functions, casts to user types, and anything but one SELECT are refused (Task 3 review)', () => {
  const QUERY_RUNNERS = [
    "query_to_xml('select m.marketplace from marketplace_tokens m', true, false, '')",
    "query_to_xml_and_xmlschema('select o.id from pos_orders o', true, false, '')",
    "query_to_xmlschema('select o.id from pos_orders o', true, false, '')",
    "table_to_xml('pos_orders', true, false, '')",
    "table_to_xmlschema('pos_orders', true, false, '')",
    "table_to_xml_and_xmlschema('pos_orders', true, false, '')",
    "cursor_to_xml('coop_explore_c', 1, true, false, '')",
    "cursor_to_xmlschema('coop_explore_c', true, false, '')",
    "schema_to_xml('public', true, false, '')",
    "schema_to_xmlschema('public', true, false, '')",
    "schema_to_xml_and_xmlschema('public', true, false, '')",
    "database_to_xml(true, false, '')",
    "database_to_xmlschema(true, false, '')",
    "database_to_xml_and_xmlschema(true, false, '')",
    "ts_rewrite(o.status::text, 'select 1')",
    "to_tsquery('simple', o.status)",
    "pg_catalog.query_to_xml('select 1', true, false, '')",
  ];
  it.each(QUERY_RUNNERS)('%s is E_FUNCTION_DENIED (a hard trip), not just E_FUNCTION', async (f) => {
    await code(`select ${f} as x from pos_orders o`, 'E_FUNCTION_DENIED');
  });
  it('ts_stat in FROM is denied', async () => {
    await code("select s.word from ts_stat('select to_tsvector(''simple'', m.label) from explore_fixture_mixed m') s", 'E_FUNCTION_DENIED');
  });
  it('the denylist names them (a reviewed list; any removal is a diff here)', () => {
    for (const f of ['query_to_xml', 'ts_stat', 'ts_rewrite', 'to_tsquery', 'set_config']) expect(EXPLORE_DENIED_FUNCTIONS).toContain(f);
  });
  it('casts only to the pg_catalog allowlist: a domain, a schema-qualified or a user type is E_CAST', async () => {
    await code('select o.id::explore_fixture_dom as v from explore_fixture_mixed o', 'E_CAST');
    await code('select cast(o.id as public.explore_fixture_dom) as v from explore_fixture_mixed o', 'E_CAST');
    await code('select o.status::public.text as v from pos_orders o', 'E_CAST');
    await code("select o.id from pos_orders o where o.created_at > '2026-01-01'::public.date", 'E_CAST');
    await ok('select o.status::pg_catalog.text as v from pos_orders o');
    await ok("select o.id from pos_orders o where o.created_at > date '2026-01-01'");
  });
  it('DDL, temporary objects, SET, SET ROLE and set_config are refused: only ONE top-level SELECT runs', async () => {
    await code('create temporary view tv as select o.id from pos_orders o', 'E_NOT_SELECT');
    await code('create temp view tv as select o.id from pos_orders o', 'E_NOT_SELECT');
    await code('create temp table tt (id int)', 'E_NOT_SELECT');
    await code('create temporary table tt as select o.id from pos_orders o', 'E_NOT_SELECT');
    await code('select o.id into temporary tt from pos_orders o', 'E_SELECT_INTO');
    await code('set search_path = pg_temp', 'E_NOT_SELECT');
    await code('set local search_path = pg_temp, public', 'E_NOT_SELECT');
    await code('set role postgres', 'E_NOT_SELECT');
    await code('reset role', 'E_NOT_SELECT');
    await code("select set_config('search_path', 'pg_temp', true) as x from pos_orders o", 'E_FUNCTION_DENIED');
    await code('select o.id from pos_orders o; create temp view tv as select 1', 'E_MULTI_STATEMENT');
    await code('select o.id from pg_temp.pos_orders o', 'E_CATALOG');
  });
});
