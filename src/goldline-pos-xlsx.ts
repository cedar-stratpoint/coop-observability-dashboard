// Watsons POS Sales Data workbook reader (P1 · F4). Pure helpers + one async reader.
//
// Watsons sends one .xlsx a month for every store. Four sheets; two matter:
//   Per_Store_Per_SKU     store × SKU for the month → sales rows
//                         (Location · Location Desc · SKU Code · SKU Name ·
//                          Gross Sales Retail TY · Sales Units TY · Sales Net of Vat Net of Discount)
//   Per_SubClass_Per_SKU  each SKU's subclass (FACE COSMETICS, EYES COSMETICS, …) → category
// There are no dates in the rows: the month is only in the title row ("202609 SEPTEMBE",
// sometimes cut short), so the whole file is one period, the 1st to the last day.
// The header row moves between files (row 6 or 7), so it is found by its column names.
import {norm, rowsFromGrid, type PosSaleRow} from './goldline-csv';
import {Readable} from 'node:stream';
import ExcelJS from 'exceljs';
import {cellText} from './shopee-import/cells';

export const SALES_SHEET = 'Per_Store_Per_SKU';
export const SUBCLASS_SHEET = 'Per_SubClass_Per_SKU';

export type Category = 'eyes' | 'lips' | 'face' | 'other';
export type Month = {start: string; end: string};
export type ChainSku = {skuCode: string; name: string; subclass: string | null};
export type WatsonsWorkbook = {
  month: Month | null;
  rows: PosSaleRow[];
  stores: Array<{storeCode: string; name: string}>;
  skus: ChainSku[];
  totalUnits?: number | null; // the file's own TOTAL row, when it has one
  checksumOk?: boolean; // false when the rows don't add up to that TOTAL
  errors: string[];
};

/** The file's month from its title row: the first cell starting with YYYYMM. */
export function monthFromTitle(grid: string[][], scanRows = 12): Month | null {
  for (const row of grid.slice(0, scanRows)) {
    for (const cell of row) {
      const m = /^\s*(\d{4})(\d{2})(?!\d)/.exec(cell ?? '');
      if (!m) continue;
      const y = Number(m[1]);
      const mo = Number(m[2]);
      if (mo < 1 || mo > 12 || y < 2000) return null;
      const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
      const mm = String(mo).padStart(2, '0');
      return {start: `${y}-${mm}-01`, end: `${y}-${mm}-${String(last).padStart(2, '0')}`};
    }
  }
  return null;
}

/** Index of the first row holding every one of `names` (normalised), or -1. */
export function headerRowIndex(grid: string[][], names: string[]): number {
  const want = names.map(norm);
  return grid.findIndex((r) => {
    const cells = r.map((c) => norm(c ?? ''));
    return want.every((w) => cells.includes(w));
  });
}

/** Watsons pads names with spaces ("NICHIDO BEAUTY SPONGE   SPG0161   "); keep single spaces. */
const tidy = (s: string) => s.trim().replace(/\s+/g, ' ');

/** The subclass sheet as SKU code → name + subclass. */
export function parseSubclassSheet(grid: string[][]): ChainSku[] {
  const h = headerRowIndex(grid, ['SKU Code', 'Subclass Name']);
  if (h < 0) return [];
  const header = grid[h].map((c) => norm(c ?? ''));
  const col = (name: string) => header.indexOf(norm(name));
  const [code, name, sub] = [col('SKU Code'), col('SKU Name'), col('Subclass Name')];
  const out: ChainSku[] = [];
  for (const r of grid.slice(h + 1)) {
    const skuCode = (r[code] ?? '').trim();
    if (!skuCode) continue;
    out.push({skuCode, name: tidy(r[name] ?? ''), subclass: tidy(r[sub] ?? '') || null});
  }
  return out;
}

/** Watsons subclass → the plan's four categories. Skin facial, others and promo are Other. */
export function categoryFromSubclass(subclass: string | null | undefined): Category | null {
  const s = tidy(subclass ?? '').toUpperCase();
  if (!s) return null;
  if (s.startsWith('EYE')) return 'eyes';
  if (s.startsWith('LIP')) return 'lips';
  if (s.startsWith('FACE')) return 'face';
  return 'other';
}

/**
 * The Nichido item code a Watsons SKU name ends with, when the catalog has it:
 * "NICHIDO BEAUTY SPONGE SPG0161" → SPG0161. Tries every token from the end, then a
 * cut-short last token that is the unique start of one catalog code ("… CS01" → CS0164).
 * Returns null when nothing matches or a cut-short token is ambiguous.
 */
