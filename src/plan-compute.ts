// Business Health Report: pure plan-vs-actual logic. No I/O. Money is in pesos (the workbook's thousands are converted once, in the seed).
// Green = met or beat, red = missed, grey = waiting / no source / future / month in progress. Nothing here invents an actual.

export type PlanUnit = 'php' | 'pct' | 'x' | 'peso' | 'count' | 'months';
/** coop = pulled from Coop's readers (BHR-02), typed = entered by an admin (BHR-03), calc = computed by the workbook's own formula from the other lines, none = no source today. */
export type ActualSource = 'coop' | 'typed' | 'calc' | 'none';
export interface MetricDef {id: string; label: string; group: string; unit: PlanUnit; direction: 'higher' | 'lower'; source: ActualSource; key?: boolean; hint?: string; /** Derived from plan assumptions (AOV, repeat rate), not from a real count: shown beside its target, never judged. */ modelled?: boolean}

export const METRICS: readonly MetricDef[] = [
  {id: 'gmv_total', label: 'Total GMV', group: 'Revenue', unit: 'php', direction: 'higher', source: 'coop', key: true},
  {id: 'gmv_events', label: 'Events GMV', group: 'Revenue', unit: 'php', direction: 'higher', source: 'coop', key: true},
  {id: 'gmv_website', label: 'Website GMV', group: 'Revenue', unit: 'php', direction: 'higher', source: 'coop', key: true},
  {id: 'gmv_marketplace', label: 'Marketplace GMV', group: 'Revenue', unit: 'php', direction: 'higher', source: 'coop', key: true},
  {id: 'cm1', label: 'CM1 gross profit', group: 'Margins', unit: 'php', direction: 'higher', source: 'calc'},
  {id: 'cm1_pct', label: 'CM1 gross margin', group: 'Margins', unit: 'pct', direction: 'higher', source: 'calc'},
  {id: 'cm2', label: 'CM2 after delivery', group: 'Margins', unit: 'php', direction: 'higher', source: 'calc'},
  {id: 'cm2_pct', label: 'CM2 margin', group: 'Margins', unit: 'pct', direction: 'higher', source: 'calc'},
  {id: 'cm3', label: 'CM3 after marketing', group: 'Margins', unit: 'php', direction: 'higher', source: 'calc'},
  {id: 'cm3_pct', label: 'CM3 margin', group: 'Margins', unit: 'pct', direction: 'higher', source: 'calc'},
  {id: 'overhead', label: 'Fixed overhead', group: 'Margins', unit: 'php', direction: 'lower', source: 'typed'},
  {id: 'ebitda', label: 'EBITDA', group: 'Margins', unit: 'php', direction: 'higher', source: 'calc'},
  {id: 'ebitda_pct', label: 'EBITDA margin', group: 'Margins', unit: 'pct', direction: 'higher', source: 'calc'},
  {id: 'cash', label: 'Cash at month end', group: 'Cash and stock', unit: 'php', direction: 'higher', source: 'calc', key: true, hint: 'calculated from your opening cash and the typed lines. Check against your bank: it should match the bank balance at month end.'},
  {id: 'coverage', label: 'Inventory coverage', group: 'Cash and stock', unit: 'months', direction: 'higher', source: 'calc', hint: 'calculated: stock on hand ÷ next month planned COGS'},
  {id: 'roas', label: 'ROAS (paid GMV / ad spend)', group: 'Efficiency', unit: 'x', direction: 'higher', source: 'typed', hint: 'type it in the open cell'},
  {id: 'cac', label: 'CAC (lower is better)', group: 'Efficiency', unit: 'peso', direction: 'lower', source: 'calc', modelled: true, hint: 'modelled from plan assumptions: ad spend ÷ new customers'},
  {id: 'customers', label: 'Active customers', group: 'Efficiency', unit: 'count', direction: 'higher', source: 'calc', modelled: true, hint: 'modelled from plan assumptions: customer base roll from the workbook'},
];
export const METRIC_GROUPS = ['Revenue', 'Margins', 'Cash and stock', 'Efficiency'] as const;

export type MonthPhase = 'past' | 'current' | 'future';
/** derived = information only (no target to judge, e.g. runway); modelled = a plan-assumption model value shown beside its target, never judged. */
export type Status = 'ok' | 'bad' | 'waiting' | 'live' | 'future' | 'nosource' | 'partial' | 'info' | 'derived' | 'modelled';

/** One month's actual for one metric. state: ok = fully covered, partial = some of the source is missing (value understated, grey), gap = no data (value null, shown empty and "waiting"). */
export interface ActualCell {value: number | null; state: 'ok' | 'partial' | 'gap'; note?: string}
export const GAP: ActualCell = {value: null, state: 'gap'};

export function metricStatus(i: {direction: 'higher' | 'lower'; actual: number | null; target: number | null; phase: MonthPhase; hasSource: boolean; partial?: boolean; informational?: boolean; modelled?: boolean}): Status {
  if (!i.hasSource) return 'nosource';
  if (i.phase === 'current') return 'live'; // a month in progress is never judged
  if (i.phase === 'future') return 'future';
  if (i.actual === null || i.target === null) return 'waiting';
  if (i.partial) return 'partial'; // understated, so never judged red or green
  if (i.informational) return 'info'; // shown beside the plan, never judged
  if (i.modelled) return 'modelled'; // a plan-assumption model, never judged red or green
  return (i.direction === 'higher' ? i.actual >= i.target : i.actual <= i.target) ? 'ok' : 'bad';
}

