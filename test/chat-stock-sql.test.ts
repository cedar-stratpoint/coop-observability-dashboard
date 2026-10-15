import {describe, expect, it} from 'vitest';
import {readFileSync} from 'node:fs';
import {CHAT_RELATIONS, FORBIDDEN_COLUMNS} from '../src/chat/read/relations';

// Task 8 DDL contract on the SQL TEXT: the three stock registry views and the pos_orders_completed default view.
const text = (f: string): string => readFileSync(`supabase/${f}`, 'utf8').replace(/--[^\n]*/g, ' ').toLowerCase().replace(/\s+/g, ' ');

describe('supabase/coop_chat_stock.sql', () => {
  const sql = text('coop_chat_stock.sql');
  const reads = CHAT_RELATIONS.ro_role;
  it('creates exactly the three stock views, each selecting the columns the loader reads', () => {
    const views = [...sql.matchAll(/create or replace view public\.(\w+) as select (.+?) from /g)].map((m) => [m[1], m[2].split(',').map((c) => c.trim())]);
    expect(Object.fromEntries(views)).toEqual({
      [reads.tables.stock]: reads.columns.stock.split(','),
      [reads.tables.saleMovements]: reads.columns.saleMovements.split(','),
      [reads.tables.stockConfig]: reads.columns.stockConfig.split(','),
    });
  });
  it('filters at the source (sales only, one settings key), forbids customer columns, never uses security_invoker, creates no tables', () => {
    expect(sql).toContain("where reason = 'sale'");
    expect(sql).toContain("where key = 'stock_forecast_config'");
    for (const col of FORBIDDEN_COLUMNS) expect(new RegExp(`\\b${col}\\b`).test(sql), col).toBe(false);
    expect(sql).not.toMatch(/security_invoker|create table|alter table/);
  });
  it('revokes from public, anon, authenticated and grants select to coop_chat_ro only', () => {
    expect(sql).toMatch(/revoke all on public\.coop_chat_stock_by_location, public\.coop_chat_sale_movements, public\.coop_chat_stock_config from public, anon, authenticated/);
    expect(sql).toMatch(/grant select on public\.coop_chat_stock_by_location, public\.coop_chat_sale_movements, public\.coop_chat_stock_config to coop_chat_ro;/);
    expect(sql.match(/grant /g)).toHaveLength(1);
  });
});

describe('supabase/coop_chat_default_views.sql', () => {
  const sql = text('coop_chat_default_views.sql');
  it('pos_orders_completed filters on status only, with the dashboard rule (not voided, null-safe); no test-order marker is invented', () => {
    expect(sql).toContain("create or replace view public.pos_orders_completed as select o.* from public.pos_orders o where o.status is distinct from 'voided';");
  });
  it('is granted to coop_explore_ro only', () => {
    expect(sql).toContain('revoke all on public.pos_orders_completed from public, anon, authenticated;');
    expect(sql).toContain('grant select on public.pos_orders_completed to coop_explore_ro;');
  });
});
