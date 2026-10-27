// Goldline forecast inputs (F10, pure, unit-tested) — what the restock (F11) starts from.
//
// Decided Oct 26 and Oct 27:
// • A run covers the next `windowMonths` calendar months after the run date (an Oct 31 run
//   covers Nov to Jan, a Nov 15 run Dec to Feb), from each store's own sales in last
//   year's same months. No season multipliers or store profiles: last year carries them.
// • Safety stock = last year's final `safetyMonths` of the window.
// • F10 decides which lines wait ("check data first") and why; F11 only does the math
//   (need − on hand − on the way + safety). Missing data holds a line; there is no
//   fallback formula.

import {addMonthKey} from './goldline-supply';

export type ForecastSettings = {windowMonths: number; safetyMonths: number};
export const DEFAULT_FORECAST_SETTINGS: ForecastSettings = {windowMonths: 3, safetyMonths: 1};
export const MAX_WINDOW_MONTHS = 6;

/** One month of POS Sales Data, as forecast_months() reports it. Month is YYYY-MM. */
export type MonthStatus = {month: string; loaded: boolean; units: number; unlinkedUnits: number};

export type HoldReason = 'missing_month' | 'out_of_scope' | 'retired' | 'open_flag' | 'no_history';
/** Display order; a line lists every reason that applies, in this order. */
export const HOLD_REASONS: HoldReason[] = ['missing_month', 'out_of_scope', 'retired', 'open_flag', 'no_history'];

export type ForecastWindow = {
  runDate: string; // YYYY-MM-DD
  months: string[]; // the months the run covers
  lastYear: string[]; // the same months a year earlier, aligned with `months`
  safety: string[]; // last year's months that make the safety stock (end of the window)
};

export type ForecastLine = {
  storeCode: string;
  itemCode: string;
  units: Array<number | null>; // last year's units per window month; null = month not loaded
  need: number | null; // last year's window total (null when a month is missing)
  safety: number | null; // last year's safety months total
  holds: HoldReason[]; // empty = ready for the restock
};

export type ForecastSummary = {
  lines: number;
  ready: number;
  held: number;
  byReason: Record<HoldReason, number>;
  missingMonths: string[]; // last year's window months with no POS Sales Data (ask Justin)
  needUnits: number; // last year's window units on ready lines
  windowUnits: number; // every unit sold in last year's window months, linked or not
  unlinkedUnits: number; // of those, on Watsons SKUs with no product link (not forecast)
};

export type StoreRollup = {storeCode: string; lines: number; ready: number; held: number; needUnits: number; inScope: boolean};

const monthOf = (date: string) => date.slice(0, 7);

export function clampSettings(s: Partial<ForecastSettings> | null | undefined): ForecastSettings {
  const w = Number.isInteger(s?.windowMonths) ? Math.min(MAX_WINDOW_MONTHS, Math.max(1, s!.windowMonths!)) : DEFAULT_FORECAST_SETTINGS.windowMonths;
  const sf = Number.isInteger(s?.safetyMonths) ? Math.min(w, Math.max(0, s!.safetyMonths!)) : Math.min(w, DEFAULT_FORECAST_SETTINGS.safetyMonths);
  return {windowMonths: w, safetyMonths: sf};
}

/** The months a run on `runDate` covers: the next N calendar months after its month. */
export function forecastWindow(runDate: string, settings: ForecastSettings): ForecastWindow {
  const {windowMonths, safetyMonths} = clampSettings(settings);
  const run = monthOf(runDate);
  const months = Array.from({length: windowMonths}, (_, i) => addMonthKey(run, i + 1));
  const lastYear = months.map((m) => addMonthKey(m, -12));
  return {runDate, months, lastYear, safety: safetyMonths ? lastYear.slice(-safetyMonths) : []};
}

/** The 12 months before the run's month: the year of sales a forecast can draw on. */
export function salesYear(runDate: string): string[] {
  const run = monthOf(runDate);
  return Array.from({length: 12}, (_, i) => addMonthKey(run, i - 12));
}