/** The CM ladder, workbook rows 56 / 62 / 72 / 75. `adSpend` is row 71 (all marketing lines); `overhead` is a positive cost. Any unit, as long as it is one. */
export function cmLadder(i: {gmv: number; cogs: number; platformFees: number; fulfilment: number; eventCosts: number; adSpend: number; overhead: number}) {
  const cm1 = i.gmv - i.cogs;
  const cm2 = cm1 - i.platformFees - i.fulfilment - i.eventCosts;
  const cm3 = cm2 - i.adSpend;
  const ebitda = cm3 - i.overhead;
  const pct = (v: number) => (i.gmv > 0 ? v / i.gmv : null);
  return {cm1, cm2, cm3, ebitda, cm1Pct: pct(cm1), cm2Pct: pct(cm2), cm3Pct: pct(cm3), ebitdaPct: pct(ebitda)};
}

/** 'YYYY-MM' of today in Manila (UTC+8, no DST). */
export const currentMonthKey = (now: Date): string => new Date(now.getTime() + 8 * 3_600_000).toISOString().slice(0, 7);

export const monthPhase = (month: string, nowKey: string): MonthPhase => {
  const k = month.slice(0, 7);
  return k < nowKey ? 'past' : k === nowKey ? 'current' : 'future';
};

/** Index of today's month in the plan, clamped to its ends. */
export function currentIndex(months: readonly string[], nowKey: string): number {
  if (!months.length) return 0;
  const i = months.findIndex((m) => m.slice(0, 7) === nowKey);
  if (i >= 0) return i;
  return nowKey < months[0].slice(0, 7) ? 0 : months.length - 1;
}

/** Key-card months: the last two calendar months and the month to date (fewer at the start of the plan). */
export function cardMonths(months: readonly string[], nowKey: string): string[] {
  const i = currentIndex(months, nowKey);
  return months.slice(Math.max(0, i - 2), i + 1);
}

/** Mobile grid: first month of the 3-month window that ends at the current month. */
export const windowStart = (total: number, size: number, currentIdx: number): number => Math.max(0, Math.min(currentIdx - size + 1, total - size));
/** Prev / next: steps one whole window, clamped. */
export const stepWindow = (start: number, dir: 1 | -1, total: number, size: number): number => Math.max(0, Math.min(start + dir * size, total - size));

/**
 * Runway, information only (no target, never red or green): cash at month i divided by the average monthly net cash burn of the last 3 months (the fall in cash,
 * which already counts every inflow and outflow). `cash` is the derived cash per month, `opening` the cash before the first month. 'not-burning' when the 3-month net
 * change is not negative. null = unknown: fewer than 3 months of history, or cash (or the balance 3 months back) unknown. Cash is a running balance, so the
 * average is just (cash now - cash 3 months back) / 3.
 */
export function runwayMonths(cash: readonly (number | null)[], opening: number | null, i: number): number | 'not-burning' | null {
  if (i < 2) return null;
  const now = cash[i] ?? null;
  const back = i === 2 ? opening : (cash[i - 3] ?? null);
  if (now === null || back === null) return null;
  const burn = (back - now) / 3;
  if (burn <= 0) return 'not-burning';
  return now <= 0 ? 0 : now / burn;
}

const sign = (v: number) => (v < 0 ? '−' : '');
export function fmtPlan(unit: PlanUnit, v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  const a = Math.abs(v), s = sign(v);
  const n = (x: number, max = 0) => x.toLocaleString('en-US', {maximumFractionDigits: max});
  if (unit === 'php') { const k = a / 1000; return `${s}₱${n(k, k >= 100 ? 0 : 1)}k`; }
  if (unit === 'pct') return `${s}${(a * 100).toFixed(1)}%`;
  if (unit === 'x') return `${s}${a.toFixed(2)}x`;
  if (unit === 'peso') return `${s}₱${n(a)}`;
  if (unit === 'months') return `${s}${a.toFixed(1)} mo`;
  return `${s}${n(a)}`;
}

/** What the page renders: one plan version's targets by metric, aligned to `months`. */
export interface PlanData {
  source: 'db' | 'seed';
  /** Why the bundled seed is shown instead of the database (a banner says it). */
  notice: string | null;
  label: string;
  /** The plan_versions id these targets came from (BHR-05 edits must name the version they saw). Null for the bundled seed: nothing to edit. */
  versionId?: number | null;
  months: string[];
  targets: Record<string, (number | null)[]>;
  /** Per-part targets behind the consolidated lines (line -> part -> value per month index, pesos), loaded privately into plan_part_targets. Empty when none are loaded. */
  partTargets?: Record<string, Record<string, (number | null)[]>>;
}

/** The plan months (Aug 2026 to Dec 2027, 17 of them): the page layout when no target is stored yet (mock mode, a fresh database). Dates only, no figure. */
export const PLAN_MONTHS: readonly string[] = Array.from({length: 17}, (_, i) => { const d = new Date(Date.UTC(2026, 7 + i, 1)); return d.toISOString().slice(0, 10); });

/** Plan rows that feed a chart, not a grid row: the workbook's inventory purchases (row 41, the stock orders needed to hold the coverage target). */
export const PLAN_EXTRA_TARGETS: readonly string[] = ['inv_purchases', 'repeat_rate', 'aov'];
/** The plan target each typed line is judged against (workbook rows 39, 41, 55, 59-61, 66-70, 87-89, loaded by scripts/seed-plan-from-workbook.mjs). Stock bought is the workbook's inventory-purchases row. */
export const LINE_TARGET_ID: Record<LineId, string> = {
  overhead: 'overhead', bridge_funding: 'bridge_funding', liability_settlement: 'liability_settlement', freight_onetime: 'freight_onetime', inv_purchases_paid: 'inv_purchases',
  cogs: 'cogs', platform_fees: 'platform_fees', fulfilment: 'fulfilment', event_costs: 'event_costs', ad_marketplace: 'ad_marketplace', ad_website: 'ad_website', event_marketing: 'event_marketing', content_other: 'content_other',
};
/** Cash-flow lines are shown against their plan but never judged red or green: funding is not a cost, and a payment or stock order above plan is not by itself bad. */
export const NEUTRAL_LINES: ReadonlySet<string> = new Set(['bridge_funding', 'liability_settlement', 'freight_onetime', 'inv_purchases_paid']);
/** Actual minus plan for one typed line, and how to colour it: costs are lower-is-better (over plan is bad), the cash-flow lines are never judged. */
export function lineVariance(i: {id: string; actual: number | null; target: number | null; phase: MonthPhase}): {diff: number | null; status: Status} {
  const status = metricStatus({direction: 'lower', actual: i.actual, target: i.target, phase: i.phase, hasSource: true, informational: NEUTRAL_LINES.has(i.id)});
  return {diff: i.actual === null || i.target === null ? null : i.actual - i.target, status};
}
/** Planned stock purchases per month, as the plan has them (null = the plan has no value). */
export const stockOrderSeries = (plan: {targets: Record<string, (number | null)[]>}): (number | null)[] => plan.targets.inv_purchases ?? [];

