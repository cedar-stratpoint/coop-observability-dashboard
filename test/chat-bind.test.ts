import {describe, expect, it} from 'vitest';
import {bindBlock, plainText, totalRow, MAX_TITLE, type ResultStore} from '../src/chat/bind';
import type {ChartBlock, ChatBlock, KpiBlock, TableBlock} from '../src/chat/block-types';
import type {ColumnRole, ColumnUnit, MetricResult, MetricRow, ResultColumn} from '../src/chat/result-types';

// Synthetic results only.
const col = (key: string, unit: ColumnUnit, role: ColumnRole, label = key): ResultColumn => ({key, label, unit, role});
function mk(id: string, columns: ResultColumn[], rows: MetricRow[], over: Partial<MetricResult['meta']> = {}): MetricResult {
  return {
    id, metric: 'pet_mix', dimension: 'none', columns, rows,
    meta: {
      source: 'live', range: {from: '2026-09-01', to: '2026-09-30', label: 'Sep 1 to Sep 30, 2026'}, dataFrom: null, dataTo: null, rowCount: rows.length, coverage: 'full',
      coveredFrom: null, coveredTo: null, caveats: ['34% of orders have no pet tag.'], share_basis: 'tagged revenue', measure: 'revenue', measures: [], insights: [], checks: [], reliable: true, ...over,
    },
  };
}
const PETS = mk('r1',
  [col('pet', 'text', 'category', 'Pet'), col('value', 'PHP', 'measure', 'Revenue'), col('share', 'percent', 'share', 'Share of tagged revenue')],
  [{pet: 'dog', value: 700.1, share: 60}, {pet: 'cat', value: 300.2, share: 40}, {pet: 'untagged', value: 200.3, share: null}]);
const ONE = mk('r2', [col('rev', 'PHP', 'measure', 'Revenue'), col('orders', 'count', 'measure', 'Orders'), col('share', 'percent', 'share', 'Share'), col('text', 'text', 'category')], [{rev: 5000, orders: 12, share: 12.5, text: 'x'}]);
const store: ResultStore = new Map([['r1', PETS], ['r2', ONE]]);
let n = 0;
const ids = () => `b${++n}`;
const run = (tool: Parameters<typeof bindBlock>[0], input: unknown, s: ResultStore = store) => {
  n = 0;
  return bindBlock(tool, input, s, ids);
};
const ok = (o: ReturnType<typeof run>): ChatBlock[] => {
  if ('error' in o) throw new Error(o.error);
  return o.blocks;
};
const chart = {block: 'new', source: 'r1', kind: 'auto', orientation: 'auto', x: 'auto', y: ['auto'], title: 'T'};

describe('source and field validation', () => {
  it('an unknown result lists the valid ones', () => {
    expect(run('render_chart', {...chart, source: 'r9'})).toEqual({error: "Unknown result 'r9'. Valid results: r1, r2"});
    expect(run('render_kpi', {source: 'nope'})).toMatchObject({error: expect.stringContaining('Valid results: r1, r2')});
  });
  it('with no results yet, it says to call query_metric first', () => {
    expect(run('render_table', {source: 'r1'}, new Map())).toMatchObject({error: expect.stringMatching(/call query_metric first/)});
  });
  it('an unknown field lists the columns that can be used there', () => {
    const x = run('render_chart', {...chart, x: 'color'});
    expect(x).toMatchObject({error: expect.stringContaining("Unknown field 'color'")});
    expect((x as {error: string}).error).toContain('pet');
    const y = run('render_chart', {...chart, y: ['value', 'nope']}) as {error: string};
    expect(y.error).toContain('value, share');
    const t = run('render_table', {block: 'new', source: 'r1', columns: ['pet', 'zzz'], title: ''}) as {error: string};
    expect(t.error).toContain('pet, value, share');
  });
  it('a field of the wrong kind is refused and says so', () => {
    expect(run('render_chart', {...chart, x: 'value'})).toMatchObject({error: expect.stringContaining("'value' cannot be used as x")});
  });
  it('an unknown kind or orientation lists the valid ones', () => {
    expect(run('render_chart', {...chart, kind: 'donut'})).toMatchObject({error: expect.stringContaining('stacked_bar_100')});
    expect(run('render_chart', {...chart, orientation: 'diagonal'})).toMatchObject({error: expect.stringContaining('horizontal')});
  });
});

