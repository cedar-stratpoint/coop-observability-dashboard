// Reading Shopee export cells, shared by every parser. Values arrive as text with thousands separators, dates are DD/MM/YYYY, a dash means "no value".
import ExcelJS from 'exceljs';

export const headerKey = (h: unknown): string => String(h ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

export const cellText = (v: ExcelJS.CellValue): string => {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return 'richText' in v ? v.richText.map((t) => t.text).join('') : 'result' in v ? String(v.result ?? '') : v instanceof Date ? v.toISOString() : String(v);
  return String(v);
};

/** "1,234.50", "₱5", "12.5%" to a number; "" and "-" to null. */
export const toNumber = (s: string): number | null => {
  const t = s.replace(/[,\s₱%]/g, '');
  if (t === '' || t === '-') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

/** DD/MM/YYYY (or an ISO date) to YYYY-MM-DD, or null when it is not a real calendar day. */
export function toIsoDay(raw: string): string | null {
  const t = raw.trim();
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t);
  const iso = m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : /^\d{4}-\d{2}-\d{2}$/.test(t) ? t : null;
  if (!iso) return null;
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso ? null : iso;
}

/** "21/09/2026-27/09/2026" or "21/09/2026 - 27/09/2026" to its two ISO days. */
export function toIsoRange(raw: string): {from: string; to: string} | null {
  const m = /^(\S+?)\s*-\s*(\S+)$/.exec(raw.trim());
  const from = m ? toIsoDay(m[1]) : null;
  const to = m ? toIsoDay(m[2]) : null;
  return from && to ? {from, to} : null;
}

/** "00:01:21" to seconds. */
export function toSeconds(raw: string): number | null {
  const m = /^(\d+):(\d{2}):(\d{2})$/.exec(raw.trim());
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
}

export async function loadWorkbook(bytes: ArrayBuffer | Uint8Array | Buffer, what: string): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(bytes as ExcelJS.Buffer);
  } catch {
    throw new Error(`This is not a ${what} workbook (it could not be read as .xlsx).`);
  }
  return wb;
}

export const sheetRows = (ws: ExcelJS.Worksheet): string[][] => {
  const rows: string[][] = [];
  ws.eachRow({includeEmpty: true}, (row) => rows.push((row.values as ExcelJS.CellValue[]).slice(1).map(cellText)));
  return rows;
};

/** The column index of each wanted header (by normalised name), -1 when missing. */
export const columnsOf = <T extends Record<string, string>>(header: string[], wanted: T): Record<keyof T, number> =>
  Object.fromEntries(Object.entries(wanted).map(([k, name]) => [k, header.map(headerKey).indexOf(name)])) as Record<keyof T, number>;