export interface PlanTargetRow {month: string; metric: string; value: number | string | null}

/** Rows of one plan version -> PlanData. Months come from the rows, sorted; a metric with no row in a month is null (a gap, never 0). */
export function assemblePlan(label: string, rows: readonly PlanTargetRow[], versionId: number | null = null, fallbackMonths: readonly string[] = []): PlanData {
  const fromRows = [...new Set(rows.map((r) => r.month))].sort();
  const months = fromRows.length ? fromRows : [...fallbackMonths];
  const targets: Record<string, (number | null)[]> = {};
  for (const id of [...METRICS.map((m) => m.id), ...PLAN_EXTRA_TARGETS, ...Object.values(LINE_TARGET_ID)]) targets[id] = months.map(() => null);
  for (const r of rows) {
    const series = targets[r.metric];
    if (!series || r.value === null) continue; // an unknown metric id is ignored, not rendered
    series[months.indexOf(r.month)] = Number(r.value);
  }
  return {source: 'db', notice: null, label, versionId, months, targets};
}

/* ---------- BHR-03: the typed monthly lines and the margins they feed ---------- */

/**
 * The typed monthly lines that close a month: the workbook's INPUT rows (a cost actually paid, stock bought, funding, one-time payments). Everything the
 * workbook computes by formula (margins, EBITDA, cash, inventory, coverage, customers, CAC) is NOT typed: it is derived below from these and the GMV readers.
 * Typed in thousands of pesos, stored in pesos, never negative.
 */
export type LineId = 'overhead' | 'bridge_funding' | 'liability_settlement' | 'freight_onetime' | 'inv_purchases_paid' | 'cogs' | 'platform_fees' | 'fulfilment' | 'event_costs' | 'ad_marketplace' | 'ad_website' | 'event_marketing' | 'content_other';
export interface LineDef {id: LineId; label: string}
export const LINES: readonly LineDef[] = [
  {id: 'overhead', label: 'Fixed overhead'},
  {id: 'bridge_funding', label: 'Bridge funding in'},
  {id: 'liability_settlement', label: 'Liability settlement (one-time)'},
  {id: 'freight_onetime', label: 'Large shipping / freight (one-time)'},
  {id: 'inv_purchases_paid', label: 'Inventory purchases paid'},
  {id: 'cogs', label: 'COGS'},
  {id: 'platform_fees', label: 'Platform fees'},
  {id: 'fulfilment', label: 'Fulfilment'},
  {id: 'event_costs', label: 'Event costs'},
  {id: 'ad_marketplace', label: 'Marketplace ad spend'},
  {id: 'ad_website', label: 'Website ad spend'},
  {id: 'event_marketing', label: 'Event marketing'},
  {id: 'content_other', label: 'Content, socials, other'},
];
export const LINE_IDS: readonly string[] = LINES.map((l) => l.id);
/** How many typed lines a month needs before it can close. */
export const REQUIRED_COUNT = LINES.length;

/** The typed lines in the All months grid, in the approved artifact's order: overhead, what feeds each margin, then the cash-flow inputs (opening cash is typed first in that group). */
export const LINE_GROUPS: readonly {label: string; ids: readonly LineId[]}[] = [
  {label: 'overhead', ids: ['overhead']},
  {label: 'feeds CM1', ids: ['cogs']},
  {label: 'feeds CM2', ids: ['platform_fees', 'fulfilment', 'event_costs']},
  {label: 'feeds CM3', ids: ['ad_marketplace', 'ad_website', 'event_marketing', 'content_other']},
  {label: 'cash flow items', ids: ['inv_purchases_paid', 'bridge_funding', 'liability_settlement', 'freight_onetime']},
];
/** Row labels of the typed lines in the grid (the prototype's wording; LINES keeps the short names used elsewhere). */
export const GRID_LINE_LABEL: Record<string, string> = {
  roas: 'ROAS: paid GMV per peso of ad spend', opening_cash: 'Opening cash (bank balance at Aug 1)', opening_inventory: 'Opening stock at Aug 1', opening_customers: 'Opening active customers at Aug 1',
  bridge_funding: 'Bridge funding in', liability_settlement: 'Liability settlement (one-time)', freight_onetime: 'Large shipping / freight (one-time)', inv_purchases_paid: 'Stock bought (inventory purchases paid)',
  overhead: 'Fixed overhead', cogs: 'Cost of goods sold', platform_fees: 'Platform fees paid', fulfilment: 'Fulfilment and delivery cost',
  event_costs: 'Event costs', ad_marketplace: 'Marketplace ad spend', ad_website: 'Website ad spend', event_marketing: 'Event marketing', content_other: 'Content, socials and other spend',
};
/** The metric rows under KEY METRICS, in the prototype's order and grouping. */
export const GRID_METRIC_GROUPS: readonly {label: string; ids: readonly string[]}[] = [
  {label: 'Key metrics', ids: ['gmv_total', 'gmv_events', 'gmv_website', 'gmv_marketplace']},
  {label: 'Cash and stock', ids: ['cash', 'coverage']},
  {label: 'Margin and efficiency', ids: ['cm1_pct', 'cm1', 'cm2_pct', 'cm2', 'cm3_pct', 'cm3', 'overhead', 'ebitda', 'ebitda_pct', 'roas', 'cac']},
  {label: 'Customers', ids: ['customers']},
];

