// CSV writing shared by the CRM page and the chat's contact tables. Pure.
// The rows carry customer-supplied text (emails, names, pet names): a cell that starts with = + - @ (or a tab or a carriage return)
// can run as a formula in Excel or Sheets, so it gets a leading quote.
export function csvCell(v: unknown): string {
  const raw = String(v ?? '');
  const safe = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  const escaped = safe.replace(/"/g, '""');
  return /[",\n]/.test(escaped) ? `"${escaped}"` : escaped;
}

export const toCsv = (rows: readonly (readonly unknown[])[]): string => rows.map((r) => r.map(csvCell).join(',')).join('\n');
