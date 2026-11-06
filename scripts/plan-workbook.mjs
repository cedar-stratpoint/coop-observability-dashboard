// Reads the Cedar Tree business plan workbook (sheet 'Business Plan', Aug'26 to Dec'27 in columns C..S) into plan targets.
// Shared by scripts/seed-plan-from-workbook.mjs (the private loader) and test/plan-seed.test.ts (cell-for-cell check, only when PLAN_WORKBOOK is set). No database, no network.
// No plan figure lives in the repo: every number comes from the workbook file at run time.
import ExcelJS from 'exceljs';

export const FIRST_COL = 3; // C
export const MONTH_COUNT = 17;
/** metric id -> workbook row and scale (thousands -> pesos is x1000; ratios and counts are kept as they are). */
export const SOURCE = {
  gmv_total: {row: 51, scale: 1000}, gmv_marketplace: {row: 48, scale: 1000}, gmv_website: {row: 49, scale: 1000}, gmv_events: {row: 50, scale: 1000},
  cm1: {row: 56, scale: 1000}, cm1_pct: {row: 57, scale: 1}, cm2: {row: 62, scale: 1000}, cm2_pct: {row: 63, scale: 1},
  cm3: {row: 72, scale: 1000}, cm3_pct: {row: 73, scale: 1}, overhead: {row: 39, scale: 1000},
  ebitda: {row: 75, scale: 1000}, ebitda_pct: {row: 76, scale: 1},
  // Plan targets for the typed cost lines (BHR): the workbook formulas that PLAN what an admin later types as paid. content_other is rows 69 + 70 (see below).
  cogs: {row: 55, scale: 1000}, platform_fees: {row: 59, scale: 1000}, fulfilment: {row: 60, scale: 1000}, event_costs: {row: 61, scale: 1000},
  ad_marketplace: {row: 66, scale: 1000}, ad_website: {row: 67, scale: 1000}, event_marketing: {row: 68, scale: 1000},
  bridge_funding: {row: 87, scale: 1000}, liability_settlement: {row: 88, scale: 1000}, freight_onetime: {row: 89, scale: 1000},
  inv_purchases: {row: 41, scale: 1000}, cash: {row: 90, scale: 1000}, roas: {row: 9, scale: 1}, cac: {row: 96, scale: 1}, customers: {row: 113, scale: 1},
};
/** Workbook sub-rows behind the three consolidated typed lines (the Fixed overhead / COGS / Content and other breakdown the modal asks for). Plan values only. */
export const PART_SOURCE = {
  overhead: {salaries: 33, rent: 34, accounting: 35, tech: 36, growth_consultant: 37, rnd: 38},
  cogs: {marketplace_cogs: 52, website_cogs: 53, events_cogs: 54},
  content_other: {content_socials: 69, other_spend: 70},
};
export const COVERAGE_ROW = 45; // one scalar in column C, not a monthly series
/** Scalar workbook inputs (column C): the customer roll's repeat rate (row 118) and average order value (row 119, thousands -> pesos). Stored as plan targets repeat_rate / aov, the same value for every month. */
export const ASSUMPTION_SOURCE = {repeat_rate: {row: 118, scale: 1}, aov: {row: 119, scale: 1000}};
/** The known ACTUAL opening facts, prefilled once through plan_seed_actual: opening stock (row 44) and opening customers (row 120) in the first month, bridge funding (row 87) in month index 1 (Sep'26), which the owner confirmed. */
export const PREFILL_SOURCE = [
  {metric: 'opening_inventory', row: 44, scale: 1000, month: 0, source: 'workbook'},
  {metric: 'opening_customers', row: 120, scale: 1, month: 0, source: 'workbook'},
  {metric: 'bridge_funding', row: 87, scale: 1000, month: 1, source: 'owner'},
];

const val = (c) => { const v = c.value; return v && typeof v === 'object' && ('formula' in v || 'sharedFormula' in v) ? v.result : v; };