describe('render_kpi', () => {
  const kpi = {block: 'new', source: 'r2', value: 'rev', label: 'Revenue', format: 'peso'};
  it('binds the stored value, with the result reliability, caveats and basis', () => {
    const [b] = ok(run('render_kpi', kpi)) as KpiBlock[];
    expect(b).toMatchObject({id: 'b1', kind: 'kpi', source: 'r2', label: 'Revenue', value: 5000, format: 'peso', reliable: true});
    expect(b.caveats).toEqual(['34% of orders have no pet tag.']);
    expect(b.basis).toBe('Sep 1 to Sep 30, 2026'); // a pesos tile does not carry the share basis
  });
  it('a share tile carries the share basis and the range', () => {
    const [b] = ok(run('render_kpi', {...kpi, value: 'share', format: 'percent'})) as KpiBlock[];
    expect(b.basis).toBe('tagged revenue, Sep 1 to Sep 30, 2026');
  });
  it('needs a one-row result', () => {
    expect(run('render_kpi', {...kpi, source: 'r1', value: 'value'})).toMatchObject({error: expect.stringMatching(/A stat tile needs a one-row result/)});
  });
  it('the value must be a numeric measure and the format must match its unit', () => {
    expect(run('render_kpi', {...kpi, value: 'text'})).toMatchObject({error: expect.stringContaining('Valid value fields: rev, orders, share')});
    expect(run('render_kpi', {...kpi, format: 'percent'})).toMatchObject({error: expect.stringContaining("use format 'peso'")});
    expect(run('render_kpi', {...kpi, format: 'euro'})).toMatchObject({error: expect.stringContaining('Valid formats')});
  });
  it('a null stored value stays null', () => {
    const s: ResultStore = new Map([['r5', mk('r5', [col('a', 'PHP', 'measure')], [{a: null}])]]);
    expect((ok(run('render_kpi', {block: 'new', source: 'r5', value: 'a', label: '', format: 'peso'}, s)) as KpiBlock[])[0].value).toBeNull();
  });
});

describe('a request carrying data is ignored', () => {
  it.each(['data', 'values', 'rows', 'columns_data'])('a "%s" key never reaches the block', (key) => {
    const clean = ok(run('render_chart', chart));
    const dirty = ok(run('render_chart', {...chart, [key]: [{pet: 'dog', value: 999999}], total: 1, rowsOverride: [1]}));
    expect(dirty).toEqual(clean);
    const k = {block: 'new', source: 'r2', value: 'rev', label: 'Revenue', format: 'peso'};
    expect(ok(run('render_kpi', {...k, [key]: 12345, number: 1}))).toEqual(ok(run('render_kpi', k)));
    const t = {block: 'new', source: 'r1', columns: ['auto'], title: ''};
    expect(ok(run('render_table', {...t, [key]: [{}]}))).toEqual(ok(run('render_table', t)));
  });
});

describe('render_table', () => {
  it('the rows are exactly the stored rows for the chosen columns, in the chosen order', () => {
    const [b] = ok(run('render_table', {block: 'new', source: 'r1', columns: ['value', 'pet'], title: 'By pet'})) as TableBlock[];
    expect(b.columns.map((c) => c.key)).toEqual(['value', 'pet']);
    expect(b.rows).toEqual([{value: 700.1, pet: 'dog'}, {value: 300.2, pet: 'cat'}, {value: 200.3, pet: 'untagged'}]);
    expect(b.title).toBe('By pet');
  });
  it('["auto"] means every column', () => {
    const [b] = ok(run('render_table', {block: 'new', source: 'r1', columns: ['auto'], title: ''})) as TableBlock[];
    expect(b.columns).toEqual(PETS.columns);
    expect(b.rows).toEqual(PETS.rows);
  });
  it('the total row is computed by code in whole centavos, for additive columns only', () => {
    const [b] = ok(run('render_table', {block: 'new', source: 'r1', columns: ['auto'], title: ''})) as TableBlock[];
    expect(b.total).toEqual({pet: 'Total', value: 1200.6, share: null});
    expect(0.1 + 0.2).not.toBe(0.3); // the reason sums go through centavos
  });
  it('no total for a share-only table, a derived measure, a single row or a cut list', () => {
    expect(totalRow(PETS, [PETS.columns[0], PETS.columns[2]], PETS.rows)).toBeNull();
    const derived = mk('r6', [col('n', 'text', 'category'), col('aov', 'PHP', 'measure')], [{n: 'a', aov: 1}, {n: 'b', aov: 2}], {measures: [{key: 'aov', label: 'AOV', kind: 'derived', unit: 'PHP', method: ''}]});
    expect(totalRow(derived, derived.columns, derived.rows)).toBeNull();
    expect(totalRow(PETS, PETS.columns, [PETS.rows[0]])).toBeNull();
    const cut = mk('r7', PETS.columns, PETS.rows, {rowCount: 40});
    expect(totalRow(cut, cut.columns, cut.rows)).toBeNull();
  });
});

