// BHR-06: the Business Plan sheet as is. One entry per sheet row 4 to 125 (src/plan-sheet.json, labels only, no figure), in sheet order, with what
// the row is (section, label, spacer, input, formula, check, static), its unit and how an actual is judged against its target. Pure, no I/O.
// Every workbook value is a TARGET (knowledge/lessons/plan-workbook-is-targets-only.md). An actual is Coop's own number for that row, computed by the
// sheet's formula from GMV and the typed lines (one per itemised sheet row); a row Coop has no number for has no actual row at all.
import RAW from './plan-sheet.json';
import {GAP, LINE_TARGET_ID, fmtPlan, sheetTargetId, type ActualCell, type LineSeries, type MonthPhase, type PlanUnit, type Status} from './plan-compute';

export type SheetKind = 'header' | 'section' | 'label' | 'spacer' | 'input' | 'formula' | 'check' | 'static';
/**
 * H = higher is better, L = lower is better, pct_gmv = a variable cost judged as its share of the base that drives it in the sheet's own formula (the row's
 * `per`: actual cost / actual base against target cost / target base, lower is better; story AC6, review 2026-11-06), band = within BAND of the coverage
 * target, pass_fail = an OK / not-OK text check (never coloured), none = never judged (plugs, budget inputs, financing, one-offs, settings, memo rows, market sizing).
 */
export type SheetDir = 'H' | 'L' | 'pct_gmv' | 'band' | 'pass_fail' | 'none';
/** mn = millions of pesos as the sheet has them, num = a plain number, check = 1 (OK) or 0 (the row's failing word). */
export type SheetUnit = PlanUnit | 'mn' | 'num' | 'check';
export interface SheetRow {
  row: number;
  /** The sheet's column B text, exactly (leading spaces mark a sub-row). */
  label: string;
  kind: SheetKind;
  unit?: SheetUnit;
  dir?: SheetDir;
  /** The page's own target id for this row (gmv_total, cash, ...); otherwise it is `r<row>`. */
  id?: string;
  /** A sub-section header (rows 6, 22) inside the INPUTS block. */
  sub?: boolean;
  /** One value in column C (a setting), not a monthly series. Static rows are single too. */
  single?: boolean;
  /** What a failing check row says (the sheet's own word). */
  fail?: string;
  /**
   * A pct_gmv row's base, the ids summed to divide by, as the sheet formula has them: 52 and 66 marketplace GMV (row 48), 53 and 67 website GMV (49),
   * 54 events GMV (50), 59 and 60 marketplace + website GMV, 61 and 68 the number of events (row 16, r16: cost per event), totals 55 and 71 Total GMV.
   */
  per?: string[];
  /** Modelled from plan assumptions (AOV, repeat rate), not a real count: CAC and the customer rows (96, 113, 114, 121-124). Shown, never green or red (AC5). */
  modelled?: boolean;
  /** A section row that repeats the month headings across, as the sheet does (rows 47 and 80). */
  months?: boolean;
  /** The sheet's Excel number format of the row's monthly cells (column C for a single value). */
  fmt?: string;
  /** The first month's format where the sheet formats it differently (row 46: the buffer in months, then a percent). */
  fmtFirst?: string;
}

export const SHEET_ROWS: readonly SheetRow[] = RAW as SheetRow[];
export const targetId = (r: SheetRow): string => sheetTargetId(r);
export const SHEET_TARGET_IDS: readonly string[] = SHEET_ROWS.filter((r) => r.unit).map(targetId);
const BY_ROW = new Map(SHEET_ROWS.map((r) => [r.row, r]));
export const sheetRow = (row: number): SheetRow | undefined => BY_ROW.get(row);
/** Values in the sheet's thousands become pesos (x1000); every other unit is stored as the sheet has it. */
export const unitScale = (unit: SheetUnit): number => (unit === 'php' ? 1000 : 1);
export const isSingle = (r: SheetRow): boolean => r.kind === 'static' || !!r.single;

