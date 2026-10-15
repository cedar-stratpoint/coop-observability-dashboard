import {describe, it, expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {CHAT_RELATIONS, FORBIDDEN_COLUMNS} from '../src/chat/read/relations';

// Layer 5 DDL contract, asserted on the SQL TEXT (comments ignored). The live
// proof (role behaviour against a database) is scripts/coop-chat-ro-*.

const raw = readFileSync(join(__dirname, '..', 'supabase', 'coop_chat_readonly.sql'), 'utf8');
const sql = raw.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ').toLowerCase();
const statements = sql.split(';').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);

const CONTRACT = {
  coop_chat_orders: ['id', 'subtotal', 'discount', 'total', 'oversold', 'payment_method', 'status', 'created_at', 'edited_at', 'event_id', 'pet_type'],
  coop_chat_order_items: ['id', 'order_id', 'product_id', 'bundle_id', 'bundle_group', 'qty', 'unit_price', 'line_total'],
  coop_chat_products: ['product_id', 'name'],
  coop_chat_bundles: ['bundle_id', 'name'],
  coop_chat_prices: ['product_id', 'price'],
  coop_chat_price_changes: ['id', 'product_id', 'old_price', 'new_price', 'changed_at'],
  coop_chat_events: ['event_id', 'name', 'venue', 'city', 'starts_on', 'ends_on', 'status', 'created_at'],
} as const;

const viewStatements = statements.filter((s) => /^create (or replace )?view /.test(s));

function columnsOf(statement: string): string[] {
  const m = /^create or replace view public\.\w+ as select (.+?) from /.exec(statement);
  if (!m) throw new Error(`cannot parse view: ${statement}`);
  return m[1].split(',').map((c) => c.trim().split(/\s+/).pop() as string);
}
const viewStatement = (name: string): string => {
  const s = viewStatements.find((v) => v.startsWith(`create or replace view public.${name} `));
  if (!s) throw new Error(`view ${name} not created with "create or replace view public.${name}"`);
  return s;
};
const splitCols = (list: string): string[] => list.split(',').map((c) => c.trim());

describe('supabase/coop_chat_readonly.sql', () => {
  it('creates role coop_chat_ro as nologin', () => {
    // The statement may sit inside an idempotent DO block, so match the whole text.
    const create = /create role coop_chat_ro ([^;]*);/.exec(sql.replace(/\s+/g, ' '));
    expect(create).not.toBeNull();
    const attrs = (create as RegExpExecArray)[1].split(' ');
    expect(attrs).toContain('nologin');
    for (const bad of ['login', 'superuser', 'bypassrls', 'createdb', 'createrole', 'replication', 'inherit']) expect(attrs).not.toContain(bad);
  });

  it('creates exactly the seven coop_chat_* views', () => {
    const names = viewStatements.map((s) => /^create or replace view public\.(\w+) /.exec(s)?.[1]);
    expect(viewStatements.every((s) => s.startsWith('create or replace view public.'))).toBe(true);
    expect([...names].sort()).toEqual(Object.keys(CONTRACT).sort());
  });

  it('each view lists exactly the contract columns', () => {
    for (const [name, cols] of Object.entries(CONTRACT)) {
      expect(columnsOf(viewStatement(name)), name).toEqual(cols);
    }
  });

  it('each view covers every column the chat reads, plus id for ordering', () => {
    const reads = CHAT_RELATIONS.ro_role;
    const needed: Record<keyof typeof CONTRACT, string[]> = {
      coop_chat_orders: [...splitCols(reads.columns.orders), 'id'],
      coop_chat_order_items: [...splitCols(reads.columns.items), 'id'],
      coop_chat_products: splitCols(reads.columns.products),
      coop_chat_bundles: splitCols(reads.columns.bundles),
      coop_chat_prices: splitCols(reads.columns.prices),
      coop_chat_price_changes: splitCols(reads.columns.priceChanges),
      coop_chat_events: splitCols(reads.columns.events),
    };
    const {stock, saleMovements, stockConfig, ...orderTables} = reads.tables; // the three stock views live in coop_chat_stock.sql
    expect([stock, saleMovements, stockConfig]).toEqual(['coop_chat_stock_by_location', 'coop_chat_sale_movements', 'coop_chat_stock_config']);
    expect(orderTables).toEqual({
      orders: 'coop_chat_orders',
      items: 'coop_chat_order_items',
      products: 'coop_chat_products',
      bundles: 'coop_chat_bundles',
      events: 'coop_chat_events',
      prices: 'coop_chat_prices',
      priceChanges: 'coop_chat_price_changes',
    });
    // Every ro_role relation has a view, and the views are the contract (a superset of what is read).
    expect(Object.values(orderTables).sort()).toEqual(Object.keys(CONTRACT).sort());
    for (const [name, cols] of Object.entries(needed)) {
      const have = columnsOf(viewStatement(name));
      for (const c of cols) expect(have, `${name} missing ${c}`).toContain(c);
    }
  });

  it('no forbidden customer column appears in any view definition', () => {
    for (const s of viewStatements) {
      for (const col of FORBIDDEN_COLUMNS) {
        expect(new RegExp(`\\b${col}\\b`).test(s), `${col} in ${s.slice(0, 60)}`).toBe(false);
      }
    }
  });

  it('never uses security_invoker', () => {
    expect(sql).not.toMatch(/security_invoker/);
  });

  it('grants coop_chat_ro only select on the seven views (plus schema usage)', () => {
    const grants = statements.filter((s) => /^grant /.test(s));
    const selected: string[] = [];
    for (const g of grants) {
      if (g === 'grant coop_chat_ro to authenticator') continue; // role membership PostgREST needs
      if (g === 'grant usage on schema public to coop_chat_ro') continue;
      const m = /^grant select on (?:table )?(.+) to coop_chat_ro$/.exec(g);
      expect(m, `unexpected grant: ${g}`).not.toBeNull();
      for (const rel of splitCols((m as RegExpExecArray)[1])) {
        expect(rel).toMatch(/^public\.coop_chat_\w+$/);
        selected.push(rel.replace('public.', ''));
      }
    }
    expect([...selected].sort()).toEqual(Object.keys(CONTRACT).sort());
    for (const g of grants) {
      expect(g).not.toMatch(/\b(insert|update|delete|truncate|references|trigger|execute|all)\b/);
      expect(g).not.toMatch(/\bpos_\w+/);
    }
  });

  it('revokes all on each view from public, anon, authenticated', () => {
    const revokes = statements.filter((s) => /^revoke all on /.test(s));
    for (const name of Object.keys(CONTRACT)) {
      const revoke = revokes.find((s) => splitCols(/^revoke all on (?:table )?(.+?) from /.exec(s)?.[1] ?? '').includes(`public.${name}`));
      expect(revoke, `revoke for ${name}`).toBeDefined();
      const who = splitCols((revoke as string).split(' from ')[1]);
      for (const r of ['public', 'anon', 'authenticated']) expect(who).toContain(r);
    }
  });

  it('has no alter default privileges and no drop', () => {
    expect(sql).not.toMatch(/alter\s+default\s+privileges/);
    expect(sql).not.toMatch(/\bdrop\b/);
  });
});
