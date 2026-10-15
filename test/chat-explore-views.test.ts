import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';
import {EXPLORE_VIEWS, EXPLORE_VIEW_NAMES, type ExploreViewName} from '../src/chat/explore/views';
import {EXPLORE_BLOCKED_COLUMN_PATTERN, EXPLORE_BLOCKED_COLUMN_RE, EXPLORE_COLUMN_PATTERN_EXCEPTIONS, EXPLORE_ROLE, isBlockedColumnName} from '../src/chat/explore/types';

// Spec 2.1 to 2.5 and 9.1: views.ts is the single TypeScript source of truth; supabase/coop_chat_explore.sql builds the views,
// supabase/coop_chat_explore_checks.sql proves them. These tests keep the three in step (a drift here is a failing test, not a
// surprise on staging). Pure file reads: no database.

const SQL = readFileSync('supabase/coop_chat_explore.sql', 'utf8');
const CHECKS = readFileSync('supabase/coop_chat_explore_checks.sql', 'utf8');
const code = (sql: string) => sql.replace(/--.*$/gm, '');

const EXPECTED_ORDER = [
  'coop_explore_orders', 'coop_explore_order_items', 'coop_explore_products', 'coop_explore_bundles', 'coop_explore_bundle_items',
  'coop_explore_events', 'coop_explore_prices', 'coop_explore_price_changes', 'coop_explore_event_leads', 'coop_explore_digest',
  'coop_explore_inventory', 'coop_explore_inventory_by_location', 'coop_explore_inventory_lots', 'coop_explore_stock_movements',
  'coop_explore_stock_event',
];