export type SheetBlock = 'inputs' | 'pnl' | 'cash' | 'metrics' | 'repeat';
const TOP: readonly [number, SheetBlock][] = [[117, 'repeat'], [93, 'metrics'], [80, 'cash'], [47, 'pnl']];
/** The top section a row belongs to (INPUTS — DRIVERS, MONTHLY P&L, CASH FLOW, METRICS, REPEAT PURCHASE LEVER). */
export const blockOf = (row: number): SheetBlock => TOP.find(([start]) => row >= start)?.[1] ?? 'inputs';
/** The body rows in sheet order (row 4 is the table head). The INPUTS — DRIVERS block shows only its header row until it is opened. */
export const shownRows = (inputsOpen: boolean): SheetRow[] => SHEET_ROWS.filter((r) => r.kind !== 'header' && (inputsOpen || blockOf(r.row) !== 'inputs' || r.row === 5));

/** Inventory on hand and forward coverage are green within ±25% of the coverage target (row 45): below it risks stock-outs, above it ties up cash. */
export const BAND = 0.25;
export type Verdict = 'met' | 'missed' | 'none' | 'waiting';
/** actualBase / targetBase = the month's base of a pct_gmv row (see SheetRow.per); coverage / coverageTarget for a band row. */
export interface JudgeCtx {actualBase?: number | null; targetBase?: number | null; coverage?: number | null; coverageTarget?: number | null}
const EPS = 1e-9;
/** The loader stores targets rounded to 6 decimals (scripts/plan-workbook.mjs), so an actual equal to the workbook value can sit up to 5e-7 off it. */
const STORED = 1e-6;
/** At or beyond `b`, within float noise and the stored rounding (an actual equal to its workbook target is met). */
const atLeast = (a: number, b: number) => a >= b - STORED - EPS * Math.abs(b);
/** Met or missed, for one month of one row. A missing actual (or the GMV / coverage it needs) is 'waiting', never 'missed'. */
export function judge(dir: SheetDir, target: number | null, actual: number | null, ctx: JudgeCtx): Verdict {
  if (dir === 'none' || dir === 'pass_fail') return 'none';
  if (actual === null) return 'waiting';
  if (dir === 'band') {
    const c = ctx.coverage ?? null, t = ctx.coverageTarget ?? null;
    if (c === null || t === null || t <= 0) return 'waiting';
    return Math.abs(c - t) <= BAND * t + EPS ? 'met' : 'missed';
  }
  if (target === null) return 'waiting';
  if (dir === 'pct_gmv') {
    const a = ctx.actualBase ?? null, t = ctx.targetBase ?? null;
    if (a === null || t === null || a <= 0 || t <= 0) return 'waiting';
    return atLeast(target / t, actual / a) ? 'met' : 'missed';
  }
  return (dir === 'H' ? atLeast(actual, target) : atLeast(target, actual)) ? 'met' : 'missed';
}

/**
 * What one month of one row is judged with: the row's base (its `per` ids summed, actuals only when fully covered, targets of the same month) and the
 * coverage band. A partial or missing base is null, so the cell waits. Coop has no actual event count yet, so rows 61 and 68 wait.
 */
export function sheetCtx(r: SheetRow, plan: {targets: Record<string, (number | null)[]>}, actuals: Readonly<Record<string, readonly ActualCell[]>>, i: number): JudgeCtx {
  const coverageTarget = plan.targets.coverage?.find((v) => v !== null) ?? null;
  const coverage = actuals.coverage?.[i]?.value ?? null;
  if (!r.per) return {coverage, coverageTarget};
  let actualBase: number | null = 0, targetBase: number | null = 0;
  for (const id of r.per) {
    const c = actuals[id]?.[i];
    actualBase = actualBase === null || !c || c.state !== 'ok' || c.value === null ? null : actualBase + c.value;
    const t = plan.targets[id]?.[i] ?? null;
    targetBase = targetBase === null || t === null ? null : targetBase + t;
  }
  return {actualBase, targetBase, coverage, coverageTarget};
}
const BASE_NAME: Record<string, string> = {gmv_marketplace: 'Marketplace', gmv_website: 'Website', gmv_events: 'Events', gmv_total: 'Total'};
/** How a met / missed cell was judged, for its tooltip. */
export const judgedAs = (r: SheetRow): string => r.dir === 'band' ? ' (coverage within 25% of target)'
  : r.dir !== 'pct_gmv' || !r.per ? '' : r.per.includes('r16') ? ' (per event)' : ` (as a share of ${r.per.map((id) => BASE_NAME[id] ?? id).join(' + ')} GMV)`;
