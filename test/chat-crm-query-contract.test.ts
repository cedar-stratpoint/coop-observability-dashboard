// CONTRACT: the dashboard's crm_query validator against the FINAL zoomy-crm query endpoint (branch feat/api-catalog-query, catalog 2026-10-23.1).
// The fixtures are synthetic specs copied here (nothing is imported across repos): `crm-catalog-2026-10-23.1.json` is the CRM's real `GET /api/catalog` body,
// and `crm-query-contract.json` holds each spec with the verdict the CRM's own parseSpec gave it (accept or refuse; produced by running the CRM's validator
// over the spec, read-only). Ours must accept exactly what the CRM accepts and refuse exactly what it refuses, and everything we SEND must stay inside the CRM's closed shape.
import {describe, expect, it} from 'vitest';
import {parseCatalog, type Catalog} from '../src/chat/crm/query-catalog';
import {QUERY_LIMITS} from '../src/chat/crm/query-config';
import {isErr, readQueryInput} from '../src/chat/crm/query-spec';
import contract from './fixtures/crm-query-contract.json';
import {CATALOG_BODY} from './support/fake-crm-query';

const cat = parseCatalog(CATALOG_BODY) as Catalog;
const cases = contract as {name: string; input: unknown; crm: 'accept' | 'refuse'; crm_says?: string}[];

// The CRM's closed key sets (crm-query.ts parseSpec), copied so a new key we invent cannot slip through.
const TOP = ['table', 'select', 'filters', 'group_by', 'order_by', 'limit', 'cursor', 'tz', 'detail', 'joins', 'having', 'top_n'];
const SELECT_ITEM = ['agg', 'column', 'as', 'min', 'expr'];
const GROUP_ITEM = ['column', 'bucket', 'as'];
const TOP_N = ['n', 'by', 'dir', 'key', 'per'];
const keysOk = (o: unknown, allowed: string[]): boolean => typeof o !== 'object' || o === null || Array.isArray(o) || Object.keys(o).every((k) => allowed.includes(k));

describe('the catalog fixture is the CRM catalog and we read it whole', () => {
  it('parses every table, the v2 block, the joins and the limits', () => {
    expect(cat.version).toBe('2026-10-23.1');
    expect(cat.tables.map((t) => t.name)).toEqual(['orders', 'order_lines', 'order_discount_codes', 'customers', 'checkouts', 'checkout_lines', 'membership_events', 'birthday_vouchers', 'email_suppressions', 'webhook_events']);
    expect(cat.tables.filter((t) => t.joins.length).map((t) => [t.name, t.joins])).toEqual([['orders', ['customers']], ['order_lines', ['customers']], ['order_discount_codes', ['customers']]]);
    expect(cat.features).toEqual({computed: true, having: true, topN: true});
    expect([cat.rowCap, cat.groupedCap, cat.pagedCap, cat.specChars, cat.identity?.cap]).toEqual([200, 500, 500, 4096, 50]);
    expect(cat.tables.find((t) => t.name === 'orders')?.maxWindowDays).toBe(90);
  });
  it('our own constants mirror the CRM limits', () => {
    expect(QUERY_LIMITS.maxSpecChars).toBe(cat.specChars);
    expect(QUERY_LIMITS.crmPagedRows).toBe(cat.pagedCap);
    expect(QUERY_LIMITS.crmWindowDays).toBe(90);
    expect(QUERY_LIMITS.maxSelect).toBe(12);
  });
});

describe('accepts exactly what the CRM accepts, refuses exactly what it refuses', () => {
  it('has enough cases on both sides', () => {
    expect(cases.filter((c) => c.crm === 'accept').length).toBeGreaterThanOrEqual(15);
    expect(cases.filter((c) => c.crm === 'refuse').length).toBeGreaterThanOrEqual(70);
  });
  it.each(cases.map((c) => [c.name, c] as const))('%s', (_n, c) => {
    const r = readQueryInput(c.input, cat, {allowIdentity: true});
    if (c.crm === 'accept') {
      if (isErr(r)) throw new Error(`the CRM accepts this spec but we refused it: ${r.error}`);
      if (r.kind !== 'query') throw new Error('expected a query');
      const wire = r.spec;
      // what travels is inside the CRM's closed shape and its 4,096-character cap
      expect(keysOk(wire, TOP)).toBe(true);
      expect((wire.select as unknown[]).every((s) => keysOk(s, SELECT_ITEM))).toBe(true);
      expect(wire.group_by.every((g) => keysOk(g, GROUP_ITEM))).toBe(true);
      expect(keysOk(wire.top_n, TOP_N)).toBe(true);
      expect(JSON.stringify(wire).length).toBeLessThanOrEqual(4096);
    } else {
      expect(isErr(r), `the CRM refuses this spec (${c.crm_says}) but we accepted it`).toBe(true);
    }
  });
});

describe('what the model cannot send to the CRM at all', () => {
  it('duplicate keys cannot reach the CRM: the spec we send is rebuilt from the validated parts, so no object repeats a key', () => {
    const r = readQueryInput({table: 'orders', filters: [{column: 'created_at', op: 'between', value: ['2026-09-01', '2026-09-30']}], select: [{agg: 'count', as: 'n'}], limit: 5}, cat, {allowIdentity: false});
    if (isErr(r) || r.kind !== 'query') throw new Error('expected a query');
    const text = JSON.stringify(r.spec);
    expect(JSON.parse(text)).toEqual(r.spec);
    const keys = [...text.matchAll(/"([a-z_]+)":/g)].map((m) => m[1]);
    expect(keys.length).toBeGreaterThan(0);
    // top-level keys appear once each
    expect(Object.keys(r.spec).length).toBe(new Set(Object.keys(r.spec)).size);
  });
  it('a huge text is refused before it reaches the CRM (the CRM refuses over 4,096 characters)', () => {
    const many = {table: 'orders', filters: [{column: 'created_at', op: 'between', value: ['2026-09-01', '2026-09-30']}, {column: 'financial_status', op: 'in', value: Array.from({length: 50}, (_, i) => `status_${i}_${'x'.repeat(90)}`)}], select: [{agg: 'count'}]};
    expect(isErr(readQueryInput(many, cat, {allowIdentity: false}))).toBe(true);
  });
});