describe('render_chart', () => {
  it('draws from the stored rows with title, caveats, basis and a twin', () => {
    const blocks = ok(run('render_chart', chart));
    const b = blocks[0] as ChartBlock;
    expect(b).toMatchObject({id: 'b1', kind: 'chart', source: 'r1', title: 'T', reliable: true});
    expect(b.basis).toBe('tagged revenue, Sep 1 to Sep 30, 2026');
    expect(b.twin.rows).toEqual(PETS.rows);
    expect(b.chart.rows[0]).toMatchObject({dog: 700.1, cat: 300.2});
  });
  it('title is plain text: whitespace collapsed, control characters gone, 120 characters at most', () => {
    expect(plainText('  a \n\t b\u0000c ')).toBe('a b c');
    expect(plainText('x'.repeat(500))).toHaveLength(MAX_TITLE);
    expect(plainText(42)).toBe('');
    const [b] = ok(run('render_chart', {...chart, title: '<b>Bold</b>'}));
    expect(b.title).toBe('<b>Bold</b>'); // kept as text: React escapes it, nothing renders it as HTML
  });
  it('an empty title falls back to a plain default', () => {
    const [b] = ok(run('render_chart', {...chart, title: ''}));
    expect(b.title.length).toBeGreaterThan(0);
  });
  it('an explicit request reaches the decision', () => {
    const [b] = ok(run('render_chart', {...chart, kind: 'pie'})) as ChartBlock[];
    expect(b.chart.form).toBe('pie');
    expect(b.chosen.mode).toBe('user');
  });
  it('a result that is not reliable gives blocks that are not reliable', () => {
    const bad = new Map<string, MetricResult>([['r1', {...PETS, meta: {...PETS.meta, reliable: false}}], ['r2', {...ONE, meta: {...ONE.meta, reliable: false}}]]);
    expect(ok(run('render_chart', chart, bad))[0].reliable).toBe(false);
    expect(ok(run('render_table', {block: 'new', source: 'r1', columns: ['auto'], title: ''}, bad))[0].reliable).toBe(false);
    expect(ok(run('render_kpi', {block: 'new', source: 'r2', value: 'rev', label: 'R', format: 'peso'}, bad))[0].reliable).toBe(false);
  });
  it('a non-object request is refused in plain words', () => {
    expect(run('render_chart', null)).toMatchObject({error: expect.stringMatching(/must be an object/)});
  });
});

describe('G2 auto chart titles come from column labels, never from row or series values', () => {
  const explore = {exploratory: {label: 'x', sql: 's', coverage_note: '', warnings: []}};
  const render = (r: MetricResult) => {
    const s: ResultStore = new Map([[r.id, r]]);
    return ok(run('render_chart', {source: r.id, kind: 'auto', orientation: 'auto', x: 'auto', y: ['auto'], title: ''}, s));
  };
  it('two category columns: "<measure> by <dim> and <dim>", not the pet values', () => {
    const r = mk('x1', [col('event', 'text', 'category', 'Event'), col('pet', 'text', 'category', 'Pet'), col('orders_count', 'count', 'measure', 'Orders')],
      [{event: 'A', pet: 'dog', orders_count: 4}, {event: 'A', pet: 'cat', orders_count: 3}, {event: 'B', pet: 'dog', orders_count: 2}, {event: 'B', pet: 'cat', orders_count: 1}], explore);
    const t = render(r).map((b) => b.title);
    expect(t).toEqual(['Orders by Event and Pet']);
  });
  it('a six-breed pivot is "Counts by Event"; no breed name reaches the title', () => {
    const breeds = ['no_breed_given', 'puspin', 'golden_retriever', 'persian', 'aspin', 'shih_tzu'];
    const r = mk('x2', [col('event', 'text', 'category', 'Event'), ...breeds.map((b) => col(b, 'count', 'measure', b.replace(/_/g, ' ')))],
      [{event: 'A', ...Object.fromEntries(breeds.map((b, i) => [b, i + 1]))}, {event: 'B', ...Object.fromEntries(breeds.map((b, i) => [b, i]))}], explore);
    const s: ResultStore = new Map([[r.id, r]]);
    const blocks = ok(run('render_chart', {source: 'x2', kind: 'auto', orientation: 'auto', x: 'auto', y: breeds, title: ''}, s));
    expect(blocks.map((b) => b.title)).toEqual(['Counts by Event']);
    expect(blocks[0].kind === 'chart' && blocks[0].chart.series).toHaveLength(6);
  });
  it('up to three measure columns are named by their labels; an Explore peso column reads "(PHP)"', () => {
    const r = mk('x3', [col('event', 'text', 'category', 'Event'), col('a', 'PHP', 'measure', 'Revenue'), col('b', 'PHP', 'measure', 'Cost')], [{event: 'A', a: 5, b: 2}, {event: 'B', a: 4, b: 1}], explore);
    const s: ResultStore = new Map([[r.id, r]]);
    expect(ok(run('render_chart', {source: 'x3', kind: 'auto', orientation: 'auto', x: 'auto', y: ['a', 'b'], title: ''}, s))[0].title).toBe('Revenue (PHP) and Cost (PHP) by Event');
  });
});

describe('meta.headline: the code-written answer line rides on every block of the result (RET-02 / RET-06)', () => {
  const H = mk('r3', PETS.columns, PETS.rows, {headline: 'Repeat buyer rate: 21 of 145 buyers (14.5%). Target 25%, a plan target, not an actual.'});
  const s: ResultStore = new Map([['r3', H], ['r1', PETS]]);
  it('a chart and a table bound from it carry the headline', () => {
    const c = ok(run('render_chart', {...chart, source: 'r3'}, s))[0];
    const t = ok(run('render_table', {source: 'r3'}, s))[0];
    expect(c.headline).toBe(H.meta.headline);
    expect(t.headline).toBe(H.meta.headline);
  });
  it('a result without one: no headline key', () => {
    expect('headline' in ok(run('render_chart', chart, s))[0]).toBe(false);
  });
});