/** Row 77, break-even ROAS: zero or below means CM2 is not positive, so no ROAS breaks even. The sheet shows the value; Coop shows it red. */
const BREAK_EVEN_ROW = 77;
const toStatus = (v: Verdict): Status => (v === 'met' ? 'ok' : v === 'missed' ? 'bad' : v === 'waiting' ? 'waiting' : 'info');

/** The colour of one actual cell: a month in progress or ahead is never judged, nor a partial (understated) actual. */
export function sheetStatus(i: {row: SheetRow; actual: ActualCell; target: number | null; phase: MonthPhase; ctx: JudgeCtx}): Status {
  if (i.phase === 'current') return 'live';
  if (i.phase === 'future') return 'future';
  if (i.actual.value === null) return 'waiting';
  if (i.actual.state === 'partial') return 'partial';
  if (i.row.modelled) return 'modelled';
  if (i.row.row === BREAK_EVEN_ROW && i.actual.value <= 0) return 'bad';
  return toStatus(judge(i.row.dir ?? 'none', i.target, i.actual.value, i.ctx));
}

/** The sheet row each typed line lives on: its own target row (33-38, 41, 52-54, 59-61, 66-70, 87-89). */
export const LINE_ROW: Readonly<Record<string, SheetRow>> = Object.fromEntries(Object.entries(LINE_TARGET_ID).map(([line, t]) => [line, SHEET_ROWS.find((r) => r.unit && targetId(r) === t)!]));
/**
 * Sheet row -> the typed line entered on its actual line: the 21 lines that close a month, plus the optional ROAS (row 9) and the opening balances
 * typed once in the first month (opening stock row 44, opening customers row 120). Opening cash has no sheet row (the sheet starts cash from 0): it is
 * typed under row 90, cash at month end.
 */
export const TYPED_ROW: Readonly<Record<number, string>> = {
  ...Object.fromEntries(Object.entries(LINE_ROW).map(([line, r]) => [r.row, line])),
  9: 'roas', 44: 'opening_inventory', 120: 'opening_customers',
};
/** The sheet row a typed line (or measure) is entered on. Opening cash is entered under row 90. */
export const rowOfLine = (id: string): number | undefined => (id === 'opening_cash' ? 90 : Number(Object.entries(TYPED_ROW).find(([, l]) => l === id)?.[0]) || undefined);

type Plan = {months: readonly string[]; targets: Record<string, (number | null)[]>};
const ok = (value: number): ActualCell => ({value, state: 'ok'});
/** One value from several cells: waits if any waits, partial if any is partial, and waits when the formula has no answer (a divide by zero). */
function f(cells: readonly ActualCell[], fn: (v: number[]) => number | null): ActualCell {
  if (cells.some((c) => c.value === null)) return GAP;
  const v = fn(cells.map((c) => c.value as number));
  if (v === null || !Number.isFinite(v)) return GAP;
  const partial = cells.find((c) => c.state === 'partial');
  return partial ? {value: v, state: 'partial', ...(partial.note ? {note: partial.note} : {})} : ok(v);
}
const div = ([a, b]: number[]) => (b > 0 ? a / b : null);

/**
 * Coop's actual for every sheet row it has a number for, by row then month: the sheet's own formula on the actuals. `actuals` = GMV cells and the derived
 * rows (derivedActuals), `lines` = the typed lines with their computed totals (withTotals), in pesos.
 */