describe('EXP-02 views.ts', () => {
  it('has the fifteen views, in order', () => {
    expect(EXPLORE_VIEW_NAMES).toEqual(EXPECTED_ORDER);
    expect(EXPLORE_VIEW_NAMES).toHaveLength(15);
  });

  it('maps every view to its source table', () => {
    expect(Object.fromEntries(EXPLORE_VIEW_NAMES.map((v) => [v, EXPLORE_VIEWS[v].source]))).toEqual({
      coop_explore_orders: 'pos_orders', coop_explore_order_items: 'pos_order_items', coop_explore_products: 'pos_products',
      coop_explore_bundles: 'pos_bundles', coop_explore_bundle_items: 'pos_bundle_items', coop_explore_events: 'pos_events',
      coop_explore_prices: 'pos_prices', coop_explore_price_changes: 'pos_price_changes', coop_explore_event_leads: 'spin_wheel_leads',
      coop_explore_digest: 'digest_archive', coop_explore_inventory: 'pos_inventory', coop_explore_inventory_by_location: 'pos_inventory_by_location',
      coop_explore_inventory_lots: 'pos_inventory_lots', coop_explore_stock_movements: 'pos_stock_movements',
      coop_explore_stock_event: 'pos_inventory_by_location',
    });
  });

  it('the Event-stock default view is filtered to the event location in SQL', () => {
    expect(SQL).toMatch(/create view public\.coop_explore_stock_event as select product_id, stock from public\.pos_inventory_by_location where location = 'event'/);
  });

  it('lists the verified columns of spec 2.2 (the leads view carries instagram and pet; orders carry the contact and cash fields)', () => {
    expect(EXPLORE_VIEWS.coop_explore_orders.columns).toEqual(['id', 'client_uuid', 'subtotal', 'discount', 'total', 'oversold', 'device_id', 'payment_method', 'customer_handle', 'status', 'remarks', 'created_at', 'edited_at', 'event_id', 'pet_type']);
    expect(EXPLORE_VIEWS.coop_explore_event_leads.columns).toEqual(['lead_id', 'email', 'mobile', 'prize', 'campaign', 'collected_at', 'consent_at', 'created_at', 'instagram', 'pet']);
    expect(EXPLORE_VIEWS.coop_explore_digest.columns).toContain('bundle');
    expect([...EXPLORE_VIEWS.coop_explore_prices.optionalColumns]).toEqual(['currency', 'updated_by', 'updated_at']);
    expect([...EXPLORE_VIEWS.coop_explore_price_changes.optionalColumns]).toEqual(['reason', 'changed_by', 'device_id']);
  });

  it('has no duplicate column and a type for every column, none unknown', () => {
    for (const v of EXPLORE_VIEW_NAMES) {
      const all = [...EXPLORE_VIEWS[v].columns, ...EXPLORE_VIEWS[v].optionalColumns] as string[];
      expect(new Set(all).size, v).toBe(all.length);
      const types = EXPLORE_VIEWS[v].types as Record<string, string>;
      expect(Object.keys(types).sort(), v).toEqual([...all].sort());
      for (const t of Object.values(types)) expect(t).toMatch(/^(text|bigint|integer|numeric|boolean|uuid|date|timestamptz|jsonb|text\[\])$/);
      expect(EXPLORE_VIEWS[v].grain.length).toBeGreaterThan(5);
    }
  });

  it('A4: no column of any view matches the blocked-name pattern', () => {
    for (const v of EXPLORE_VIEW_NAMES) {
      for (const c of [...EXPLORE_VIEWS[v].columns, ...EXPLORE_VIEWS[v].optionalColumns] as string[]) {
        expect(isBlockedColumnName(c), `${v}.${c}`).toBe(false);
        expect(EXPLORE_BLOCKED_COLUMN_RE.test(c), `${v}.${c}`).toBe(false);
      }
    }
  });

  it('the pattern really blocks what it must, case-insensitively, and over-blocks on purpose (fails closed)', () => {
    for (const n of ['password', 'PASSWORD', 'api_key', 'access_token', 'client_secret', 'pin', 'pin_hash', 'credentials', 'Hash', 'monkey', 'shipping_fee']) {
      expect(isBlockedColumnName(n), n).toBe(true);
    }
    for (const n of ['email', 'mobile', 'instagram', 'pet', 'remarks', 'customer_handle', 'opening_cash', 'bundle', 'digest']) expect(isBlockedColumnName(n), n).toBe(false);
  });

  it('the exception list is empty and stays empty until a reviewed diff changes this test', () => {
    expect(EXPLORE_COLUMN_PATTERN_EXCEPTIONS).toEqual([]);
  });

  it('exposes no view of the registry path: only coop_explore_ names, none of the seven coop_chat_ views', () => {
    for (const v of EXPLORE_VIEW_NAMES) expect(v).toMatch(/^coop_explore_[a-z_]+$/);
    expect((EXPLORE_VIEW_NAMES as string[]).some((v) => v.startsWith('coop_chat_'))).toBe(false);
  });
});

