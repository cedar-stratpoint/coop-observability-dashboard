// Static checks on the worked examples (spec 6.6). The Integrator's chat-explore-examples-validate.test.ts runs them through
// validateExploreSql and the local database; this file never imports the parser.
import {describe, expect, it} from 'vitest';
import {EXPLORE_VIEWS, EXPLORE_VIEW_NAMES, baseRelation} from '../src/chat/explore/views';
import {EXPLORE_EXAMPLES, buildExamplesText} from '../src/chat/explore/examples';
import {estimateTokens} from '../src/chat/skills/load';

const FORBIDDEN_FIGURES = ['106,950', '147,300', '40,350', '71,050', '18,050', '17,850', '139,360', '32,410', '23.3', '66.4', '16.9', '16.7', '11,822', '99,250'];
const REAL_NAMES = ['SM Aura', 'Circuit Makati', 'Modern Market', 'Salmon Bites', 'Chicken Jerky'];
const SUFFIX = /_(php|pct|count|units|ratio)$/;
const views = new Set<string>(EXPLORE_VIEW_NAMES);
const colsOfView = (v: string): string[] => [...EXPLORE_VIEWS[v as keyof typeof EXPLORE_VIEWS].columns, ...EXPLORE_VIEWS[v as keyof typeof EXPLORE_VIEWS].optionalColumns];
// Train 3: examples use the base table names. A base table's columns are the union over the Explore views whose source it is (views.ts baseRelation).
// pos_orders_completed is pos_orders filtered to completed (Task 8): same columns.
const viewsOf = (rel: string): string[] => (rel === 'pos_orders_completed' ? viewsOf('pos_orders') : views.has(rel) ? [rel] : EXPLORE_VIEW_NAMES.filter((v) => baseRelation(v) === rel));
const isKnown = (rel: string): boolean => viewsOf(rel).length > 0;
const colsOf = (rel: string): string[] => viewsOf(rel).flatMap(colsOfView);
const ctes = (sql: string) => [...sql.matchAll(/(?:\bwith|,)\s+([a-z_]\w*)\s+as\s*\(/gi)].map((m) => m[1].toLowerCase());
const KEYWORDS = new Set(['join', 'left', 'right', 'inner', 'on', 'where', 'group', 'order', 'limit', 'as']);

/** relation -> alias map for every `from x [as] a` and `join x [as] a` (skips `extract(hour from col)`). */
function relations(sql: string): {name: string; alias: string}[] {
  return [...sql.matchAll(/\b(?:from|join)\s+([a-z_]\w*)\b(?!\.)(?:\s+(?:as\s+)?([a-z_]\w*))?/gi)].map((m) => ({
    name: m[1].toLowerCase(),
    alias: m[2] && !KEYWORDS.has(m[2].toLowerCase()) ? m[2].toLowerCase() : m[1].toLowerCase(),
  }));
}

/** select items at depth 0 of every select list (split on top-level commas). */
function selectItems(sql: string): string[] {
  const items: string[] = [];
  const re = /\bselect\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql))) {
    let depth = 0, cur = '', i = m.index + 6;
    for (; i < sql.length; i++) {
      const ch = sql[i];
      if (ch === '(') depth++;
      if (ch === ')') { if (depth === 0) break; depth--; }
      if (depth === 0 && /^\s+from\b/i.test(sql.slice(i, i + 6)) ) break;
      if (depth === 0 && ch === ',') { items.push(cur.trim()); cur = ''; continue; }
      cur += ch;
    }
    items.push(cur.trim());
  }
  return items;
}