export function sheetActuals(plan: Plan, actuals: Readonly<Record<string, readonly ActualCell[]>>, lines: LineSeries): Record<number, ActualCell[]> {
  const g = (id: string, i: number): ActualCell => {
    const a = actuals[id]?.[i];
    if (a) return a;
    const v = lines[id]?.[i];
    return typeof v === 'number' ? ok(v) : GAP;
  };
  const ROWS = rowFormulas(plan, g);
  const out: Record<number, ActualCell[]> = {};
  for (const [row, fn] of Object.entries(ROWS)) out[Number(row)] = plan.months.map((_, i) => fn(i));
  return out;
}

/** The sheet's formula per actual row, on a cell reader `g` (metric id, month index). */
function rowFormulas(plan: Plan, g: (id: string, i: number) => ActualCell): Record<number, (i: number) => ActualCell> {
  const scalar = (id: string): ActualCell => { const v = plan.targets[id]?.find((x) => x !== null) ?? null; return v === null ? GAP : ok(v); };
  const same = (id: string) => (i: number) => g(id, i);
  const growth = (id: string) => (i: number) => (i === 0 ? GAP : f([g(id, i - 1), g(id, i)], ([p, c]) => (p > 0 ? c / p - 1 : null)));
  const shareOf = (cost: (i: number) => ActualCell, gmvIds: string[]) => (i: number) => f([cost(i), ...gmvIds.map((id) => g(id, i))], ([c, ...gs]) => div([c, gs.reduce((t, x) => t + x, 0)]));
  const firstMonth = (id: string) => (i: number) => (i === 0 ? g(id, 0) : GAP);
  const ads = (i: number) => f(['ad_marketplace', 'ad_website', 'event_marketing', 'content_other'].map((id) => g(id, i)), (v) => v.reduce((t, x) => t + x, 0));
  return {
    8: growth('gmv_marketplace'), 9: same('roas'), 12: growth('gmv_website'),
    24: shareOf(same('marketplace_cogs'), ['gmv_marketplace']), 25: shareOf(same('website_cogs'), ['gmv_website']), 26: shareOf(same('events_cogs'), ['gmv_events']),
    30: shareOf(same('fulfilment'), ['gmv_marketplace', 'gmv_website']), // row 60 = (48 + 49) x row 30
    33: same('salaries'), 34: same('rent'), 35: same('accounting'), 36: same('tech'), 37: same('growth_consultant'), 38: same('rnd'),
    39: same('overhead'), 41: same('inv_purchases_paid'), 44: firstMonth('opening_inventory'),
    48: same('gmv_marketplace'), 49: same('gmv_website'), 50: same('gmv_events'), 51: same('gmv_total'),
    52: same('marketplace_cogs'), 53: same('website_cogs'), 54: same('events_cogs'), 55: same('cogs'), 56: same('cm1'), 57: same('cm1_pct'),
    58: shareOf(same('platform_fees'), ['gmv_marketplace', 'gmv_website']), // row 59 = (48 + 49) x row 58
    59: same('platform_fees'), 60: same('fulfilment'), 61: same('event_costs'), 62: same('cm2'), 63: same('cm2_pct'),
    66: same('ad_marketplace'), 67: same('ad_website'), 68: same('event_marketing'), 69: same('content_socials'), 70: same('other_spend'),
    71: ads, 72: same('cm3'), 73: same('cm3_pct'),
    74: (i) => f([g('overhead', i)], ([o]) => -o), // the sheet stores overhead negative here (= -row 39)
    75: same('ebitda'), 76: same('ebitda_pct'), 77: (i) => f([g('cm2_pct', i)], ([p]) => (p !== 0 ? 1 / p : null)), // negative when CM2 is, as the sheet
    // row 82 (the plug, = row 41) shows its target only
    81: same('ebitda'), 83: same('on_hand'), 84: same('coverage'),
    85: (i) => f([g('coverage', i), scalar('coverage')], ([c, t]) => (atLeast(c, t) ? 1 : 0)),
    86: (i) => f([g('ebitda', i), g('cogs', i), g('inv_purchases_paid', i)], ([e, c, b]) => e + c - b),
    87: same('bridge_funding'), 88: same('liability_settlement'), 89: same('freight_onetime'), 90: same('cash'),
    91: (i) => f([g('cash', i)], ([c]) => (c >= 0 ? 1 : 0)),
    94: same('gmv_total'), 95: (i) => f([g('gmv_total', i)], ([m]) => m * 12), 96: same('cac'),
    113: same('customers'), 114: (i) => f([g('customers', i), scalar('r103')], div), 115: (i) => f([g('gmv_total', i), scalar('r110')], ([m, s]) => div([m * 12, s])),
    120: firstMonth('opening_customers'), 121: same('customers'), 122: same('new_customers'), 123: same('repeat_gmv'), 124: same('new_gmv'),
    125: (i) => f([g('repeat_gmv', i), g('gmv_marketplace', i), g('gmv_website', i)], ([r, m, w]) => (r > m + w ? 0 : 1)),
  };
}
const ACTUAL_ROWS: ReadonlySet<number> = new Set(Object.keys(rowFormulas({months: [], targets: {}}, () => GAP)).map(Number));
/** What a sheet row's second line holds: an entry cell (a typed line), a value computed by the sheet's formula, or nothing (target line only). */
export const actualKind = (row: number): 'typed' | 'computed' | null => (TYPED_ROW[row] ? 'typed' : ACTUAL_ROWS.has(row) ? 'computed' : null);

