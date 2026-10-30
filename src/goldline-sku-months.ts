// Watsons SKUs month by month (Oct 29), the pure half: which monthly Watsons files each
// SKU is in, and the file-by-file summary on SKU linking. Input is `sku_months()` (f2f):
// per SKU, [month, units, stores] for each month it appears in.

export type MonthCell = [month: string, units: number, stores: number];
export type SkuMonths = Record<string, MonthCell[]>;
export type Presence = {count: number; first: string; last: string; only: boolean};
export type MonthRow = {month: string; skus: number; firstSeen: number; lastSeen: number};
export type Spread = {label: string; skus: number; from: number; to: number};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "2025-12-01" → "Dec 2025". */
export const monthLabel = (iso: string) => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;

/** Every month in the files, oldest first. */
export function allMonths(data: SkuMonths): string[] {
  return [...new Set(Object.values(data).flatMap((cells) => cells.map((c) => String(c[0]).slice(0, 10))))].sort();
}

/** Where one SKU shows up: how many files, its first and last, and whether it is in only one. */
export function presence(cells: MonthCell[] | undefined): Presence | null {
  if (!cells?.length) return null;
  const ms = cells.map((c) => String(c[0]).slice(0, 10)).sort();
  return {count: ms.length, first: ms[0], last: ms[ms.length - 1], only: ms.length === 1};
}

/** "Only in Dec 2025" or "In 9 of 12 months". */
export function presenceText(p: Presence, total: number): string {
  return p.only ? `Only in ${monthLabel(p.first)}` : `In ${p.count} of ${total} months`;
}

/** Per file: SKUs in it, SKUs seen there for the first time, and for the last time. */
export function monthRows(data: SkuMonths): MonthRow[] {
  const months = allMonths(data);
  const rows = new Map(months.map((m) => [m, {month: m, skus: 0, firstSeen: 0, lastSeen: 0}]));
  for (const cells of Object.values(data)) {
    const p = presence(cells);
    if (!p) continue;
    for (const c of cells) rows.get(String(c[0]).slice(0, 10))!.skus++;
    rows.get(p.first)!.firstSeen++;
    rows.get(p.last)!.lastSeen++;
  }
  return [...rows.values()];
}

/** How many SKUs are in every file, most of them, some, or just one. */
export function spread(data: SkuMonths): Spread[] {
  const n = allMonths(data).length;
  const counts = Object.values(data).map((c) => presence(c)?.count ?? 0).filter(Boolean);
  const bucket = (label: string, from: number, to: number): Spread => ({label, from, to, skus: counts.filter((c) => c >= from && c <= to).length});
  if (n <= 1) return [bucket('Only 1 month', 1, 1)];
  const most = Math.max(2, n - 3);
  return [
    bucket(`All ${n} months`, n, n),
    ...(most <= n - 1 ? [bucket(`${most} to ${n - 1} months`, most, n - 1)] : []),
    ...(most > 2 ? [bucket(`2 to ${most - 1} months`, 2, most - 1)] : []),
    bucket('Only 1 month', 1, 1),
  ].filter((b) => b.from <= b.to);
}
