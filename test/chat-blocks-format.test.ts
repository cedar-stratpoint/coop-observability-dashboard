import {describe, expect, it} from 'vitest';
import type {ColorToken} from '../src/chat/block-types';
import {
  pieSlices,
  resolveForm,
  ariaSummary,
  axisTicks,
  formatAxis,
  formatCategory,
  formatValue,
  interleave,
  isNeutralToken,
  niceMax,
  sanitizeBlocks,
  shortLabel,
  tokenToCssVar,
  upsertBlock,
} from '../components/analyst/chat-blocks-format';
import {donut4, groupedVertical, kpiRow, plainBar, smallMultiples, tableTotal} from '../components/analyst/chat-blocks.fixtures';

describe('formatValue', () => {
  it('formats peso with up to 2 decimals and no trailing zeros', () => {
    expect(formatValue(71050, 'peso')).toBe('₱71,050');
    expect(formatValue(1234.5, 'PHP')).toBe('₱1,234.5');
    expect(formatValue(99.999, 'peso')).toBe('₱100');
    expect(formatValue(-2700, 'peso')).toBe('-₱2,700');
  });
  it('formats count and units with thousands separators', () => {
    expect(formatValue(1234, 'count')).toBe('1,234');
    expect(formatValue(1234567, 'units')).toBe('1,234,567');
  });
  it('formats percent to one decimal and ratio with an x', () => {
    expect(formatValue(66.43, 'percent')).toBe('66.4%');
    expect(formatValue(5, 'percent')).toBe('5.0%');
    expect(formatValue(3.94, 'ratio')).toBe('3.9x');
  });
  it('shows an em dash for null, never 0', () => {
    for (const f of ['peso', 'count', 'percent', 'ratio', 'PHP', 'units'] as const) {
      expect(formatValue(null, f)).toBe('—');
      expect(formatValue(undefined, f)).toBe('—');
    }
    expect(formatValue(NaN, 'count')).toBe('—');
    expect(formatValue(0, 'count')).toBe('0');
  });
  it('passes text through', () => {
    expect(formatValue('Cash', 'text')).toBe('Cash');
    expect(formatValue('', 'text')).toBe('—');
  });
});

describe('formatAxis / formatCategory', () => {
  it('compacts axis ticks', () => {
    expect(formatAxis(0, 'peso')).toBe('₱0');
    expect(formatAxis(71050, 'peso')).toBe('₱71K');
    expect(formatAxis(1500, 'count')).toBe('1.5K');
    expect(formatAxis(2_500_000, 'peso')).toBe('₱2.5M');
    expect(formatAxis(50, 'percent')).toBe('50%');
  });
  it('shortens ISO dates only for date columns', () => {
    expect(formatCategory('2026-09-11', 'date')).toBe('Sep 11');
    expect(formatCategory('2026-09-11', 'text')).toBe('2026-09-11');
    expect(formatCategory(null, 'text')).toBe('—');
  });
});

describe('tokens', () => {
  const all: ColorToken[] = ['chart-1', 'chart-2', 'chart-3', 'chart-4', 'chart-5', 'cat-1', 'cat-2', 'cat-3', 'cat-4'];
  it('maps every ColorToken to its CSS variable', () => {
    for (const t of all) expect(tokenToCssVar(t)).toBe(`var(--${t})`);
  });
  it('never emits a hex, and falls back to the neutral gray on an unknown token', () => {
    expect(tokenToCssVar('#ff0000' as ColorToken)).toBe('var(--chart-5)');
  });
  it('treats only chart-5 as neutral', () => {
    expect(all.filter(isNeutralToken)).toEqual(['chart-5']);
  });
});

describe('shortLabel / niceMax / axisTicks', () => {
  it('truncates with an ellipsis, never beyond max', () => {
    expect(shortLabel('Chicken', 10)).toBe('Chicken');
    const s = shortLabel('Chicken Breast Strips', 10);
    expect(s.length).toBeLessThanOrEqual(10);
    expect(s.endsWith('…')).toBe(true);
  });
  it('rounds the axis maximum up to a nice number', () => {
    expect(niceMax(71050)).toBe(100000);
    expect(niceMax(23)).toBe(25);
    expect(niceMax(0)).toBe(1);
  });
  it('builds evenly spaced ticks from zero', () => {
    expect(axisTicks(71050, 4)).toEqual([0, 25000, 50000, 75000, 100000]);
  });
});

describe('ariaSummary', () => {
  it('names the chart, its form and the top values', () => {
    const s = ariaSummary(plainBar);
    expect(s).toContain('Revenue by payment method');
    expect(s).toContain('bar chart');
    expect(s).toContain('Cash ₱42,300');
    expect(s).toContain('table');
  });
  it('lists series for multi-series charts and calls a pie a pie chart', () => {
    expect(ariaSummary(groupedVertical)).toContain('Dog, Cat, Both');
    expect(ariaSummary(donut4)).toContain('pie chart');
  });
  it('names at most 3 series, then "and N more" (a pivot of many columns stays readable)', () => {
    const many = {...groupedVertical, kind: 'chart' as const, chart: {...(groupedVertical as {chart: object}).chart, series: ['a', 'b', 'c', 'd', 'e'].map((k) => ({key: k, label: k, unit: 'count', entity: k, color: 'chart-1'}))}} as unknown as typeof groupedVertical;
    const s = ariaSummary(many);
    expect(s).toContain('across 5 series (a, b, c, and 2 more)');
    expect(s).not.toContain('d, e');
  });
  it('summarises tiles and tables', () => {
    expect(ariaSummary(kpiRow[0])).toContain('₱128,400');
    expect(ariaSummary(kpiRow[3])).toContain('—');
    expect(ariaSummary(tableTotal)).toContain('4 rows');
  });
});