/** Server-side check of one typed value (pesos). null = clearing the cell. Returns an error message, or null when fine. */
export function validateLine(metric: unknown, amount: unknown): string | null {
  const line = LINES.find((l) => l.id === metric) ?? measureOf(metric as string);
  if (!line) return 'Unknown line.';
  if (amount === null) return null;
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return 'Enter a number.';
  if (Math.abs(amount) > 1e12) return 'That number is too large.';
  if (amount < 0 && metric !== 'opening_cash') return `${line.label} cannot be negative.`;
  return null;
}

/** What a person typed into a cell (thousands of pesos, as the workbook shows them) -> pesos. '' = clear the cell (missing), '0' = a real 0. */
export function parseThousands(text: string): {ok: true; pesos: number | null} | {ok: false} {
  const t = text.trim().replace(/[,\s₱]/g, '');
  if (t === '') return {ok: true, pesos: null};
  if (!/^[-+]?\d*\.?\d+$|^[-+]?\d+\.$/.test(t)) return {ok: false};
  const k = Number(t);
  return Number.isFinite(k) ? {ok: true, pesos: Math.round(k * 1000 * 100) / 100} : {ok: false};
}
/** What a person typed into a cell of any typed line -> the stored value (pesos for the lines, the number itself for ROAS). '' = clear. */
export function parseLineInput(id: string, text: string): {ok: true; value: number | null} | {ok: false} {
  if (lineUnit(id) === 'php') { const p = parseThousands(text); return p.ok ? {ok: true, value: p.pesos} : {ok: false}; }
  const t = text.trim().replace(/[,\s₱]|x$|mo$/gi, '');
  if (t === '') return {ok: true, value: null};
  if (!/^[-+]?\d*\.?\d+$|^[-+]?\d+\.$/.test(t)) return {ok: false};
  const n = Number(t);
  return Number.isFinite(n) ? {ok: true, value: Math.round(n * 1e4) / 1e4} : {ok: false};
}
/** A stored value of any typed line -> what its input shows. */
export const lineInputText = (id: string, value: number): string => (lineUnit(id) === 'php' ? toThousands(value) : String(Math.round(value * 1e4) / 1e4));
/** The unit in words, for the input's accessible name. */
export const lineUnitWords = (id: string): string => ({php: 'thousands of pesos', peso: 'pesos', x: 'a multiple, for example 3.2', count: 'a count', months: 'months'} as Record<PlanUnit, string>)[lineUnit(id)] ?? '';

/** Pesos -> what the input shows (thousands, no grouping, up to 2 decimals). */
export const toThousands = (pesos: number): string => String(Math.round((pesos / 1000) * 100) / 100);

/**
 * One optional typed actual for a plan row Coop has no data source for: ROAS (workbook row 9 is an INPUT: paid GMV per peso of ad spend; Coop has no paid-GMV
 * source). Stored through the same plan_set_actual RPC and plan_actuals table (column amount_php, whose name predates it: it holds the exact number, in the line's
 * own unit). NOT among the lines that close a month, but a close locks it and unlock logs it.
 */
export interface MeasureLineDef {id: 'roas' | 'opening_cash' | 'opening_inventory' | 'opening_customers'; label: string; unit: PlanUnit}
/** The opening balances: each lives on the first plan month only. */
export const OPENING_IDS: readonly string[] = ['opening_cash', 'opening_inventory', 'opening_customers'];
/** Opening cash is the bank balance at the START of the first plan month: the workbook has no such cell (row 90 starts from 0), so Coop asks for it once. The only typed value that may be negative. */
export const MEASURE_LINES: readonly MeasureLineDef[] = [
  {id: 'roas', label: 'ROAS', unit: 'x'}, {id: 'opening_cash', label: 'Opening cash', unit: 'php'},
  // Opening stock and opening customers are workbook facts the private loader prefills (plan_seed_actual) and an admin may correct; until one exists the stock and customer rows wait. First month only, never needed to close.
  {id: 'opening_inventory', label: 'Opening stock', unit: 'php'}, {id: 'opening_customers', label: 'Opening customers', unit: 'count'},
];
export const ALL_LINE_IDS: readonly string[] = [...LINE_IDS, ...MEASURE_LINES.map((l) => l.id)];
export const MEASURE_GROUP: {label: string; ids: readonly MeasureLineDef['id'][]} = {label: 'efficiency', ids: ['roas']};
const measureOf = (id: string) => MEASURE_LINES.find((l) => l.id === id);
/** Unit a line is typed and stored in. The lines are typed in thousands of pesos and stored in pesos; ROAS is typed and stored as it is. */
export const lineUnit = (id: string): PlanUnit => measureOf(id)?.unit ?? 'php';

/** Typed lines by month: line id -> value per month (null = empty). */
export type LineSeries = Partial<Record<string, (number | null)[]>>;
/** Provenance of a prefilled cell by line and month ('workbook' | 'owner'); null = typed by an admin. */
export type LineSources = Partial<Record<string, (string | null)[]>>;

/** True when every typed line holds a value in month i (a real 0 counts). */
export const monthComplete = (lines: LineSeries, i: number): boolean => LINES.every((l) => typeof lines[l.id]?.[i] === 'number');
export const filledCount = (lines: LineSeries, i: number): number => LINES.filter((l) => typeof lines[l.id]?.[i] === 'number').length;

/**
 * CM1, CM2, CM3 and EBITDA (and their % of GMV) per month from Total GMV and the typed lines, workbook rows 56 / 62 / 72 / 75 through cmLadder.
 * A level needs its own inputs and every level above it; a missing input leaves that level (and the ones below) empty, never a guess.
 * A partial Total GMV (a channel missing) gives partial margins: understated, grey, never judged. `lines` = pesos.
 */
