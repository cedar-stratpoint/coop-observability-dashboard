// Pure rules for an upload batch — one store's inventory form for one period, uploaded
// together (unit-tested). Used by the uploader (what's in / missing) and the batch
// review ("Commit all pages" readiness).

export const FORM_PAGES = [1, 2, 3, 4, 5] as const;
export const MAX_BATCH_FILES = 20;
export const MAX_FILE_BYTES = 25 * 1024 * 1024;

export type BatchPageInfo = {uploadId: string; page: number | null; flagged: number; resolved: number; status: string};

/** Pages in form order (unknown page last), then by upload order. */
export function orderPages<T extends {page: number | null}>(pages: T[]): T[] {
  return [...pages].sort((a, b) => (a.page ?? 99) - (b.page ?? 99));
}

/** Which form pages are in, which are missing, and which appear more than once. */
export function batchCoverage(pages: Array<{page: number | null}>): {have: number[]; missing: number[]; duplicates: number[]} {
  const counts = new Map<number, number>();
  for (const p of pages) if (p.page != null) counts.set(p.page, (counts.get(p.page) ?? 0) + 1);
  const have = FORM_PAGES.filter((n) => counts.has(n));
  return {
    have,
    missing: FORM_PAGES.filter((n) => !counts.has(n)),
    duplicates: [...counts.entries()].filter(([, c]) => c > 1).map(([n]) => n).sort((a, b) => a - b),
  };
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Whether "Commit all pages" can run, and if not, the one most useful reason —
 * so the button can say exactly what's left to do.
 */
export function batchReadiness(input: {
  storeCode: string;
  periodStart: string;
  periodEnd: string;
  pages: BatchPageInfo[];
}): {ready: true} | {ready: false; reason: string} {
  const {pages} = input;
  const reviewable = pages.filter((p) => p.status === 'needs_review');
  if (!reviewable.length) return {ready: false, reason: 'No pages are ready to commit yet.'};
  if (pages.some((p) => p.status === 'processing')) return {ready: false, reason: 'Wait for every page to finish reading.'};
  const dup = batchCoverage(reviewable).duplicates;
  if (dup.length) return {ready: false, reason: `Page ${dup.join(', ')} was uploaded twice. Remove the extra copy.`};
  if (!input.storeCode.trim()) return {ready: false, reason: 'Enter the store code.'};
  if (!ISO.test(input.periodStart) || !ISO.test(input.periodEnd)) return {ready: false, reason: 'Enter the period this count covers.'};
  if (input.periodStart > input.periodEnd) return {ready: false, reason: 'The period end must be on or after its start.'};
  const open = reviewable.reduce((n, p) => n + Math.max(0, p.flagged - p.resolved), 0);
  if (open) return {ready: false, reason: `Resolve ${open} flagged ${open === 1 ? 'row' : 'rows'} first.`};
  return {ready: true};
}

/** "store-a.pdf" → "store-a (page 2 of 5).pdf" for pages split out of a multi-page PDF. */
export function splitName(original: string, index: number, total: number): string {
  const dot = original.toLowerCase().endsWith('.pdf') ? original.length - 4 : original.length;
  return `${original.slice(0, dot)} (page ${index + 1} of ${total}).pdf`;
}
