import ExcelJS from 'exceljs';
import {cellText} from './shopee-import/cells';
import type {PoFormCell} from './goldline-po-form';

// Read Nichido's PO form workbook (one sheet per printed page) into description cells.
// Each sheet has a header row with two "QTY. | DESCRIPTION" pairs; the products are the
// cells under each DESCRIPTION header. A sheet with no such header (a cover, notes) is
// skipped. Not server-only so the parser can be tested against the real sample file.

export class PoFormFileError extends Error {}

export async function readPoFormXlsx(bytes: ArrayBuffer | Uint8Array | Buffer): Promise<PoFormCell[]> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load((Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes as ArrayBuffer)) as unknown as ExcelJS.Buffer);
  } catch {
    throw new PoFormFileError('That file could not be opened as an Excel workbook.');
  }
  const cells: PoFormCell[] = [];
  wb.eachSheet((ws, sheetNo) => {
    const grid: string[][] = [];
    ws.eachRow({includeEmpty: true}, (row, r) => {
      grid[r - 1] = Array.from((row.values as ExcelJS.CellValue[]).slice(1), cellText);
    });
    cells.push(...poFormCellsFromGrid(grid, ws.name || String(sheetNo)));
  });
  if (!cells.length) throw new PoFormFileError('No "DESCRIPTION" column was found. Is this the PO form?');
  return cells;
}

/** The description cells of one sheet's grid (rows of cell text). Exported for tests. */
export function poFormCellsFromGrid(grid: string[][], page: string): PoFormCell[] {
  const headerRow = grid.findIndex((row) => (row ?? []).some((c) => /^\s*description\s*$/i.test(c ?? '')));
  if (headerRow < 0) return [];
  const cols = (grid[headerRow] ?? []).flatMap((c, i) => (/^\s*description\s*$/i.test(c ?? '') ? [i] : []));
  const out: PoFormCell[] = [];
  cols.forEach((col, column) => {
    for (let r = headerRow + 1; r < grid.length; r++) {
      const text = (grid[r]?.[col] ?? '').toString();
      if (text.trim()) out.push({page, column, row: r, text});
    }
  });
  return out;
}