export function marginCells(gmvTotal: readonly ActualCell[], lines: LineSeries): Record<'cm1' | 'cm1_pct' | 'cm2' | 'cm2_pct' | 'cm3' | 'cm3_pct' | 'ebitda' | 'ebitda_pct', ActualCell[]> {
  const out = {cm1: [], cm1_pct: [], cm2: [], cm2_pct: [], cm3: [], cm3_pct: [], ebitda: [], ebitda_pct: []} as Record<string, ActualCell[]>;
  const get = (id: string, i: number): number | null => lines[id]?.[i] ?? null;
  const sum = (ids: string[], i: number): number | null => {
    let t = 0;
    for (const id of ids) { const v = get(id, i); if (v === null) return null; t += v; }
    return t;
  };
  gmvTotal.forEach((g, i) => {
    const cogs = get('cogs', i);
    const fees = sum(['platform_fees', 'fulfilment', 'event_costs'], i);
    const ads = sum(['ad_marketplace', 'ad_website', 'event_marketing', 'content_other'], i);
    const overhead = get('overhead', i);
    const gmv = g.value;
    const state: ActualCell['state'] = g.state === 'partial' ? 'partial' : 'ok';
    const note = state === 'partial' ? 'Total GMV is partial, so this margin is understated.' : undefined;
    const put = (id: string, v: number | null, pct: number | null) => {
      const cell = (value: number | null): ActualCell => (value === null ? GAP : {value, state, ...(note ? {note} : {})});
      out[id].push(cell(v));
      out[`${id}_pct`].push(cell(pct));
    };
    // Each level calls the one shared ladder with zeros for the lines below it and reads only its own result.
    const ok = gmv !== null;
    const l1 = ok && cogs !== null ? cmLadder({gmv, cogs, platformFees: 0, fulfilment: 0, eventCosts: 0, adSpend: 0, overhead: 0}) : null;
    const l2 = l1 && fees !== null ? cmLadder({gmv: gmv as number, cogs: cogs as number, platformFees: fees, fulfilment: 0, eventCosts: 0, adSpend: 0, overhead: 0}) : null;
    const l3 = l2 && ads !== null ? cmLadder({gmv: gmv as number, cogs: cogs as number, platformFees: fees as number, fulfilment: 0, eventCosts: 0, adSpend: ads, overhead: 0}) : null;
    const l4 = l3 && overhead !== null ? cmLadder({gmv: gmv as number, cogs: cogs as number, platformFees: fees as number, fulfilment: 0, eventCosts: 0, adSpend: ads as number, overhead}) : null;
    put('cm1', l1 && l1.cm1, l1 && l1.cm1Pct);
    put('cm2', l2 && l2.cm2, l2 && l2.cm2Pct);
    put('cm3', l3 && l3.cm3, l3 && l3.cm3Pct);
    put('ebitda', l4 && l4.ebitda, l4 && l4.ebitdaPct);
  });
  return out as ReturnType<typeof marginCells>;
}

/* ---------- BHR-04: closing a month ---------- */

/** A closed month: who closed it and when, the plan version it closed under, and the GMV actuals frozen at close (channel metric id -> cell). */
export interface ClosedMonth {by: string; at: string; planVersion: number; gmv: Record<string, ActualCell>}

/** Last Manila calendar day of a 'YYYY-MM-DD' (or 'YYYY-MM') month, as 'YYYY-MM-DD'. */
export function lastDayOf(month: string): string {
  const [y, m] = month.slice(0, 7).split('-').map(Number);
  return `${month.slice(0, 7)}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
}
/** True once the month is OVER: Manila `today` ('YYYY-MM-DD') is after its last day. The last day itself is still the month. */
export const monthEnded = (month: string, today: string): boolean => today > lastDayOf(month);
/** "Oct'26" for '2026-10-01' (the label the close messages use). */
export const monthTag = (month: string): string => `${'JanFebMarAprMayJunJulAugSepOctNovDec'.slice((+month.slice(5, 7) - 1) * 3, +month.slice(5, 7) * 3)}'${month.slice(2, 4)}`;

const CLOSE_CHANNELS = [['gmv_events', 'Events'], ['gmv_website', 'Website'], ['gmv_marketplace', 'Marketplace']] as const;
/** True when all three GMV channels (Events, Website, Marketplace) are fully covered: state 'ok' and a number. A partial or empty channel is not. A real 0 is complete. */
export const gmvComplete = (gmv: Readonly<Partial<Record<string, ActualCell>>>): boolean => CLOSE_CHANNELS.every(([id]) => gmv[id]?.state === 'ok' && typeof gmv[id]?.value === 'number');
export const MONTH_NOT_OVER = (tag: string): string => `${tag} is not over yet. It can be closed once the month has ended.`;
/** `earlier` = the tag of the oldest unclosed month before this one. Cash chains month to month, so months close oldest first. */
export const CLOSE_OLDEST_FIRST = (earlierTag: string): string => `Close ${earlierTag} first. Cash carries from month to month, so months close oldest first.`;
/** Why a month cannot be closed yet, in plain words (null = it can): not over (Manila date), or a GMV channel still partial or not in. */
export function closeBlocker(i: {month: string; today: string; tag: string; gmv: Readonly<Partial<Record<string, ActualCell>>>; earlier?: string | null}): string | null {
  if (!monthEnded(i.month, i.today)) return MONTH_NOT_OVER(i.tag);
  if (i.earlier) return CLOSE_OLDEST_FIRST(i.earlier);
  const parts = CLOSE_CHANNELS.flatMap(([id, name]) => {
    const c = i.gmv[id];
    if (c?.state === 'ok' && typeof c.value === 'number') return [];
    return [`${name} data for ${i.tag} is ${c?.state === 'partial' ? 'still partial' : 'not in yet'}.`];
  });
  return parts.length ? parts.join(' ') : null;
}

/** Every ended month that is not closed yet, oldest first: what the "close is waiting" banner lists. */
export const closeQueue = (months: readonly string[], closes: Readonly<Record<string, ClosedMonth>>, today: string): string[] => months.filter((m) => monthEnded(m, today) && !closes[m]);
/** The OLDEST ended month not closed yet: where Fill in, the header Close button and the amber ring start. Null when none. */
export const closeWaiting = (months: readonly string[], closes: Readonly<Record<string, ClosedMonth>>, today: string): string | null => closeQueue(months, closes, today)[0] ?? null;
/** The oldest unclosed month before `month` (a month cannot close until it is closed), else null. */
export const earlierUnclosed = (month: string, months: readonly string[], closes: Readonly<Record<string, ClosedMonth>>, today: string): string | null => closeQueue(months, closes, today).find((m) => m < month) ?? null;
/** Indexes of the last three ended months, oldest first (the current month is still in progress): the card's past-3-months view. */
export function lastPastMonths(months: readonly string[], nowKey: string): number[] {
  const past = months.map((m, i) => (m.slice(0, 7) < nowKey ? i : -1)).filter((i) => i >= 0);
  return past.slice(-3);
}

/** The lines that close a month, in grid order: the order Enter and "Fill in" walk. */
export const REQUIRED_LINE_ORDER: readonly string[] = LINE_GROUPS.flatMap((g) => g.ids);
/**
 * The next still-empty required line of month i, walking the grid order from just after `after` and wrapping (so the cell you are on comes last).
 * `treatFilled` = a line being saved right now (typed but not back from the server yet). Null when all are in. A real 0 counts as filled.
 */
export function nextEmptyLine(lines: LineSeries, i: number, after: string | null = null, treatFilled?: string): string | null {
  const k = after ? REQUIRED_LINE_ORDER.indexOf(after) : -1;
  const order = [...REQUIRED_LINE_ORDER.slice(k + 1), ...REQUIRED_LINE_ORDER.slice(0, k + 1)];
  return order.find((id) => id !== treatFilled && typeof lines[id]?.[i] !== 'number') ?? null;
}
/** Whole days from the last day of `month` to `today` ('YYYY-MM-DD'); 0 on the last day itself. */
export function daysSinceMonthEnd(month: string, today: string): number {
  const t = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));
  return Math.max(0, Math.round((t(today) - t(lastDayOf(month))) / 86400000));
}