/**
 * BHR-07: where an actual line's number comes from. type = an admin types it (`from`: every month, once in the first month, or optional);
 * auto = read from a Coop source (`from` names it); calc = the sheet's own formula over the rows above (`from` in the sheet's row numbers) and `feeds`,
 * the typed rows it ultimately needs, so a waiting line can say which rows to fill. `opening` = a typed opening balance with no sheet row it also needs.
 */
export interface ActualSource {kind: 'type' | 'auto' | 'calc'; from: string; feeds?: readonly number[]; opening?: 'opening_cash'}
const span = (a: number, b: number) => Array.from({length: b - a + 1}, (_, k) => a + k);
const OVH = span(33, 38), COGS = span(52, 54), FEES = span(59, 61), ADS = span(66, 70), CUST = [120], STOCK = [44, 41, ...COGS];
const CM2 = [...COGS, ...FEES], CM3 = [...CM2, ...ADS], EBITDA = [...CM3, ...OVH], CASH = [...EBITDA, 41, 87, 88, 89];
const calc = (from: string, feeds: readonly number[], opening?: 'opening_cash'): ActualSource => ({kind: 'calc', from, feeds, ...(opening ? {opening} : {})});
/** One explicit table, Coop's formula per calc row in the sheet's own row numbers (the sheet's, or its inverse where the sheet row is an input). */
const CALC: Readonly<Record<number, ActualSource>> = {
  8: calc('= 48 vs last month', []), 12: calc('= 49 vs last month', []),
  24: calc('= 52 ÷ 48', [52]), 25: calc('= 53 ÷ 49', [53]), 26: calc('= 54 ÷ 50', [54]), 30: calc('= 60 ÷ (48 + 49)', [60]),
  39: calc('= rows 33-38', OVH),
  55: calc('= rows 52-54', COGS), 56: calc('= 51 − 55', COGS), 57: calc('= 56 ÷ 51', COGS), 58: calc('= 59 ÷ (48 + 49)', [59]),
  62: calc('= 56 − 59 − 60 − 61', CM2), 63: calc('= 62 ÷ 51', CM2),
  71: calc('= rows 66-70', ADS), 72: calc('= 62 − 71', CM3), 73: calc('= 72 ÷ 51', CM3),
  74: calc('= − 39', OVH), 75: calc('= 72 + 74', EBITDA), 76: calc('= 75 ÷ 51', EBITDA), 77: calc('= one ÷ 63', CM2),
  81: calc('= 75', EBITDA), 83: calc('= last month + 41 − 55', STOCK), 84: calc('= 83 ÷ next month planned 55', STOCK), 85: calc('= 84 vs 45', STOCK),
  86: calc('= 81 + 55 − 41', [...EBITDA, 41]), 90: calc('= last month + 86 + 87 − 88 − 89', CASH, 'opening_cash'), 91: calc('= 90 not below zero', CASH, 'opening_cash'),
  94: calc('= 51', []), 95: calc('= 94 × twelve', []), 96: calc('= 71 ÷ 122', [...ADS, ...CUST]),
  113: calc('= 121', CUST), 114: calc('= 113 ÷ 103', CUST), 115: calc('= 95 ÷ 110', []),
  121: calc('= last month + 122', CUST), 122: calc('= 124 ÷ 119', CUST), 123: calc('= 121 × 118 × 119', CUST), 124: calc('= 48 + 49 − 123, never below zero', CUST),
  125: calc('= 123 within 48 + 49', CUST),
};
const AUTO: Readonly<Record<number, string>> = {48: 'Shopee + Lazada', 49: 'Website (CRM)', 50: 'POS events', 51: 'Marketplace GMV + Website GMV + Events GMV'};
const ONCE = new Set(['opening_inventory', 'opening_customers', 'opening_cash']);
/** The source of a sheet row's actual line (or the opening-cash line typed under row 90). Null = the row has no actual line. */
export function actualSource(row: number | 'opening_cash'): ActualSource | null {
  if (row === 'opening_cash') return {kind: 'type', from: 'once'};
  const typed = TYPED_ROW[row];
  if (typed) return {kind: 'type', from: ONCE.has(typed) ? 'once' : LINE_ROW[typed] ? 'every month' : 'optional'};
  if (AUTO[row]) return {kind: 'auto', from: AUTO[row]};
  return ACTUAL_ROWS.has(row) ? CALC[row] ?? null : null;
}
/** The row numbers a formula text cites, ranges expanded ("= rows 33-38", "= 51 − 55"). */
export const rowRefs = (text: string): number[] => [...text.matchAll(/(\d+)(?:-(\d+))?/g)].flatMap((m) => (m[2] ? span(Number(m[1]), Number(m[2])) : [Number(m[1])]));
/**
 * The grid never shows row numbers (owner, 2026-11-06: "hindi naman maidentify ni user anong row number yun"), so tips name the lines. A line's short
 * name comes from its sheet label: no "less:", no units in brackets, no "→ drives ..." or "= ..." tail; an overhead sub-row is its own word (Salaries).
 */
