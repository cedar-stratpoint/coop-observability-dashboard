// BHR-06: the Business Plan sheet as is. One entry per sheet row 4 to 125 (src/plan-sheet.json, labels only, no figure), in sheet order, with what
// the row is (section, label, spacer, input, formula, check, static), its unit and how an actual is judged against its target. Pure, no I/O.
// Every workbook value is a TARGET (knowledge/lessons/plan-workbook-is-targets-only.md). An actual is Coop's own number for that row, computed by the
// sheet's formula from GMV and the typed lines (one per itemised sheet row); a row Coop has no number for has no actual row at all.
import RAW from './plan-sheet.json';
import {GAP, LINE_TARGET_ID, fmtPlan, sheetTargetId, type ActualCell, type LineSeries, type MonthPhase, type PlanUnit, type Status} from './plan-compute';

export type SheetKind = 'header' | 'section' | 'label' | 'spacer' | 'input' | 'formula' | 'check' | 'static';
/**
 * H = higher is better, L = lower is better, pct_gmv = a variable cost judged as its share of Total GMV (actual cost / actual GMV against target cost /
 * target GMV, lower is better: owner decision 2026-11-06), band = within BAND of the coverage target, pass_fail = an OK / not-OK text check (never coloured),
 * none = never judged (plugs, budget inputs, financing, one-offs, settings, memo rows, market sizing).
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
export interface JudgeCtx {actualGmv?: number | null; targetGmv?: number | null; coverage?: number | null; coverageTarget?: number | null}
const EPS = 1e-9;
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
    const a = ctx.actualGmv ?? null, t = ctx.targetGmv ?? null;
    if (a === null || t === null || a <= 0 || t <= 0) return 'waiting';
    return actual / a <= target / t + EPS ? 'met' : 'missed';
  }
  return (dir === 'H' ? actual >= target : actual <= target) ? 'met' : 'missed';
}
const toStatus = (v: Verdict): Status => (v === 'met' ? 'ok' : v === 'missed' ? 'bad' : v === 'waiting' ? 'waiting' : 'info');

/** The colour of one actual cell: a month in progress or ahead is never judged, nor a partial (understated) actual. */
export function sheetStatus(i: {row: SheetRow; actual: ActualCell; target: number | null; phase: MonthPhase; ctx: JudgeCtx}): Status {
  if (i.phase === 'current') return 'live';
  if (i.phase === 'future') return 'future';
  if (i.actual.value === null) return 'waiting';
  if (i.actual.state === 'partial') return 'partial';
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
    75: same('ebitda'), 76: same('ebitda_pct'), 77: (i) => f([g('cm2_pct', i)], ([p]) => (p > 0 ? 1 / p : null)),
    // row 82 (the plug, = row 41) shows its target only
    81: same('ebitda'), 83: same('on_hand'), 84: same('coverage'),
    85: (i) => f([g('coverage', i), scalar('coverage')], ([c, t]) => (c >= t ? 1 : 0)),
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

/** A sheet value as the grid shows it. Money in thousands like the sheet, a check as OK or the row's failing word. */
export function fmtSheet(unit: SheetUnit, v: number | null | undefined, fail?: string): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  if (unit === 'check') return v >= 0.5 ? 'OK' : (fail ?? 'not OK');
  if (unit === 'mn') return `${v < 0 ? '−' : ''}₱${Math.abs(v).toLocaleString('en-US', {maximumFractionDigits: 1})}mn`;
  if (unit === 'num') return v.toLocaleString('en-US', {maximumFractionDigits: 2});
  if (unit === 'pct' && v !== 0 && Math.abs(v) < 0.01) return `${v < 0 ? '−' : ''}${(Math.abs(v) * 100).toFixed(3)}%`; // the penetration rows are tiny shares
  return fmtPlan(unit, v);
}