/** What a read-only viewer reads beside the "close is waiting" banner, so the page never looks like it is missing a button. */
export const closeWaitingWho = (monthLabel: string): string => `Ask a Coop Admin to fill in the ${monthLabel} lines.`;

const GMV_IDS = ['gmv_events', 'gmv_website', 'gmv_marketplace', 'gmv_total'] as const;
/** A closed month reads its GMV from the snapshot taken at close, never live: late voids, refunds or digest reruns cannot move it. */
export function applySnapshots(gmv: Readonly<Record<string, ActualCell[]>>, months: readonly string[], closes: Readonly<Record<string, ClosedMonth>>): Record<string, ActualCell[]> {
  const out: Record<string, ActualCell[]> = {...gmv};
  for (const id of GMV_IDS) {
    out[id] = months.map((mo, i) => {
      const close = closes[mo];
      if (!close) return gmv[id]?.[i] ?? GAP;
      const snap = close.gmv[id]; // a closed month NEVER falls back to live: a channel absent from the snapshot is a gap
      return snap ? {value: snap.value ?? null, state: snap.state ?? 'gap', ...(snap.note ? {note: snap.note} : {})} : GAP;
    });
  }
  return out;
}

/** The snapshot stored at close: the four GMV cells of that one month. */
export const gmvSnapshot = (gmv: Readonly<Record<string, ActualCell[]>>): Record<string, ActualCell> =>
  Object.fromEntries(GMV_IDS.map((id) => [id, gmv[id]?.[0] ?? GAP]));

/* ---------- BHR-05: target edits as plan versions ---------- */

/** What a person typed for a target -> the stored value. Money is typed in thousands (-> pesos), percentages as percent (-> ratio), the rest as is. Blank is not a target. */
export function parseTargetInput(unit: PlanUnit, text: string): {ok: true; value: number} | {ok: false} {
  const t = text.trim().replace(/[,\s₱%]/g, '');
  if (!/^[-+]?\d*\.?\d+$|^[-+]?\d+\.$/.test(t)) return {ok: false};
  const n = Number(t);
  if (!Number.isFinite(n)) return {ok: false};
  if (unit === 'php') return {ok: true, value: Math.round(n * 1000 * 100) / 100};
  if (unit === 'pct') return {ok: true, value: Math.round(n * 1e4) / 1e6};
  return {ok: true, value: n};
}
/** A stored target -> what the input shows (the inverse of parseTargetInput). */
export function targetInputText(unit: PlanUnit, value: number): string {
  if (unit === 'php') return String(Math.round((value / 1000) * 100) / 100);
  if (unit === 'pct') return String(Math.round(value * 1e4) / 1e2);
  return String(Math.round(value * 100) / 100);
}

/**
 * Which targets may be typed in the Targets tab. The plan is FIXED targets from the workbook and Coop does not recalculate it (no driver engine), so:
 * a derived row (CM, EBITDA, cash, coverage, customers, CAC) is never typed, Total GMV is the sum of its channels, and a workbook INPUT target
 * (a channel GMV, overhead, ROAS) is locked when changing it would leave derived targets silently out of date, which today is every one of them.
 */
