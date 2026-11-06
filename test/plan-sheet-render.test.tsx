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
import {SheetRows, SourceLegend, type Edit} from '../components/analyst/plan-sheet-rows';
import {withTotals, type PlanData} from '../src/plan-compute';
import {SHEET_ROWS, actualKind} from '../src/plan-sheet';

const months = ['2026-08-01', '2026-09-01', '2026-10-01'];
const plan: PlanData = {source: 'db', notice: null, label: 'v', months, targets: {r33: [1000, 1000, 1000], overhead: [5000, 5000, 5000]}};
// Aug: every overhead row typed; Sep: rent blank; Oct: nothing.
const lines = withTotals({salaries: [1000, 1000, null], rent: [200, null, null], accounting: [50, 50, null], tech: [30, 30, null], growth_consultant: [20, 20, null], rnd: [100, 100, null]});
const edit = (canEdit: boolean): Edit => ({canEdit, lines, closes: {}, today: '2026-11-06', save: async () => null, close: async () => null, askUnlock: () => {}, ring: null, clearRing: () => {}, next: () => false});
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
    expect(cells[0]).toBe('1.4'); // 1,000 + 200 + 50 + 30 + 20 + 100 pesos, in the sheet's thousands with one decimal
    expect(cells[1]).toContain('waiting'); // Sep: rent blank
    expect(cells[1]).not.toContain('0.0');
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