export function itemCodeFromName(name: string, catalogCodes: Iterable<string>): string | null {
  const byUpper = new Map<string, string>();
  for (const c of catalogCodes) byUpper.set(c.trim().toUpperCase(), c);
  const tokens = tidy(name).split(' ').map((t) => t.replace(/^[#(]+|[).,]+$/g, '').toUpperCase()).filter(Boolean);
  for (let i = tokens.length - 1; i >= 1; i--) {
    const hit = byUpper.get(tokens[i]);
    if (hit) return hit;
  }
  const last = tokens[tokens.length - 1] ?? '';
  if (last.length >= 4 && /\d/.test(last)) {
    const starts = [...byUpper.keys()].filter((c) => c.startsWith(last));
    if (starts.length === 1) return byUpper.get(starts[0]) ?? null;
  }
  return null;
}

/** Turn the two sheets' grids into the month, sales rows, stores and SKU list. */
export function parseWatsonsGrids(sales: string[][] | null, subclass: string[][] | null): WatsonsWorkbook {
  const empty: WatsonsWorkbook = {month: null, rows: [], stores: [], skus: [], errors: []};
  if (!sales) return {...empty, errors: [`This isn’t a Watsons POS Sales Data file (no ${SALES_SHEET} sheet).`]};

  const month = monthFromTitle(sales);
  const h = headerRowIndex(sales, ['Location', 'SKU Code']);
  if (h < 0) return {...empty, month, errors: [`The ${SALES_SHEET} sheet has no Location / SKU Code header row.`]};
  // Spreadsheet rows aren't pre-filtered like CSV lines: drop fully blank ones first,
  // and set aside the closing TOTAL row (no store, "TOTAL" in a cell) as a checksum.
  const header = sales[h].map((c) => norm(c ?? ''));
  const unitsCol = header.findIndex((c) => c === 'sales units ty' || c === 'sales units');
  let totalUnits: number | null = null;
  const body = sales.slice(h).filter((r, i) => {
    if (i === 0) return true;
    if (!r.some((c) => (c ?? '').trim() !== '')) return false;
    if (r.some((c) => norm(c ?? '') === 'total')) {
      const n = Number(String(r[unitsCol] ?? '').replace(/,/g, ''));
      if (unitsCol >= 0 && Number.isFinite(n)) totalUnits = n;
      return false;
    }
    return true;
  });
  const {rows, errors} = rowsFromGrid(body, h);
  if (!month) errors.unshift('The month couldn’t be read from the title row (expected YYYYMM, e.g. 202609).');
  const units = rows.reduce((a, r) => a + (r.units ?? 0), 0);
  const checksumOk = totalUnits === null || Math.round(units) === Math.round(totalUnits);
  if (!checksumOk) {
    errors.unshift(`The rows add up to ${units.toLocaleString('en-US')} units but the file's TOTAL says ${Number(totalUnits).toLocaleString('en-US')}. The file may be cut off.`);
  }

  const stores = new Map<string, string>();
  for (const r of rows) if (!stores.has(r.storeCode)) stores.set(r.storeCode, tidy(r.storeName) || r.storeCode);

  // SKU list: the subclass sheet when present, plus any SKU only seen in the sales rows.
  const skus = new Map<string, ChainSku>();
  for (const s of subclass ? parseSubclassSheet(subclass) : []) skus.set(s.skuCode, s);
  for (const r of rows) if (!skus.has(r.skuCode)) skus.set(r.skuCode, {skuCode: r.skuCode, name: tidy(r.skuDesc), subclass: null});

  return {
    month,
    rows: rows.map((r) => ({...r, storeName: tidy(r.storeName), skuDesc: tidy(r.skuDesc)})),
    stores: [...stores].map(([storeCode, name]) => ({storeCode, name})),
    skus: [...skus.values()],
    totalUnits,
    checksumOk,
    errors,
  };
}

/**
 * Read an uploaded Watsons workbook. Never throws for a bad file; errors say why.
 *
 * Uses exceljs's streaming reader on purpose: the sales sheet carries ~74k merged
 * cells, and the full loader (`wb.xlsx.load`) spends minutes on those merges. The
 * stream reads the same cells in well under a second and skips styles and merges.
 */
export async function readWatsonsWorkbook(bytes: ArrayBuffer | Uint8Array | Buffer): Promise<WatsonsWorkbook> {
  const fail = (msg: string): WatsonsWorkbook => ({month: null, rows: [], stores: [], skus: [], errors: [msg]});
  const grids = new Map<string, string[][]>();
  try {
    const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes);
    const reader = new ExcelJS.stream.xlsx.WorkbookReader(Readable.from([buf]), {
      sharedStrings: 'cache',
      worksheets: 'emit',
      styles: 'ignore',
      hyperlinks: 'ignore',
    });
    for await (const ws of reader as unknown as AsyncIterable<AsyncIterable<ExcelJS.Row> & {name: string}>) {
      const key = norm(ws.name ?? '');
      const want = key === norm(SALES_SHEET) || key === norm(SUBCLASS_SHEET);
      const rows: string[][] = [];
      // Every sheet must be drained, wanted or not, for the stream to move on.
      for await (const row of ws) if (want) rows.push(Array.from((row.values as ExcelJS.CellValue[]).slice(1), cellText)); // fills empty-cell holes
      if (want) grids.set(key, rows);
    }
  } catch {
    return fail('This isn’t a Watsons POS Sales Data workbook (it could not be read as .xlsx).');
  }
  return parseWatsonsGrids(grids.get(norm(SALES_SHEET)) ?? null, grids.get(norm(SUBCLASS_SHEET)) ?? null);
}