const DERIVED_TARGETS: readonly string[] = ['cm1', 'cm1_pct', 'cm2', 'cm2_pct', 'cm3', 'cm3_pct', 'ebitda', 'ebitda_pct', 'cash', 'coverage', 'cac', 'customers'];
const ALL_DERIVED = DERIVED_TARGETS;
/** Input-driven targets and the derived targets each one feeds (the ones that would go stale). */
export const TARGET_FEEDS: Readonly<Record<string, readonly string[]>> = {
  gmv_events: ALL_DERIVED, gmv_website: ALL_DERIVED, gmv_marketplace: ALL_DERIVED,
  overhead: ['ebitda', 'ebitda_pct', 'cash'],
  roas: ['cm3', 'cm3_pct', 'ebitda', 'ebitda_pct', 'cash', 'cac'],
};
/** Input targets whose dependents Coop CAN keep consistent itself: Total GMV is re-summed (by the RPC), so it never goes stale. */
const RECOMPUTED_TARGETS: readonly string[] = ['gmv_total'];
export type TargetLock = {locked: false} | {locked: true; reason: string};
export function targetLock(metric: string): TargetLock {
  if (metric === 'gmv_total') return {locked: true, reason: 'Total GMV is the sum of the three channels, so it cannot be typed.'};
  if (DERIVED_TARGETS.includes(metric)) return {locked: true, reason: 'Calculated by the workbook from other targets, so it cannot be typed.'};
  const feeds = TARGET_FEEDS[metric];
  if (!feeds) return {locked: true, reason: 'This target cannot be changed here.'};
  const stale = feeds.filter((f) => !RECOMPUTED_TARGETS.includes(f));
  if (stale.length === 0) return {locked: false};
  const short = (id: string) => (id.startsWith('cm') ? 'the CM margins' : id.startsWith('ebitda') ? 'EBITDA' : id === 'cac' ? 'CAC' : id);
  const names = [...new Set(stale.map(short))].join(', ');
  return {locked: true, reason: `Locked: changing it would leave ${names} out of date, because Coop does not recalculate the plan. Change the workbook and reload the plan instead.`};
}

/** A target can be edited from the current month on, never in a closed month, and never while its row is locked (see targetLock). */
export const targetEditable = (month: string, metric: string, nowKey: string, closes: Readonly<Record<string, ClosedMonth>>): boolean =>
  !targetLock(metric).locked && month.slice(0, 7) >= nowKey && !closes[month];

export interface ClosedTargetRow {plan_version: number; month: string; metric: string; value: number | string | null}
/**
 * A closed month stays judged against the plan version it closed under, whatever later versions say. `rows` hold those versions' targets for the
 * closed months; a cell the old version did not have keeps the newest value (nothing is invented). Returns a new PlanData.
 */
export function overlayClosedTargets(plan: PlanData, closes: Readonly<Record<string, ClosedMonth>>, rows: readonly ClosedTargetRow[]): PlanData {
  const targets: Record<string, (number | null)[]> = Object.fromEntries(Object.entries(plan.targets).map(([k, v]) => [k, [...v]]));
  for (const r of rows) {
    const close = closes[r.month];
    const i = plan.months.indexOf(r.month);
    if (!close || close.planVersion !== r.plan_version || i < 0 || r.value === null || !targets[r.metric]) continue;
    targets[r.metric][i] = Number(r.value);
  }
  return {...plan, targets};
}

/* ---------- Derived rows: everything the workbook computes by formula is computed here by the same formula, never typed ---------- */

/** Where a prefilled cell came from: 'workbook' = a fact from the plan workbook, 'owner' = also confirmed by the owner. The values are loaded privately (scripts/seed-plan-from-workbook.mjs through plan_seed_actual): none is in the repo. */
export type PrefillSource = 'workbook' | 'owner';
/** The customer roll's two scalar inputs, read from the plan targets repeat_rate and aov (loaded from the workbook). Null = not loaded: customers and CAC wait. */
export interface CustomerAssumptions {repeatRate: number | null; aov: number | null}
export const assumptionsOf = (plan: {targets: Record<string, (number | null)[]>}): CustomerAssumptions => ({
  repeatRate: plan.targets.repeat_rate?.find((v) => v !== null) ?? null, aov: plan.targets.aov?.find((v) => v !== null) ?? null,
});
/** The tag a prefilled cell carries (a typed cell has none): `short` is shown in the cell, `full` is its tooltip. */
export function prefillTag(source: string | null | undefined): {short: string; full: string} | null {
  return source === 'workbook' ? {short: 'workbook', full: 'from workbook'} : source === 'owner' ? {short: 'owner', full: 'per owner, from workbook'} : null;
}

/**
 * Workbook row 90 (cash, month end) = previous cash + row 86 + funding (87) − settlement (88) − freight (89), with row 86 = EBITDA + COGS − inventory purchases
 * (the cash-basis cost of stock: EBITDA already deducted COGS, so it is added back and the stock actually bought is deducted). Any unit, as long as it is one.
 * Every input must be known: one missing gives null, never a guess. A typed 0 is a real 0.
 */
export function cashPerFormula(i: {prevCash: number | null; ebitda: number | null; cogs: number | null; invPurchases: number | null; funding: number | null; settlement: number | null; freight: number | null}): number | null {
  const {prevCash, ebitda, cogs, invPurchases, funding, settlement, freight} = i;
  if (prevCash === null || ebitda === null || cogs === null || invPurchases === null || funding === null || settlement === null || freight === null) return null;
  return prevCash + (ebitda + cogs - invPurchases) + funding - settlement - freight;
}

/**
 * Cash at month end, per month, derived: the first month starts from the typed opening cash (none typed: every month waits), every later month from the month before. A month waits (gap) when any
 * of its inputs is missing OR any earlier month waits, because cash is a running balance. A partial EBITDA (a GMV channel missing) gives a partial, grey cash.
 */
export function cashSeries(ebitda: readonly ActualCell[], lines: LineSeries): ActualCell[] {
  const get = (id: string, i: number): number | null => lines[id]?.[i] ?? null;
  const out: ActualCell[] = [];
  ebitda.forEach((e, i) => {
    const opening = lines.opening_cash?.[0] ?? null;
    const prev = i === 0 ? (opening === null ? GAP : ({value: opening, state: 'ok'} as ActualCell)) : out[i - 1];
    const v = cashPerFormula({prevCash: prev.value, ebitda: e.value, cogs: get('cogs', i), invPurchases: get('inv_purchases_paid', i), funding: get('bridge_funding', i), settlement: get('liability_settlement', i), freight: get('freight_onetime', i)});
    if (v === null) { out.push(GAP); return; }
    const partial = e.state === 'partial' || prev.state === 'partial';
    out.push(partial ? {value: v, state: 'partial', note: 'Cash is understated: a GMV channel is missing in this or an earlier month.'} : {value: v, state: 'ok'});
  });
  return out;
}

