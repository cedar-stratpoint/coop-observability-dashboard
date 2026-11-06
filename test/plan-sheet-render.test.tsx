// BHR-06 owner layout (2026-11-06): the All months grid IS the Business Plan sheet. Renders the real rows component and checks: every non-structural
// sheet row has a target line; only actual-capable rows have an actual line (an entry cell on a typed row, a computed value on a formula row); the
// itemised overhead rows are typed in place; row 39 is their sum and is never typed; a blank row leaves the total waiting. Synthetic numbers only.
import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, it, vi} from 'vitest';

// The vitest config has no '@' alias: map the ids the component imports to the real modules.
vi.mock('@/lib/utils', () => ({cn: (...a: unknown[]) => a.filter((x) => typeof x === 'string').join(' ')}));
vi.mock('@/src/plan-help', async () => await import('../src/plan-help'));
vi.mock('@/src/plan-compute', async () => await import('../src/plan-compute'));
vi.mock('@/src/plan-sheet', async () => await import('../src/plan-sheet'));
import {SheetRows, type Edit} from '../components/analyst/plan-sheet-rows';
import {withTotals, type PlanData} from '../src/plan-compute';
import {SHEET_ROWS, actualKind} from '../src/plan-sheet';

const months = ['2026-08-01', '2026-09-01', '2026-10-01'];
const plan: PlanData = {source: 'db', notice: null, label: 'v', months, targets: {r33: [1000, 1000, 1000], overhead: [5000, 5000, 5000]}};
// Aug: every overhead row typed; Sep: rent blank; Oct: nothing.
const lines = withTotals({salaries: [1000, 1000, null], rent: [200, null, null], accounting: [50, 50, null], tech: [30, 30, null], growth_consultant: [20, 20, null], rnd: [100, 100, null]});
const edit = (canEdit: boolean): Edit => ({canEdit, lines, closes: {}, today: '2026-11-06', save: async () => null, close: async () => null, askUnlock: () => {}, fill: null, ring: null, clearRing: () => {}, next: () => false});
const render = (inputsOpen: boolean, canEdit = true) => renderToStaticMarkup(
  <table><tbody><SheetRows plan={plan} nowKey="2026-11" actuals={{}} edit={edit(canEdit)} col={() => ''} onWhy={() => {}} inputsOpen={inputsOpen} setInputsOpen={() => {}} /></tbody></table>,
);
/** Every <tr> as its opening-tag attributes and its inner HTML. */
const trs = (html: string) => [...html.matchAll(/<tr([^>]*)>(.*?)<\/tr>/g)].map((m) => ({attrs: m[1], inner: m[2]}));
const line = (html: string, attr: string, row: number | string) => trs(html).find((t) => t.attrs.includes(`${attr}="${row}"`));
const VALUE_KINDS = ['input', 'formula', 'check', 'static'];

describe('the grid is the sheet: a target line per row, an actual line only where an actual can exist', () => {
  const html = render(true);
  it.each(SHEET_ROWS.filter((r) => VALUE_KINDS.includes(r.kind)).map((r) => r.row))('row %i renders its target line', (row) => {
    expect(line(html, 'data-sheet-row', row)?.attrs, `row ${row}`).toContain('data-line-kind="target"');
  });
  it.each(SHEET_ROWS.filter((r) => r.kind !== 'header').map((r) => r.row))('row %i has an actual line only if it can have an actual', (row) => {
    const actual = line(html, 'data-sheet-actual', row);
    expect(!!actual, `row ${row}`).toBe(actualKind(row) !== null);
    if (actual) expect(actual.attrs).toContain(`data-actual-kind="${actualKind(row)}"`);
  });
  it('section headers, label rows and spacers have no actual line', () => {
    for (const r of SHEET_ROWS.filter((x) => ['section', 'label', 'spacer'].includes(x.kind))) expect(line(html, 'data-sheet-actual', r.row), `row ${r.row}`).toBeUndefined();
  });
  it('rows follow the sheet order', () => {
    const order = trs(html).map((t) => /data-sheet-row="(\d+)"/.exec(t.attrs)?.[1]).filter(Boolean).map(Number);
    expect(order).toEqual([...new Set(order)].sort((a, b) => a - b));
    expect(order[0]).toBe(5);
    expect(order[order.length - 1]).toBe(125);
  });
});

describe('itemised overhead: rows 33 to 38 typed in place, row 39 the computed sum', () => {
  const html = render(true);
  it.each([[33, 'salaries'], [34, 'rent'], [35, 'accounting'], [36, 'tech'], [37, 'growth_consultant'], [38, 'rnd']])('row %i has an entry cell per month for %s', (row, id) => {
    const a = line(html, 'data-sheet-actual', row)!;
    for (const m of months) expect(a.inner, `${id} ${m}`).toMatch(new RegExp(`<input[^>]*data-line="${id}"[^>]*data-month="${m}"`));
  });
  it('row 39 (total overhead) has no entry cell anywhere: never typed', () => {
    const a = line(html, 'data-sheet-actual', 39)!;
    expect(a.attrs).toContain('data-actual-kind="computed"');
    expect(a.inner).not.toContain('<input');
    expect(html).not.toMatch(/data-line="(overhead|cogs|content_other)"/);
  });
  it('row 39 shows the sum of its rows, and waits (never 0) when a row is blank', () => {
    const cells = [...line(html, 'data-sheet-actual', 39)!.inner.matchAll(/<td[^>]*>(.*?)<\/td>/g)].map((m) => m[1]);
    expect(cells[0]).toContain('₱1.4k'); // 1,000 + 200 + 50 + 30 + 20 + 100 pesos
    expect(cells[1]).toContain('waiting'); // Sep: rent blank
    expect(cells[1]).not.toContain('₱0');
    expect(cells[2]).toContain('waiting');
  });
});

describe('INPUTS — DRIVERS is collapsed by default; read-only viewers get no inputs', () => {
  it('collapsed: rows 6 to 46 are not rendered, the toggle says it is closed', () => {
    const html = render(false);
    for (let r = 6; r <= 46; r++) expect(line(html, 'data-sheet-row', r), `row ${r}`).toBeUndefined();
    expect(html).toMatch(/data-testid="inputs-toggle"[^>]*|aria-expanded="false"/);
    expect(html).toContain('aria-expanded="false"');
  });
  it('a viewer sees the typed values but never an input', () => {
    const html = render(true, false);
    expect(html).not.toContain('<input');
    expect(line(html, 'data-sheet-actual', 33)!.inner).toContain('1');
  });
});