describe('EXP-02 supabase/coop_chat_explore.sql stays in step with views.ts and types.ts', () => {
  const pairsBlock = /pairs constant text\[\] := array\[([\s\S]*?)\];/.exec(SQL)?.[1] ?? '';
  const pairs = [...pairsBlock.matchAll(/'([a-z_]+)',\s*'([a-z_]+)'/g)].map((m) => [m[1], m[2]]);

  it('builds exactly the views of views.ts from the sources of views.ts, in order', () => {
    // coop_explore_stock_event is not a pass-through: it is the derived filter view built after the generator
    expect(pairs).toEqual(EXPLORE_VIEW_NAMES.filter((v) => v !== 'coop_explore_stock_event').map((v) => [v, EXPLORE_VIEWS[v].source]));
  });

  it('the blocked-name pattern appears once in the SQL and is the same string as in types.ts', () => {
    const hits = [...SQL.matchAll(/'([a-z]+(?:\|[a-z]+)+)'/g)].map((m) => m[1]);
    expect(hits).toEqual([EXPLORE_BLOCKED_COLUMN_PATTERN]);
    expect(new RegExp(hits[0], 'i').source).toBe(EXPLORE_BLOCKED_COLUMN_RE.source);
    expect(EXPLORE_BLOCKED_COLUMN_RE.flags).toContain('i');
  });

  it('the checks use the very same pattern everywhere it appears', () => {
    const hits = [...CHECKS.matchAll(/'([a-z]+(?:\|[a-z]+)+)'/g)].map((m) => m[1]);
    expect(hits.length).toBeGreaterThanOrEqual(3);
    for (const h of hits) expect(h).toBe(EXPLORE_BLOCKED_COLUMN_PATTERN);
  });

  it('views are DEFINER views (no security_invoker) built from an explicit column list, never select *', () => {
    const c = code(SQL);
    expect(c).not.toMatch(/security_invoker/i);
    expect(c).not.toMatch(/select\s+\*/i);
    expect(c).toMatch(/format\('create view public\.%I as select %s from public\.%I'/);
    expect(c).toMatch(/information_schema\.columns/);
    expect(c).toMatch(/c\.column_name !~\* blocked_re/);
  });

  it('role: LOGIN, no password in the file, CONNECTION LIMIT 10, read-only default, the six settings of spec 2.3', () => {
    const c = code(SQL);
    expect(c).toMatch(new RegExp(`create role ${EXPLORE_ROLE} login nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls connection limit 10`));
    expect(c).not.toMatch(/\bpassword\s+'/i); // the password is set once by a person (or up.sh locally), never in this file
    const settings = [...c.matchAll(new RegExp(`alter role ${EXPLORE_ROLE} set ([a-z_]+) = ('[^']*'|[a-z_]+)`, 'g'))].map((m) => `${m[1]}=${m[2].replace(/'/g, '')}`);
    expect(settings).toEqual([
      'default_transaction_read_only=on', 'statement_timeout=5s', 'lock_timeout=2s', 'idle_in_transaction_session_timeout=10s', 'search_path=public', 'timezone=Asia/Manila',
    ]);
  });

  it('the checks (i) expect exactly the settings the SQL applies', () => {
    const block = /with expected\(setting\) as \(values([\s\S]*?)\), actual as/.exec(CHECKS)?.[1] ?? '';
    const expected = [...block.matchAll(/'([^']+)'/g)].map((m) => m[1].toLowerCase());
    const sqlSettings = [...code(SQL).matchAll(new RegExp(`alter role ${EXPLORE_ROLE} set ([a-z_]+) = ('[^']*'|[a-z_]+)`, 'g'))].map((m) => `${m[1]}=${m[2].replace(/'/g, '')}`.toLowerCase());
    expect(expected.sort()).toEqual(sqlSettings.sort());
  });

  it('grants: SELECT on the views only; revokes from public, anon and authenticated; nothing on a base table, a sequence or a function', () => {
    const c = code(SQL);
    expect(c).toMatch(/revoke all on public\.%I from public, anon, authenticated/);
    expect(c).toMatch(/grant select on public\.%I to coop_explore_ro/);
    const grants = [...c.matchAll(/\bgrant\b[^;]*;/gi)].map((m) => m[0].replace(/\s+/g, ' '));
    expect(grants).toEqual([
      expect.stringContaining('grant select on public.%I to coop_explore_ro'), 'grant select on public.coop_explore_stock_event to coop_explore_ro;', 'grant usage on schema public to coop_explore_ro;',
    ]);
    expect(c).not.toMatch(/grant\s+(all|insert|update|delete|truncate|references|trigger|execute|create)/i);
    expect(c).not.toMatch(/grant\s+[a-z_]+\s+to\s+coop_explore_ro/i); // no role membership
    expect(c).not.toMatch(/on\s+(table|sequence|function|all)\b/i);
  });

  it('touches no pos_* DDL, no coop_chat objects, and does not reload PostgREST', () => {
    const c = code(SQL);
    expect(c).not.toMatch(/(create|alter|drop|truncate)\s+(table|function|trigger|policy)\b/i);
    expect(c).not.toMatch(/(create|alter|drop)\s+(or replace\s+)?(table|view)\s+(if (not )?exists\s+)?public\.pos_/i);
    expect(c).not.toMatch(/coop_chat_/);
    expect(c).not.toMatch(/notify\s+pgrst/i);
  });

  it('fails loudly, before any change, when a stock source or the location column is missing', () => {
    const c = code(SQL);
    const gate = c.indexOf("to_regclass('public.' || t)");
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(c.indexOf('create role'));
    for (const t of ['pos_inventory', 'pos_inventory_by_location', 'pos_inventory_lots', 'pos_stock_movements']) {
      expect(c, t).toContain(`'${t}'`);
    }
    expect(c).toMatch(/table_name = 'pos_inventory_by_location' and column_name = 'location'/);
    expect(c).toMatch(/raise exception 'missing stock source/);
    expect(c).toMatch(/raise exception 'public\.pos_inventory_by_location has no location column/);
  });

  it('fails loudly when the lead tables are missing (prerequisite check)', () => {
    expect(SQL).toMatch(/apply supabase\/spin_wheel_leads\.sql first/);
    expect(SQL).toMatch(/apply supabase\/spin_wheel_leads_instagram\.sql first/);
  });
});

describe('EXP-02 supabase/coop_chat_explore_checks.sql stays in step with views.ts', () => {
  it('is SELECT-only: no write, no DDL, no grant, and its one DO block only raises notices', () => {
    const c = code(CHECKS).replace(/'[^']*'/g, "''"); // privilege names such as 'INSERT,UPDATE' are string literals, not statements
    expect(c).not.toMatch(/\b(insert\s+into|update\s+\w+\s+set|delete\s+from|truncate|drop\s|create\s|alter\s|grant\s|revoke\s|copy\s|vacuum|notify)\b/i);
    const dos = [...c.matchAll(/do \$\$[\s\S]*?\$\$;/g)].map((m) => m[0]);
    expect(dos).toHaveLength(1);
    expect(dos[0]).toMatch(/raise notice/);
    expect(dos[0]).not.toMatch(/\b(insert|update|delete|execute)\b/i);
  });

  it('(g) contract values list equals views.ts exactly (verified columns, then optional columns)', () => {
    const block = /with contract\(view_name, cols, optional_cols\) as \(values([\s\S]*?)\), actual as/.exec(CHECKS)?.[1] ?? '';
    const rows = [...block.matchAll(/\('([a-z_]+)',\s*'([^']*)',\s*'([^']*)'\)/g)].map((m) => ({view: m[1], cols: m[2], optional: m[3]}));
    expect(rows).toEqual(
      EXPLORE_VIEW_NAMES.map((v) => ({view: v, cols: EXPLORE_VIEWS[v].columns.join(','), optional: EXPLORE_VIEWS[v].optionalColumns.join(',')})),
    );
  });

  it('(h) drift values list (view, source) equals views.ts', () => {
    const block = /from \(values([\s\S]*?)\) s\(view_name, source_table\)/.exec(CHECKS)?.[1] ?? '';
    const rows = [...block.matchAll(/\('([a-z_]+)',\s*'([a-z_]+)'\)/g)].map((m) => [m[1], m[2]]);
    expect(rows).toEqual(EXPLORE_VIEW_NAMES.filter((v) => v !== 'coop_explore_stock_event').map((v: ExploreViewName) => [v, EXPLORE_VIEWS[v].source]));
  });

  it('has every required query (a) to (j) and states an expected result for each', () => {
    for (const tag of ['(a)', '(b)', '(c)', '(d)', '(e)', '(f)', '(g)', '(h)', '(i)', '(j)']) expect(CHECKS, tag).toContain(`-- ${tag}`);
    expect((CHECKS.match(/EXPECTED/g) ?? []).length).toBeGreaterThanOrEqual(9);
  });

  it('never reads or prints a password value', () => {
    expect(code(CHECKS)).not.toMatch(/rolpassword\s*(,|from)/i);
    expect(code(CHECKS)).toMatch(/rolpassword is not null/i);
  });
});
