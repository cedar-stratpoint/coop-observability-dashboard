// Goldline POS sales CSV parser (P1). Pure + unit-tested.
//
// Turns a Nichido POS export into gl_sales-ready rows. The file is store × SKU ×
// period; its real columns (see the plan's source-file schema) are:
//   Location · Location Desc · SKU Code · SKU Desc · Gross Sales Retail TY ·
//   Sales Units TY · Sales Net of Vat Net of Discount
// The period isn't in the file — the caller attaches it from the upload context —
// so a parsed row carries everything except period_start/period_end.

export type PosSaleRow = {
  storeCode: string;
  storeName: string;
  skuCode: string;
  skuDesc: string;
  grossRetail: number | null;
  units: number | null;
  netOfVat: number | null;
};

export type ParseResult = {rows: PosSaleRow[]; errors: string[]};

// Header aliases → canonical field. Matching is case- and whitespace-insensitive.
const FIELD_ALIASES: Record<keyof PosSaleRow, string[]> = {
  storeCode: ['location'],
  storeName: ['location desc', 'location description'],
  skuCode: ['sku code'],
  skuDesc: ['sku desc', 'sku description'],
  grossRetail: ['gross sales retail ty', 'gross sales retail'],
  units: ['sales units ty', 'sales units'],
  netOfVat: ['sales net of vat net of discount', 'net of vat net of discount', 'net sales'],
};

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

/** Minimal RFC-4180-ish CSV: handles quoted fields, embedded commas, "" escapes, CRLF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  // flush trailing field/row if the file doesn't end in a newline
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}

function toNum(v: string): number | null {
  const t = v.trim().replace(/,/g, '');
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse a Nichido POS export. Returns the sale rows plus a list of human-readable
 * errors (missing required columns, or rows missing a store/SKU). Never throws.
 */
export function parseGoldlinePos(csvText: string): ParseResult {
  const grid = parseCsv(csvText);
  if (grid.length < 2) return {rows: [], errors: ['The file has no data rows.']};

  const header = grid[0].map(norm);
  const idx = {} as Record<keyof PosSaleRow, number>;
  const errors: string[] = [];
  (Object.keys(FIELD_ALIASES) as Array<keyof PosSaleRow>).forEach((field) => {
    const col = header.findIndex((h) => FIELD_ALIASES[field].includes(h));
    idx[field] = col;
    // storeName / skuDesc are nice-to-have; the rest are required.
    const required = !['storeName', 'skuDesc'].includes(field);
    if (col === -1 && required) errors.push(`Missing required column: ${FIELD_ALIASES[field][0]}`);
  });
  if (errors.length) return {rows: [], errors};

  const at = (r: string[], c: number) => (c >= 0 && c < r.length ? r[c] : '');
  const rows: PosSaleRow[] = [];
  for (let i = 1; i < grid.length; i++) {
    const r = grid[i];
    const storeCode = at(r, idx.storeCode).trim();
    const skuCode = at(r, idx.skuCode).trim();
    if (!storeCode || !skuCode) {
      errors.push(`Row ${i + 1}: missing store code or SKU code, skipped.`);
      continue;
    }
    rows.push({
      storeCode,
      storeName: at(r, idx.storeName).trim(),
      skuCode,
      skuDesc: at(r, idx.skuDesc).trim(),
      grossRetail: toNum(at(r, idx.grossRetail)),
      units: toNum(at(r, idx.units)),
      netOfVat: toNum(at(r, idx.netOfVat)),
    });
  }
  return {rows, errors};
}
