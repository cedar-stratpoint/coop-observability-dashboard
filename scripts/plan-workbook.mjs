// Reads the Cedar Tree business plan workbook (sheet 'Business Plan', Aug'26 to Dec'27 in columns C..S) into plan targets.
// Shared by scripts/seed-plan-from-workbook.mjs (the private loader) and the workbook-gated tests (only when PLAN_WORKBOOK is set). No database, no network.
// No plan figure lives in the repo: every number comes from the workbook file at run time. Every value is a TARGET: the workbook holds no actual (BHR-06).
// Which rows to read, their unit and target id come from the sheet's row map, src/plan-sheet.json (labels only), shared with the page.
import {readFileSync} from 'node:fs';
import ExcelJS from 'exceljs';

export const FIRST_COL = 3; // C
export const MONTH_COUNT = 17;
/** The sheet rows 4 to 125 (src/plan-sheet.json); a row with a unit holds values. Thousands of pesos become pesos (x1000); every other unit is kept as it is. */
export const SHEET = JSON.parse(readFileSync(new URL('../src/plan-sheet.json', import.meta.url), 'utf8'));
const scaleOf = (unit) => (unit === 'php' ? 1000 : 1);
const idOf = (r) => r.id ?? `r${r.row}`;
const isSingle = (r) => r.kind === 'static' || !!r.single;
/** metric id -> workbook row and scale, for the monthly rows the page already had an id for (gmv_total, cash, cogs, ...). */
export const SOURCE = Object.fromEntries(SHEET.filter((r) => r.unit && r.id && !isSingle(r)).map((r) => [r.id, {row: r.row, scale: scaleOf(r.unit)}]));
/** Scalar workbook inputs (column C): the customer roll's repeat rate (row 118) and average order value (row 119, thousands -> pesos). Stored as plan targets repeat_rate / aov, the same value for every month. */
export const ASSUMPTION_SOURCE = {repeat_rate: {row: 118, scale: 1}, aov: {row: 119, scale: 1000}};

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
  const round = (v) => Math.round(v * 1e6) / 1e6;
  // Every value row of the sheet is a target series of 17 months. A setting or market-sizing row (one value in column C) repeats that value every month;
  // a check row is 1 for OK and 0 for its failing word; a blank cell is no target (null), never a 0.
  for (const r of SHEET.filter((x) => x.unit)) {
    const at = (i) => {
      const c = cell(r.row, i);
      if (c.value === null || c.value === undefined) return null;
      if (r.unit === 'check') return String(val(c)).startsWith('OK') ? 1 : 0;
      return round(raw(r.row, i) * scaleOf(r.unit));
    };
    targets[idOf(r)] = isSingle(r) ? months.map(() => at(0)) : months.map((_, i) => at(i));
  }
  // One sign convention: overhead is stored as a positive cost; the workbook's row 74 is the same figure, negative.
  for (let i = 0; i < MONTH_COUNT; i++) {
    if (Math.abs(raw(74, i) + raw(39, i)) > 1e-9) throw new Error(`row 74 is not -row 39 in month ${i}`);
    if (Math.abs(raw(9, i) - raw(13, i)) > 1e-9) throw new Error(`marketplace and website ROAS differ in month ${i}`);
  }
  if (!(targets.coverage[0] > 0)) throw new Error('coverage target (row 45) is not a number');
  const assumptions = Object.fromEntries(Object.entries(ASSUMPTION_SOURCE).map(([id, {row, scale}]) => [id, Math.round(raw(row, 0) * scale * 1e6) / 1e6]));
  return {months, targets, assumptions};
}