describe('the examples', () => {
  it('ids are exactly E01 to E18, unique, each with a question and teaches', () => {
    expect(EXPLORE_EXAMPLES.map((e) => e.id)).toEqual(Array.from({length: 18}, (_, i) => `E${String(i + 1).padStart(2, '0')}`));
    for (const e of EXPLORE_EXAMPLES) {
      expect(e.question.length, e.id).toBeGreaterThan(0);
      expect(e.teaches.length, e.id).toBeGreaterThan(0);
    }
  });
  it.each(EXPLORE_EXAMPLES.map((e) => [e.id, e] as const))('%s: relations are catalog tables, Explore views or CTEs and columns exist', (_id, e) => {
    const local = new Set(ctes(e.sql));
    const rels = relations(e.sql);
    expect(rels.length).toBeGreaterThan(0);
    for (const r of rels) expect(isKnown(r.name) || local.has(r.name), `${e.id} relation ${r.name}`).toBe(true);
    const aliasToView = new Map(rels.filter((r) => isKnown(r.name)).map((r) => [r.alias, r.name]));
    for (const m of e.sql.matchAll(/\b([a-z_]\w*)\.([a-z_]\w*)\b/gi)) {
      const v = aliasToView.get(m[1].toLowerCase());
      if (v) expect(colsOf(v), `${e.id} ${m[0]}`).toContain(m[2].toLowerCase());
    }
  });
  it('the gate can fail: an unknown relation and an unknown column are caught', () => {
    expect(relations('select 1 from nope_table o').every((r) => isKnown(r.name))).toBe(false);
    expect(colsOf('pos_orders')).not.toContain('revenue');
    expect(colsOf('coop_explore_orders')).toEqual(colsOf('pos_orders'));
  });
  it('names every column: no select * and no alias.*', () => {
    for (const e of EXPLORE_EXAMPLES) {
      expect(e.sql, e.id).not.toMatch(/select\s+\*/i);
      expect(e.sql, e.id).not.toMatch(/\.\*/);
    }
  });
  it('every aggregated select item ends in a unit-suffixed alias', () => {
    for (const e of EXPLORE_EXAMPLES) {
      for (const item of selectItems(e.sql)) {
        if (!/\b(count|sum|avg|round)\s*\(/i.test(item)) continue;
        const alias = /\bas\s+([a-z_]\w*)\s*$/i.exec(item)?.[1] ?? '';
        expect(alias, `${e.id}: ${item}`).toMatch(SUFFIX);
      }
    }
  });
  it('carries no figure of 3 or more digits (besides 100.0 and date literals), no peso sign, no real name', () => {
    for (const e of EXPLORE_EXAMPLES) {
      const s = e.sql.replace(/date '[^']*'/g, '').replace(/100\.0/g, '');
      expect(s, e.id).not.toMatch(/\d{3,}|₱/);
      for (const n of REAL_NAMES) expect(e.sql + e.question, `${e.id} ${n}`).not.toContain(n);
      for (const f of FORBIDDEN_FIGURES) expect(e.sql + e.question, `${e.id} ${f}`).not.toContain(f);
    }
  });
  it('the grain examples keep to the order grain', () => {
    const e13 = EXPLORE_EXAMPLES.find((e) => e.id === 'E13')!.sql;
    expect(e13).toMatch(/product_id is null/);
    const e15 = EXPLORE_EXAMPLES.find((e) => e.id === 'E15')!.sql;
    expect(e15).toMatch(/bundle_group is null/);
  });
  it('the examples text fits 2,400 estimated tokens and is deterministic', () => {
    const t = buildExamplesText();
    console.log(`explore examples: ${t.length} characters, about ${estimateTokens(t)} tokens`);
    expect(estimateTokens(t)).toBeLessThanOrEqual(2400);
    expect(buildExamplesText()).toBe(t);
    for (const e of EXPLORE_EXAMPLES) expect(t).toContain(e.id);
  });
});

describe('E02 labels each event by one spelling per event (live test 5, A7)', () => {
  it('groups by lower(btrim(e.name)) and labels with min(min(btrim(e.name) collate "C")) over the same partition', async () => {
    const {EXPLORE_EXAMPLES: ex} = await import('../src/chat/explore/examples');
    const e02 = ex.find((e) => e.id === 'E02')!;
    expect(e02.sql).toMatch(/select min\(min\(btrim\(e\.name\) collate "C"\)\) over \(partition by lower\(btrim\(e\.name\)\)\) as event/);
    expect(e02.sql).toMatch(/group by lower\(btrim\(e\.name\)\)/);
    expect(e02.sql).not.toMatch(/lower\(btrim\(e\.name\)\) as event/);
    expect(e02.teaches.join(' ')).not.toMatch(/never min\(\)/);
  });
});