/** Workbook row 83: stock on hand at month end = last month's (the first month: the opening stock) + stock bought (82) − COGS (55). Waits like cash. */
export function inventorySeries(lines: LineSeries, n: number): ActualCell[] {
  const get = (id: string, i: number): number | null => lines[id]?.[i] ?? null;
  const out: ActualCell[] = [];
  for (let i = 0; i < n; i++) {
    const prev = i === 0 ? (lines.opening_inventory?.[0] ?? null) : out[i - 1].value;
    const bought = get('inv_purchases_paid', i), cogs = get('cogs', i);
    out.push(prev === null || bought === null || cogs === null ? GAP : {value: prev + bought - cogs, state: 'ok'});
  }
  return out;
}

/** The plan's COGS per month, as the workbook has it: row 55 = Total GMV (51) − CM1 (56). Null where the plan lacks either. */
export const plannedCogs = (plan: {targets: Record<string, (number | null)[]>}): (number | null)[] =>
  (plan.targets.gmv_total ?? []).map((g, i) => { const c = plan.targets.cm1?.[i]; return g === null || c === null || c === undefined ? null : g - c; });

/**
 * Workbook row 84: forward coverage = stock on hand / NEXT month's COGS. The next month has no actual yet, so (like the workbook) it uses the plan's COGS.
 * The last plan month is empty: the workbook grows its own COGS there with the growth input, which Coop does not hold.
 */
export function coverageSeries(onHand: readonly ActualCell[], nextCogs: readonly (number | null)[]): ActualCell[] {
  return onHand.map((h, i) => {
    const c = nextCogs[i + 1] ?? null;
    return h.value === null || c === null || c <= 0 ? GAP : {value: h.value / c, state: 'ok'};
  });
}

/**
 * Workbook rows 121-124, 113 and 96. Per month: repeat GMV (123) = base (121) x repeat rate (118) x AOV (119); new GMV (124) = MAX(0, marketplace + website GMV − repeat GMV);
 * new customers (122) = new GMV / AOV; the base of the next month = base + new customers; Active customers (113) = the base; CAC (96) = total ad spend / new customers.
 * Needs the marketplace and website GMV of this month and every earlier one (a gap waits, a partial GMV is partial), and for CAC all four ad lines.
 * Cohorts need GMV only, so a month with no ad spend typed still has its customers.
 */
export function customerSeries(gmvMarketplace: readonly ActualCell[], gmvWebsite: readonly ActualCell[], lines: LineSeries, assume: CustomerAssumptions): {customers: ActualCell[]; cac: ActualCell[]} {
  const customers: ActualCell[] = [], cac: ActualCell[] = [];
  let base: number | null = lines.opening_customers?.[0] ?? null, partial = false;
  const adIds = ['ad_marketplace', 'ad_website', 'event_marketing', 'content_other'];
  gmvMarketplace.forEach((m, i) => {
    const w = gmvWebsite[i] ?? GAP;
    if (base === null) { customers.push(GAP); cac.push(GAP); return; }
    customers.push({value: base, state: partial ? 'partial' : 'ok', ...(partial ? {note: 'Understated: a GMV channel was missing in an earlier month.'} : {})});
    if (m.value === null || w.value === null || assume.repeatRate === null || assume.aov === null) { base = null; cac.push(GAP); return; }
    const repeat = base * assume.repeatRate * assume.aov;
    const fresh = Math.max(0, m.value + w.value - repeat) / assume.aov;
    const isPartial = partial || m.state === 'partial' || w.state === 'partial';
    const ads = adIds.map((id) => lines[id]?.[i] ?? null);
    cac.push(ads.some((a) => a === null) || fresh <= 0 ? GAP : {value: (ads as number[]).reduce((t, v) => t + v, 0) / fresh, state: isPartial ? 'partial' : 'ok', ...(isPartial ? {note: 'CAC is overstated: a GMV channel is missing.'} : {})});
    base += fresh;
    partial = isPartial;
  });
  return {customers, cac};
}

/** Every actual Coop derives (not typed, not read from a source): margins, cash, coverage, active customers and CAC. `live` = GMV cells by metric id (after closed-month snapshots), `lines` = pesos. */
export function derivedActuals(plan: {months: readonly string[]; targets: Record<string, (number | null)[]>}, live: Readonly<Record<string, ActualCell[]>>, lines: LineSeries): Record<string, ActualCell[]> {
  const pad = (id: string): ActualCell[] => plan.months.map((_, i) => live[id]?.[i] ?? GAP);
  const margins = marginCells(pad('gmv_total'), lines);
  const onHand = inventorySeries(lines, plan.months.length);
  const {customers, cac} = customerSeries(pad('gmv_marketplace'), pad('gmv_website'), lines, assumptionsOf(plan));
  return {...margins, cash: cashSeries(margins.ebitda, lines), coverage: coverageSeries(onHand, plannedCogs(plan)), customers, cac};
}

/** The one header button for the month whose close is waiting: named for the month, quiet (blocked) with the reason when it cannot close yet. Null = no button. */
export function closeAction(i: {waiting: string | null; tag: string; blocker: string | null; filled: number; required: number}): {label: string; blocked: boolean; reason: string | null} | null {
  if (!i.waiting) return null;
  const reason = i.blocker ?? (i.filled < i.required ? `${i.filled} of ${i.required} lines entered for ${i.tag}. Fill in the rest to close it.` : null);
  return {label: `Close ${i.tag}`, blocked: reason !== null, reason};
}