describe('L4: rows 47 and 80 repeat the month headings, like the sheet', () => {
  const html = render(true);
  it.each([47, 80])('row %i shows one month label per month column', (row) => {
    const tr = line(html, 'data-sheet-row', row)!;
    const cells = [...tr.inner.matchAll(/<td[^>]*>(.*?)<\/td>/g)].map((m) => m[1]);
    expect(cells.slice(1).map((c) => c.replace(/&#x27;/g, "'"))).toEqual(["Aug'26", "Sep'26", "Oct'26"]);
  });
});

describe('L6: long sheet labels are clamped to three lines on a phone, the full text kept', () => {
  const html = render(true);
  it.each([38, 100, 102, 110])('row %i: the label text is the sheet label, with a title and a three-line clamp', (row) => {
    const r = SHEET_ROWS.find((x) => x.row === row)!;
    const th = /<th[^>]*>(.*?)<\/th>/.exec(line(html, 'data-sheet-row', row)!.inner)!;
    const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    expect(th[0]).toContain(`title="${esc(r.label.trim())}"`);
    expect(th[1]).toContain(esc(r.label.trim()));
    expect(th[1]).toContain('max-md:line-clamp-3');
  });
  it.each([93, 117])('section row %i: clamped with a title too', (row) => {
    const r = SHEET_ROWS.find((x) => x.row === row)!;
    const tr = line(html, 'data-sheet-row', row)!;
    expect(tr.inner).toContain('max-md:line-clamp-3');
    expect(tr.inner).toContain('title="');
    expect(tr.inner.replace(/&amp;/g, '&').replace(/&#x27;/g, "'")).toContain(r.label);
  });
});

describe('BHR-07: every actual line says where it comes from', () => {
  const html = render(true);
  const chip = (row: number | string) => /<span[^>]*data-source="(\w+)"[^>]*>(.*?)<\/span><\/th>/.exec(line(html, 'data-sheet-actual', row)!.inner);
  const text = (s: string) => s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&');
  it.each([[33, 'type', 'Type'], [44, 'type', 'Type once'], [9, 'type', 'Type · optional'], ['opening_cash', 'type', 'Type once'],
    [48, 'auto', 'Auto · Shopee + Lazada'], [51, 'auto', 'Auto · sum of rows 48-50'], [71, 'calc', 'Calc = rows 66-70'], [56, 'calc', 'Calc = 51 − 55']] as const)('row %s: a %s chip that says "%s"', (row, kind, words) => {
    const m = chip(row);
    expect(m, `row ${row}`).not.toBeNull();
    expect(m![1]).toBe(kind);
    expect(text(m![2])).toContain(words);
    expect(m![0]).toContain('<svg'); // the icon (lucide), hidden from screen readers
    expect(m![0]).toMatch(/title="[^"]+"/);
  });
  it('the chip words stay in the accessible text on a phone (icon only, words sr-only below md)', () => {
    expect(chip(71)![0]).toContain('max-md:sr-only');
  });
  it('the owner example: row 71 waits and says which rows to fill', () => {
    const cells = [...line(html, 'data-sheet-actual', 71)!.inner.matchAll(/<td[^>]*>(.*?)<\/td>/g)];
    expect(cells).toHaveLength(3);
    for (const c of cells) { expect(text(c[1])).toBe('waiting, fill rows 66-70'); expect(c[0]).toContain('title="Waiting: fill rows 66-70"'); expect(c[1]).toContain('sr-only">rows </span>66-70'); } // the cell shows "fill 66-70"
  });
  it('a calc line names only the rows still empty that month (row 39, Sep: rent blank)', () => {
    const cells = [...line(html, 'data-sheet-actual', 39)!.inner.matchAll(/<td[^>]*>(.*?)<\/td>/g)];
    expect(cells[0][1]).toBe('1.4');
    expect(text(cells[1][1])).toContain('fill row 34');
    expect(text(cells[2][1])).toContain('fill rows 33-38');
  });
  it('a long list shows its first run in the cell (+ how many more) and all of it in the title, and never widens the column', () => {
    const c = /<td[^>]*>.*?<\/td>/.exec(line(html, 'data-sheet-actual', 90)!.inner)![0];
    expect(text(c)).toContain('fill rows 41 +5'); // Aug has rows 33-38 typed: 41, 52-54, 59-61, 66-70, 87-89 and opening cash are left, in sheet order
    expect(c).toMatch(/title="Waiting: fill rows [^"]*and opening cash"/);
    expect(c).toContain('w-0 min-w-[calc(100%+0.5rem)]'); // sized to its cell, never to its text
  });
});

describe('BHR-07: every empty typed cell in an open month is highlighted', () => {
  // Aug closed, Sep past and open, Oct the current month, Nov ahead.
  const m4 = ['2026-08-01', '2026-09-01', '2026-10-01', '2026-11-01'];
  const p4: PlanData = {...plan, months: m4};
  const l4 = withTotals({salaries: [1000, 1000, null, null], rnd: [null, null, null, null]});
  const e4: Edit = {...edit(true), lines: l4, closes: {'2026-08-01': {by: 'a', at: '2026-09-02', planVersion: 1, gmv: {}}}};
  const html = renderToStaticMarkup(<table><tbody><SheetRows plan={p4} nowKey="2026-10" actuals={{}} edit={e4} col={() => ''} onWhy={() => {}} inputsOpen setInputsOpen={() => {}} /></tbody></table>);
  const tds = (row: number | string) => [...line(html, 'data-sheet-actual', row)!.inner.matchAll(/<td([^>]*)>/g)].map((m) => m[1]);
  const need = (attrs: string) => /class="[^"]*\bbhr-need\b/.test(attrs);
  it.each([38, 66, 87, 9])('row %i (empty): highlighted in Sep and Oct, not in closed Aug, not in Nov ahead', (row) => {
    expect(tds(row).map(need)).toEqual([false, true, true, false]);
  });
  it('a typed cell with a value is not highlighted (salaries, Sep)', () => {
    expect(tds(33).map(need)).toEqual([false, false, true, false]);
  });
  it('typed-once lines are highlighted in the first month only, and only while it is open', () => {
    expect(tds(44).map(need)).toEqual([false, false, false, false]); // Aug is closed
  });
  it('calc and auto lines are never highlighted', () => {
    for (const row of [39, 48, 51, 71, 90]) expect(tds(row).some(need), `row ${row}`).toBe(false);
  });
});

describe('BHR-07: the legend above the grid', () => {
  it('names the three sources', () => {
    const html = renderToStaticMarkup(<SourceLegend />);
    expect(html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')).toContain('you type');
    expect(html).toContain('from Coop');
    expect(html).toContain('worked out from the rows above');
  });
});

// Owner, 2026-11-06 ("cant fill ?"): on a phone the grid shows 3 months; the typed-once lines (opening cash, opening inventory, opening customers)
// take the FIRST month only, so a window that starts later showed an empty row. The first visible cell now offers to jump back to that month.
describe('typed-once lines on a phone window that starts after the first month', () => {
  const win = (start: number) => renderToStaticMarkup(
    <table><tbody><SheetRows plan={plan} nowKey="2026-11" actuals={{}} edit={edit(true)} col={(i) => (i >= start ? '' : 'max-md:hidden')} win={{start, toFirst: () => {}}} onWhy={() => {}} inputsOpen setInputsOpen={() => {}} /></tbody></table>,
  );
  it('the first visible month of opening cash says where to type it, phone only', () => {
    const cash = line(win(1), 'data-sheet-actual', 'opening_cash')!;
    expect(cash.inner).toMatch(/data-once-jump[^>]*>.*Type in Aug(&#x27;|')26/);
    expect(cash.inner.match(/data-once-jump/g)?.length).toBe(1);
    expect(cash.inner).toMatch(/md:hidden/);
  });
  it('no jump when the window already shows the first month', () => {
    expect(line(win(0), 'data-sheet-actual', 'opening_cash')!.inner).not.toMatch(/data-once-jump/);
  });
  it('opening inventory and opening customers get the same jump', () => {
    const html = win(1);
    expect(line(html, 'data-sheet-actual', 44)!.inner).toMatch(/data-once-jump/);
    expect(line(html, 'data-sheet-actual', 120)!.inner).toMatch(/data-once-jump/);
  });
});