export async function readWorkbook(file) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const ws = wb.getWorksheet('Business Plan');
  if (!ws) throw new Error("sheet 'Business Plan' not found");
  const cell = (row, i) => ws.getRow(row).getCell(FIRST_COL + i);
  const colIndex = (letters) => letters.split('').reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - FIRST_COL;
  // A formula cell with no cached value in the file (the first month of some rows, where Excel never stored the 0): evaluate its plain arithmetic from the cells it names.
  // Only + - * / ( ) and numbers are accepted after the references are replaced, so nothing else can run. Anything else is an error, never a guess.
  const evalFormula = (f) => {
    const expr = f.replace(/\$?([A-Z]{1,2})\$?(\d+)/g, (_m, c, r) => `(${cell(Number(r), colIndex(c)).value === null ? 0 : raw(Number(r), colIndex(c))})`); // a blank cell is 0, as in Excel
    if (!/^[\d+\-*/().\se]+$/i.test(expr)) throw new Error(`cannot evaluate formula =${f}`);
    return Function(`"use strict"; return (${expr});`)();
  };
  const raw = (row, i) => {
    const c = cell(row, i);
    const v = val(c);
    if (v === undefined && c.value && typeof c.value === 'object' && typeof c.value.formula === 'string') return Number(evalFormula(c.value.formula));
    if (typeof v !== 'number') throw new Error(`row ${row} month ${i}: expected a number, got ${JSON.stringify(v)}`);
    return v;
  };
  const months = Array.from({length: MONTH_COUNT}, (_, i) => {
    const label = String(val(ws.getRow(4).getCell(FIRST_COL + i)));
    const m = /^([A-Z][a-z]{2})'(\d\d)$/.exec(label);
    if (!m) throw new Error(`unexpected month header ${label}`);
    return `20${m[2]}-${String('JanFebMarAprMayJunJulAugSepOctNovDec'.indexOf(m[1]) / 3 + 1).padStart(2, '0')}-01`;
  });
  const targets = {};
  for (const [id, {row, scale}] of Object.entries(SOURCE)) targets[id] = months.map((_, i) => Math.round(raw(row, i) * scale * 1e6) / 1e6);
  // Content, socials and other: one typed line in Coop, two workbook rows (69 content & socials, 70 other spend).
  targets.content_other = months.map((_, i) => Math.round((raw(69, i) + raw(70, i)) * 1000 * 1e6) / 1e6);
  // One sign convention: overhead is stored as a positive cost; the workbook's row 74 is the same figure, negative.
  for (let i = 0; i < MONTH_COUNT; i++) {
    if (Math.abs(raw(74, i) + raw(39, i)) > 1e-9) throw new Error(`row 74 is not -row 39 in month ${i}`);
    if (Math.abs(raw(9, i) - raw(13, i)) > 1e-9) throw new Error(`marketplace and website ROAS differ in month ${i}`);
  }
  const coverage = Number(val(ws.getRow(COVERAGE_ROW).getCell(FIRST_COL)));
  if (!(coverage > 0)) throw new Error('coverage target (row 45) is not a number');
  targets.coverage = months.map(() => coverage);
  const partTargets = Object.fromEntries(Object.entries(PART_SOURCE).map(([line, parts]) => [line, Object.fromEntries(Object.entries(parts).map(([part, row]) => [part, months.map((_, i) => Math.round(raw(row, i) * 1000 * 1e6) / 1e6)]))]));
  const assumptions = Object.fromEntries(Object.entries(ASSUMPTION_SOURCE).map(([id, {row, scale}]) => [id, Math.round(raw(row, 0) * scale * 1e6) / 1e6]));
  const prefills = PREFILL_SOURCE.map(({metric, row, scale, month, source}) => ({month: months[month], metric, amountPhp: Math.round(raw(row, month) * scale * 1e6) / 1e6, source}));
  return {months, targets, partTargets, assumptions, prefills};
}
