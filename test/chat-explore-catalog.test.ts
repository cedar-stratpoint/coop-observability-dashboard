// Sync tests for the Explore catalog (spec 6.5): every view and column of EXPLORE_VIEWS documented, no extras, no blocked
// column, no real figure or date in the cached text, deterministic, within budget.
import {describe, expect, it} from 'vitest';
import {EXPLORE_BLOCKED_COLUMN_RE} from '../src/chat/explore/types';
import {EXPLORE_VIEWS, EXPLORE_VIEW_NAMES, type ExploreViewName} from '../src/chat/explore/views';
import {CATALOG, buildExploreCatalogText} from '../src/chat/explore/catalog';
import {estimateTokens} from '../src/chat/skills/load';

const FORBIDDEN_FIGURES = ['106,950', '147,300', '40,350', '71,050', '18,050', '17,850', '139,360', '32,410', '23.3', '66.4', '16.9', '16.7', '11,822', '99,250'];
const allColumns = (v: ExploreViewName): string[] => [...EXPLORE_VIEWS[v].columns, ...EXPLORE_VIEWS[v].optionalColumns];
// The gate as a pure function, so a test can plant a gap and watch it fail.
const drift = (documented: string[], real: string[]) => ({missing: real.filter((c) => !documented.includes(c)), extra: documented.filter((c) => !real.includes(c))});

describe('the catalog documents exactly the Explore views', () => {
  it('has a doc for every view and no other', () => {
    expect(Object.keys(CATALOG).sort()).toEqual([...EXPLORE_VIEW_NAMES].sort());
  });
  it.each(EXPLORE_VIEW_NAMES)('%s: documented columns equal the verified and optional columns', (v) => {
    expect(drift(Object.keys(CATALOG[v].columns), allColumns(v))).toEqual({missing: [], extra: []});
  });
  it('the gate can fail: a missing and an extra column are both reported', () => {
    expect(drift(['id', 'ghost'], ['id', 'total'])).toEqual({missing: ['total'], extra: ['ghost']});
  });
  it('documents no blocked column', () => {
    const blocked = EXPLORE_VIEW_NAMES.flatMap((v) => Object.keys(CATALOG[v].columns).filter((c) => EXPLORE_BLOCKED_COLUMN_RE.test(c)));
    expect(blocked).toEqual([]);
  });
});

describe('every doc is filled and carries no real data', () => {
  it('has a non-empty about, grain, meaning and coverage', () => {
    for (const v of EXPLORE_VIEW_NAMES) {
      expect(CATALOG[v].about.length, v).toBeGreaterThan(0);
      expect(CATALOG[v].grain, v).toBe(EXPLORE_VIEWS[v].grain);
      for (const [c, d] of Object.entries(CATALOG[v].columns)) {
        expect(d.meaning.length, `${v}.${c} meaning`).toBeGreaterThan(0);
        expect(d.coverage.length, `${v}.${c} coverage`).toBeGreaterThan(0);
      }
    }
  });
  it('meaning, coverage and rules carry no date and no figure', () => {
    for (const v of EXPLORE_VIEW_NAMES) {
      for (const [c, d] of Object.entries(CATALOG[v].columns)) {
        for (const s of [d.meaning, d.coverage, ...(d.rules ?? [])]) {
          expect(s, `${v}.${c}`).not.toMatch(/\d{4}|\d{1,2}[,.]\d{3}/);
        }
      }
    }
  });
  it('outside the format samples there is no digit run of 4 or more and no forbidden figure', () => {
    let t = buildExploreCatalogText();
    for (const v of EXPLORE_VIEW_NAMES) for (const d of Object.values(CATALOG[v].columns)) for (const s of d.samples) t = t.split(s).join('');
    expect(t).not.toMatch(/\d{4,}/);
    for (const f of FORBIDDEN_FIGURES) expect(t, f).not.toContain(f);
  });
  it('samples are formats: a fictional date shape at most, never a production-looking number', () => {
    for (const v of EXPLORE_VIEW_NAMES) for (const d of Object.values(CATALOG[v].columns)) for (const s of d.samples) expect(s).not.toMatch(/\d{5,}|₱/);
  });
});

describe('the rendered text', () => {
  const text = buildExploreCatalogText();
  it('is byte-identical across calls', () => {
    expect(buildExploreCatalogText()).toBe(text);
  });
  it('fits 3,200 estimated tokens', () => {
    const tokens = estimateTokens(text);
    console.log(`explore catalog: ${text.length} characters, about ${tokens} tokens`);
    expect(tokens).toBeLessThanOrEqual(3200);
  });
  it('names every view and every column', () => {
    for (const v of EXPLORE_VIEW_NAMES) {
      expect(text).toContain(`${v} (from `);
      for (const c of allColumns(v)) expect(text, `${v}.${c}`).toMatch(new RegExp(`\\b${c}\\b`));
    }
  });
  it('carries the house facts the model needs on the right columns', () => {
    expect(text).toMatch(/pet_type[^\n]*null/);
    expect(text).toMatch(/line_total[^\n]*0/);
    expect(text).toMatch(/pet[^\n]*name \/ breed/);
  });
});

describe('the catalog names each view source', () => {
  it('every view header carries (from <source>', () => {
    const text = buildExploreCatalogText();
    for (const v of EXPLORE_VIEW_NAMES) {
      const header = text.split('\n').find((l) => l.startsWith(`${v} (from `)) ?? '';
      expect(header, v).toContain(`(from ${EXPLORE_VIEWS[v].source}`);
    }
  });
  it('stock_event carries the location where-clause', () => {
    const header = buildExploreCatalogText().split('\n').find((l) => l.startsWith('coop_explore_stock_event ')) ?? '';
    expect(header).toContain("(from pos_inventory_by_location where location = 'event')");
  });
});