describe('sanitizeBlocks', () => {
  it('returns an empty list for non-arrays', () => {
    for (const v of [undefined, null, 'x', 4, {}]) expect(sanitizeBlocks(v)).toEqual([]);
  });
  it('keeps well-formed blocks and defaults a bad offset to 0', () => {
    const out = sanitizeBlocks([{at: 12, block: plainBar}, {at: -3, block: tableTotal}, {block: kpiRow[0]}]);
    expect(out.map((p) => [p.block.id, p.at])).toEqual([[plainBar.id, 12], [tableTotal.id, 0], [kpiRow[0].id, 0]]);
  });
  it('drops malformed entries without throwing', () => {
    const bad = [
      null,
      7,
      {at: 1},
      {at: 1, block: null},
      {at: 1, block: {kind: 'chart'}},
      {at: 1, block: {id: 'x'}},
      {at: 1, block: {id: 'x', kind: 'nope', title: 't', caveats: []}},
      {at: 1, block: {id: 'x', kind: 'chart', title: 't', caveats: [], chart: {series: 'no', rows: [], x: {key: 'k'}}}},
      {at: 1, block: {id: 'x', kind: 'table', title: 't', caveats: [], columns: [], rows: 'no'}},
      {at: 1, block: {...plainBar, caveats: 'oops'}},
      {at: 5, block: plainBar},
    ];
    const out = sanitizeBlocks(bad);
    expect(out).toHaveLength(1);
    expect(out[0].block.id).toBe(plainBar.id);
  });
  it('keeps one entry per block id (a re-bound block replaces the old one)', () => {
    const out = sanitizeBlocks([{at: 1, block: plainBar}, {at: 9, block: plainBar}]);
    expect(out).toHaveLength(1);
    expect(out[0].at).toBe(9);
  });
});

describe('upsertBlock / interleave', () => {
  it('appends, then replaces by id keeping the original position', () => {
    const a = upsertBlock(undefined, 10, plainBar);
    const b = upsertBlock(a, 40, {...plainBar, title: 'Re-bound'});
    expect(b).toHaveLength(1);
    expect(b[0].at).toBe(10);
    expect(b[0].block.title).toBe('Re-bound');
    expect(a[0].block.title).toBe('Revenue by payment method'); // input not mutated
  });
  it('splits text at block offsets and clamps out-of-range offsets', () => {
    const pieces = interleave('Caveat. Headline. After.', [
      {at: 17, block: plainBar},
      {at: 999, block: tableTotal},
    ]);
    expect(pieces.map((p) => (p.type === 'text' ? p.text : p.blocks.map((b) => b.id).join('+')))).toEqual(['Caveat. Headline.', plainBar.id, ' After.', tableTotal.id]);
  });
  it('groups blocks that share an offset and handles no text', () => {
    const pieces = interleave('', [{at: 0, block: kpiRow[0]}, {at: 0, block: kpiRow[1]}]);
    expect(pieces).toHaveLength(1);
    expect(pieces[0].type === 'blocks' && pieces[0].blocks).toHaveLength(2);
  });
});

describe('pieSlices reads the shape the server really emits', () => {
  it('a recommendView pie has one slice per category, not one slice', async () => {
    const {recommendView} = await import('../src/chat/recommend-view');
    const rows = [{pet: 'dog', revenue: 71050}, {pet: 'cat', revenue: 18050}, {pet: 'both', revenue: 17850}, {pet: 'untagged', revenue: 40350}];
    const result = {
      id: 'r1', metric: 'bundle_sales', dimension: 'pet',
      columns: [{key: 'pet', label: 'Pet', unit: 'text', role: 'category'}, {key: 'revenue', label: 'Revenue', unit: 'PHP', role: 'measure'}],
      rows,
      meta: {source: 'live', range: {from: '2026-09-11', to: '2026-09-27', label: 'Sep 11 to Sep 27, 2026'}, dataFrom: null, dataTo: null, rowCount: 4, coverage: 'full', coveredFrom: null, coveredTo: null, caveats: [], share_basis: null, measure: 'revenue', measures: [], insights: [], checks: [], reliable: true},
    } as never;
    const d = recommendView(result, {kind: 'pie', orientation: 'auto'}).decisions[0];
    if (d.block !== 'chart') throw new Error('expected a chart');
    const slices = pieSlices(d.chart);
    expect(slices.map((s) => s.name).sort()).toEqual(['both', 'cat', 'dog', 'untagged']);
    expect(slices.reduce((a, s) => a + s.value, 0)).toBe(147300);
  });
});

describe('small multiples (2c.1)', () => {
  it('2c.1: small multiples are announced as one small bar chart per group', () => {
    expect(ariaSummary(smallMultiples)).toMatch(/^Revenue by event and pet: small multiples \(one small bar chart per group\) of 3 categories across 4 series/);
  });
  it('an unknown chart form is announced as a grouped bar chart, never "undefined"', () => {
    const odd = {...smallMultiples, chart: {...smallMultiples.chart, form: 'radar' as never}};
    expect(ariaSummary(odd)).toMatch(/: grouped bar chart of 3 categories/);
  });
  it('resolveForm keeps known forms and falls back to grouped_bar for any form the renderer cannot draw', () => {
    expect(resolveForm('small_multiples')).toBe('small_multiples');
    expect(resolveForm('pie')).toBe('pie');
    expect(resolveForm('radar')).toBe('grouped_bar');
    expect(resolveForm(undefined)).toBe('grouped_bar');
  });
});