export function buildForecastLines(input: {
  window: ForecastWindow;
  months: MonthStatus[]; // at least the window's last-year months
  history: Array<{storeCode: string; itemCode: string; units: number[]}>; // aligned with window.lastYear
  inScope: Set<string>; // store codes in scope (F2)
  retired: Set<string>; // retired item codes (F2)
  openFlags: Set<string>; // `${store}|${item}` with an open flag (F7)
  counted: Array<{storeCode: string; itemCode: string}>; // pairs on each store's latest count (F9)
}): ForecastLine[] {
  const {window, inScope, retired, openFlags} = input;
  const loaded = new Map(input.months.map((m) => [m.month, m.loaded]));
  const isLoaded = window.lastYear.map((m) => loaded.get(m) === true);
  const missing = isLoaded.some((x) => !x);
  const safetyIdx = window.safety.map((m) => window.lastYear.indexOf(m));

  // Every pair that sold last year, plus every pair counted now (so a product that
  // didn't sell last year shows up as "no sales last year" rather than not at all).
  const pairs = new Map<string, {storeCode: string; itemCode: string; units: number[]}>();
  for (const h of input.history) pairs.set(`${h.storeCode}|${h.itemCode}`, h);
  for (const c of input.counted) {
    const k = `${c.storeCode}|${c.itemCode}`;
    if (!pairs.has(k)) pairs.set(k, {storeCode: c.storeCode, itemCode: c.itemCode, units: window.lastYear.map(() => 0)});
  }

  const lines: ForecastLine[] = [];
  for (const [k, p] of pairs) {
    const units = window.lastYear.map((_, i) => (isLoaded[i] ? Number(p.units[i]) || 0 : null));
    const need = missing ? null : (units as number[]).reduce((a, b) => a + b, 0);
    const safety = missing ? null : safetyIdx.reduce((a, i) => a + (units[i] as number), 0);
    const holds: HoldReason[] = [];
    if (missing) holds.push('missing_month');
    if (!inScope.has(p.storeCode)) holds.push('out_of_scope');
    if (retired.has(p.itemCode)) holds.push('retired');
    if (openFlags.has(k)) holds.push('open_flag');
    if (need != null && need <= 0) holds.push('no_history');
    lines.push({storeCode: p.storeCode, itemCode: p.itemCode, units, need, safety, holds});
  }
  return lines.sort((a, b) => a.storeCode.localeCompare(b.storeCode, undefined, {numeric: true}) || a.itemCode.localeCompare(b.itemCode));
}

export function forecastSummary(lines: ForecastLine[], window: ForecastWindow, months: MonthStatus[]): ForecastSummary {
  const byMonth = new Map(months.map((m) => [m.month, m]));
  const byReason = Object.fromEntries(HOLD_REASONS.map((r) => [r, 0])) as Record<HoldReason, number>;
  let ready = 0;
  let needUnits = 0;
  for (const l of lines) {
    if (!l.holds.length) {
      ready++;
      needUnits += l.need ?? 0;
    }
    for (const r of l.holds) byReason[r]++;
  }
  const inWindow = window.lastYear.map((m) => byMonth.get(m));
  return {
    lines: lines.length,
    ready,
    held: lines.length - ready,
    byReason,
    missingMonths: window.lastYear.filter((m) => byMonth.get(m)?.loaded !== true),
    needUnits,
    windowUnits: inWindow.reduce((a, m) => a + (m?.units ?? 0), 0),
    unlinkedUnits: inWindow.reduce((a, m) => a + (m?.unlinkedUnits ?? 0), 0),
  };
}

/** One row per store: how many of its lines are ready, and last year's units on them. */
export function storeRollup(lines: ForecastLine[], inScope: Set<string>): StoreRollup[] {
  const by = new Map<string, StoreRollup>();
  for (const l of lines) {
    const r = by.get(l.storeCode) ?? {storeCode: l.storeCode, lines: 0, ready: 0, held: 0, needUnits: 0, inScope: inScope.has(l.storeCode)};
    r.lines++;
    if (l.holds.length) r.held++;
    else {
      r.ready++;
      r.needUnits += l.need ?? 0;
    }
    by.set(l.storeCode, r);
  }
  return [...by.values()].sort((a, b) => a.storeCode.localeCompare(b.storeCode, undefined, {numeric: true}));
}
