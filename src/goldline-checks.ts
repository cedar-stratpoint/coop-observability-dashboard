// Goldline checks (P2 · F6, F7). Pure + unit-tested; the data side is
// src/goldline-checks-data.ts.
//
// Every committed form row goes through the plan's checks, and each finding names one
// of three causes (plan §06):
//   unreadable     a cell the scan reader marked as overwritten, unclear or straddling
//   row_math       the written ending doesn't add up            → human error
//   zero_or_below  ending at 0 or less (every 0, plan Q13)       → manipulation
//   sales_gap      the month's form sold vs. POS sold differ     → human error
// A row with an unreadable cell skips the math check: the math can't be judged on a
// number nobody could read.
//
// Form vs. sales runs per store, item and calendar month, because POS Sales Data is
// whole-month totals (plan §05):
//   start     = final on hand before the month + delivered this month − adjustments
//   form_sold = start − this month's final on hand
//   gap       = form_sold − POS sold;  flag when |gap| > max(min units, pct × POS sold)
// On hand is the written ending, else stockroom + drawer + selling area (onHandOf).
// A store's first count is the baseline only (Q11); a month with no POS file waits.
import {onHandOf} from './goldline-inventory';

export type FlagKind = 'sales_gap' | 'zero_or_below' | 'row_math' | 'unreadable';
export type FlagCause = 'human_error' | 'unreadable' | 'manipulation';
export const CAUSE_OF: Record<FlagKind, FlagCause> = {
  unreadable: 'unreadable',
  row_math: 'human_error',
  zero_or_below: 'manipulation',
  sales_gap: 'human_error',
};

export type CountRow = {
  store_code: string;
  item_code: string;
  period_start: string;
  period_end: string;
  stockroom: number | null;
  drawer: number | null;
  selling_area: number | null;
  delivery: number | null;
  ending_on_hand: number | null;
  consultant: string | null;
  source_upload_id: string | null;
};
export type Adjustment = {store_code: string; item_code: string; period_end: string; qty: number};
export type CellMark = {field: string; mark: 'overwritten' | 'unclear' | 'straddle'; written?: string | null};
export type MarkedRow = {store_code: string; item_code: string; period_start: string; period_end: string; upload_id: string; marks: CellMark[]};
export type CheckSettings = {gapMinUnits: number; gapPct: number};
export const DEFAULT_SETTINGS: CheckSettings = {gapMinUnits: 1, gapPct: 0.05};

export type Finding = {
  kind: FlagKind;
  cause: FlagCause;
  store_code: string;
  item_code: string;
  period_start: string;
  period_end: string;
  consultant: string | null;
  source_upload_id: string | null;
  details: Record<string, unknown>;
};

export type MonthState = 'match' | 'flag' | 'baseline' | 'waiting_sales' | 'unlinked' | 'not_counted';
export type MonthCheck = {
  store_code: string;
  item_code: string;
  month: string; // YYYY-MM
  state: MonthState;
  start: number | null;
  delivered: number;
  adjusted: number;
  ending: number | null;
  formSold: number | null;
  posSold: number | null;
  gap: number | null;
  allowed: number | null;
};

const monthOf = (isoDate: string) => isoDate.slice(0, 7);
export const monthBounds = (month: string) => {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return {start: `${month}-01`, end: `${month}-${String(last).padStart(2, '0')}`};
};

/** How big a gap may be before it's flagged: max(min units, pct × POS sold). */
export function allowedGap(posSold: number, s: CheckSettings = DEFAULT_SETTINGS): number {
  return Math.max(s.gapMinUnits, s.gapPct * Math.abs(posSold));
}

/**
 * Row math, only when an ending is written and at least one part is. The form doesn't
 * settle whether the ending includes the delivery column, so a row passes when it adds
 * up either way; it's flagged only when it matches neither.
 */
export function rowMathOff(r: CountRow): {written: number; counted: number; withDelivery: number} | null {
  if (r.ending_on_hand == null) return null;
  const parts = [r.stockroom, r.drawer, r.selling_area];
  if (parts.every((p) => p == null) && r.delivery == null) return null;
  const counted = parts.reduce<number>((a, p) => a + (p ?? 0), 0);
  const withDelivery = counted + (r.delivery ?? 0);
  if (r.ending_on_hand === counted || r.ending_on_hand === withDelivery) return null;
  return {written: r.ending_on_hand, counted, withDelivery};
}