export function rowName(row: number): string {
  const label = SHEET_ROWS.find((r) => r.row === row)?.label ?? `line ${row}`;
  let t = label.trim().replace(/^less:\s*/i, '').replace(/\s*\([^)]*\)/g, '').replace(/\s*(→|=).*$/, '').replace(/\s+—\s+PLUG$/, '');
  const parts = t.split(/\s+[—–]\s+/);
  t = (/^Company overhead/.test(t) && parts[1] ? parts[1] : parts[0]).replace(/\s{2,}/g, ' ').trim();
  t = t.replace(/^TOTAL\b/, 'Total');
  return t.charAt(0).toUpperCase() + t.slice(1);
}
/** A formula from the CALC table in line names: "= rows 66-70" → "Marketplace ad spend + ... + Other spend costs", "= 62 − 71" → "CM2 − Total ad spend". */
export function namedFormula(from: string): string {
  return from.replace(/^=\s*/, '').replace(/\+ 74\b/, '− 39').replace(/^− 39$/, '− 39') // row 74 is overhead stored negative: read it as minus the overhead total
    .replace(/rows (\d+)-(\d+)/g, (_, a, b) => span(Number(a), Number(b)).map(rowName).join(' + '))
    .replace(/\b(\d{2,3})\b/g, (_, n) => rowName(Number(n)))
    .replace(/\bone\b/g, '1').replace(/\btwelve\b/g, '12');
}
/** The typed lines a calc line needs, in words; a whole block reads as its group ("the ad spend lines"). */
const GROUPS: ReadonlyArray<[readonly number[], string]> = [[OVH, 'the overhead lines'], [COGS, 'the COGS lines'], [FEES, 'the platform fee, fulfilment and events cost lines'], [ADS, 'the ad spend lines']];
export function feedNames(rows: readonly number[]): string {
  const left = new Set(rows);
  const words: string[] = [];
  for (const [g, name] of GROUPS) if (g.every((r) => left.has(r))) { g.forEach((r) => left.delete(r)); words.push(name); }
  for (const r of [...left].sort((a, b) => a - b)) words.push(rowName(r));
  return words.length > 1 ? `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}` : words[0] ?? '';
}
/** Row numbers as runs: 33-38, 52-54, 60. */
export function rowRange(rows: readonly number[]): string {
  const out: string[] = [];
  for (let k = 0; k < rows.length; k++) {
    let e = k;
    while (rows[e + 1] === rows[e] + 1) e++;
    out.push(e > k + 1 ? `${rows[k]}-${rows[e]}` : e === k + 1 ? `${rows[k]}, ${rows[e]}` : `${rows[k]}`);
    k = e;
  }
  return out.join(', ');
}

/** A sheet value as the grid shows it. Money in thousands like the sheet, a check as OK or the row's failing word. */
export function fmtSheet(unit: SheetUnit, v: number | null | undefined, fail?: string): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  if (unit === 'check') return v >= 0.5 ? 'OK' : (fail ?? 'not OK');
  if (unit === 'mn') return `${v < 0 ? '−' : ''}₱${Math.abs(v).toLocaleString('en-US', {maximumFractionDigits: 1})}mn`;
  if (unit === 'num') return v.toLocaleString('en-US', {maximumFractionDigits: 2});
  if (unit === 'pct' && v !== 0 && Math.abs(v) < 0.01) return `${v < 0 ? '−' : ''}${(Math.abs(v) * 100).toFixed(3)}%`; // the penetration rows are tiny shares
  return fmtPlan(unit, v);
}

/**
 * A value in the sheet's own Excel number format (`fmt`): its decimals, percent, grouping and suffix (x, mo). Negatives keep Coop's minus sign and a zero
 * shows as 0.0 (the sheet shows a dash), so a real 0 never reads like an empty cell (—).
 */
export function fmtExcel(code: string, v: number): string {
  const sec = code.split(';')[0];
  if (sec === 'General') {
    const t = Math.abs(v).toLocaleString('en-US', {maximumFractionDigits: 6, useGrouping: false});
    return `${v < 0 && Number(t) !== 0 ? '−' : ''}${t}`;
  }
  const m = /^([#,0]*0)(?:\.(0+))?(%?)(.*)$/.exec(sec);
  if (!m) return String(v);
  const dec = m[2]?.length ?? 0, pct = m[3] === '%';
  const x = Math.abs(pct ? v * 100 : v);
  const t = x.toLocaleString('en-US', {minimumFractionDigits: dec, maximumFractionDigits: dec, useGrouping: m[1].includes(',')});
  const suffix = m[4].replace(/"([^"]*)"/g, '$1').replace(/\\(.)/g, '$1');
  return `${v < 0 && /[1-9]/.test(t) ? '−' : ''}${t}${pct ? '%' : ''}${suffix}`;
}
/** A sheet cell as the grid shows it: the row's own number format (money in the sheet's thousands), a check as OK or its failing word. `i` = month index. */
export function fmtCell(r: SheetRow, v: number | null | undefined, i = 0): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  const code = (i === 0 && r.fmtFirst) || r.fmt;
  if (r.unit === 'check' || !code) return fmtSheet(r.unit ?? 'num', v, r.fail);
  return fmtExcel(code, v / unitScale(r.unit!));
}