/** Row-level findings for every committed count (unreadable first, then math, then zero). */
export function rowFindings(counts: CountRow[], marked: MarkedRow[] = []): Finding[] {
  const key = (r: {store_code: string; item_code: string; period_start: string; period_end: string}) =>
    `${r.store_code}|${r.item_code}|${r.period_start}|${r.period_end}`;
  const marksBy = new Map(marked.filter((m) => m.marks.length).map((m) => [key(m), m]));
  const out: Finding[] = [];
  for (const r of counts) {
    const base = {
      store_code: r.store_code,
      item_code: r.item_code,
      period_start: r.period_start,
      period_end: r.period_end,
      consultant: r.consultant,
      source_upload_id: r.source_upload_id,
    };
    const m = marksBy.get(key(r));
    if (m) out.push({...base, kind: 'unreadable', cause: CAUSE_OF.unreadable, source_upload_id: m.upload_id, details: {marks: m.marks}});
    const math = m ? null : rowMathOff(r);
    if (math) {
      out.push({
        ...base,
        kind: 'row_math',
        cause: CAUSE_OF.row_math,
        details: {...math, stockroom: r.stockroom, drawer: r.drawer, selling_area: r.selling_area, delivery: r.delivery},
      });
    }
    const onHand = onHandOf(r).onHand;
    if (onHand != null && onHand <= 0) {
      out.push({...base, kind: 'zero_or_below', cause: CAUSE_OF.zero_or_below, details: {onHand, source: onHandOf(r).source}});
    }
  }
  return out;
}

/**
 * Form vs. sales per store, item and month. `posSold` gives a month's POS units for a
 * store and item (undefined = no units recorded); `salesMonths` lists months with a POS
 * file loaded; `linked` lists items with a Watsons SKU.
 */
export function monthlyChecks(input: {
  counts: CountRow[];
  adjustments: Adjustment[];
  posSold: (store: string, item: string, month: string) => number | undefined;
  salesMonths: ReadonlySet<string>;
  linked: ReadonlySet<string>;
  settings?: CheckSettings;
}): {months: MonthCheck[]; findings: Finding[]} {
  const s = input.settings ?? DEFAULT_SETTINGS;
  const series = new Map<string, CountRow[]>(); // store|item → counts by date
  for (const r of input.counts) {
    const k = `${r.store_code}|${r.item_code}`;
    series.set(k, [...(series.get(k) ?? []), r]);
  }
  const adjBy = new Map<string, number>(); // store|item|month → qty
  for (const a of input.adjustments) {
    const k = `${a.store_code}|${a.item_code}|${monthOf(a.period_end)}`;
    adjBy.set(k, (adjBy.get(k) ?? 0) + a.qty);
  }

  const months: MonthCheck[] = [];
  const findings: Finding[] = [];
  for (const [k, rows] of series) {
    const [store, item] = k.split('|');
    rows.sort((a, b) => a.period_end.localeCompare(b.period_end) || a.period_start.localeCompare(b.period_start));
    const byMonth = new Map<string, CountRow[]>();
    for (const r of rows) byMonth.set(monthOf(r.period_end), [...(byMonth.get(monthOf(r.period_end)) ?? []), r]);

    for (const [month, inMonth] of [...byMonth].sort(([a], [b]) => a.localeCompare(b))) {
      // Final on hand before this month: the latest earlier count that has one.
      const before = rows.filter((r) => r.period_end < `${month}-01` && onHandOf(r).onHand != null).at(-1);
      const last = [...inMonth].reverse().find((r) => onHandOf(r).onHand != null);
      const delivered = inMonth.reduce((a, r) => a + (r.delivery ?? 0), 0);
      const adjusted = adjBy.get(`${store}|${item}|${month}`) ?? 0;
      const ending = last ? (onHandOf(last).onHand as number) : null;
      const row: MonthCheck = {store_code: store, item_code: item, month, state: 'baseline', start: null, delivered, adjusted, ending, formSold: null, posSold: null, gap: null, allowed: null};
      if (ending == null) {
        months.push({...row, state: 'not_counted'}); // left blank on the form this month
        continue;
      }
      if (!before) {
        months.push(row); // first count for this item at this store: baseline only (Q11)
        continue;
      }
      row.start = (onHandOf(before).onHand as number) + delivered - adjusted;
      row.formSold = row.start - ending;
      if (!input.linked.has(item)) {
        months.push({...row, state: 'unlinked'});
        continue;
      }
      if (!input.salesMonths.has(month)) {
        months.push({...row, state: 'waiting_sales'});
        continue;
      }
      const pos = input.posSold(store, item, month) ?? 0;
      row.posSold = pos;
      row.gap = row.formSold - pos;
      row.allowed = allowedGap(pos, s);
      row.state = Math.abs(row.gap) > row.allowed ? 'flag' : 'match';
      months.push(row);
      if (row.state === 'flag') {
        const {start, end} = monthBounds(month);
        findings.push({
          kind: 'sales_gap',
          cause: CAUSE_OF.sales_gap,
          store_code: store,
          item_code: item,
          period_start: start,
          period_end: end,
          // Every BA on the month's forms shares the gap (a mid-month change tags both).
          consultant: [...new Set(inMonth.map((r) => r.consultant?.trim()).filter(Boolean))].join(', ') || null,
          source_upload_id: last?.source_upload_id ?? null,
          details: {
            start: row.start,
            opening: onHandOf(before).onHand,
            opening_period_end: before.period_end,
            delivered,
            adjusted,
            ending,
            form_sold: row.formSold,
            pos_sold: pos,
            gap: row.gap,
            allowed: row.allowed,
            direction: row.gap > 0 ? 'form_sold_more' : 'pos_sold_more',
          },
        });
      }
    }
  }
  return {months, findings};
}
