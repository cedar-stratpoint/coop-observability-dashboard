// Pure rules for an upload batch — one store's inventory form for one period, uploaded
// together (unit-tested). Used by the uploader (what's in / missing) and the batch
// review ("Commit all pages" readiness).

export const FORM_PAGES = [1, 2, 3, 4, 5] as const;
// Pages per drop. One store's form is 5 pages, but Justin may scan many stores into one
// PDF (Q25, Oct 26: "whatever is easiest"); those are split into one form each after
// reading (groupForms), so a drop can hold about 50 forms.
export const MAX_BATCH_FILES = 250;
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

// ── Many stores in one scan ─────────────────────────────────────────────────────────

/** Where a split page sat in its scan: "stack (page 7 of 25).pdf" → {source: "stack", index: 7}. */
export function scanPosition(filename: string): {source: string; index: number} | null {
  const m = /^(.*) \(page (\d+) of \d+\)\.pdf$/i.exec(filename);
  return m ? {source: m[1], index: Number(m[2])} : null;
}

/**
 * Scan order for a batch's pages: pages split from the same PDF by their position in
 * it, files in the order they were uploaded otherwise.
 */
export function scanOrder<T extends {filename: string; created_at: string}>(pages: T[]): T[] {
  const firstSeen = new Map<string, string>();
  for (const p of pages) {
    const key = scanPosition(p.filename)?.source ?? `\u0000${p.filename}|${p.created_at}`;
    const prev = firstSeen.get(key);
    if (!prev || p.created_at < prev) firstSeen.set(key, p.created_at);
  }
  const keyOf = (p: T) => scanPosition(p.filename)?.source ?? `\u0000${p.filename}|${p.created_at}`;
  return [...pages].sort((a, b) => {
    const ka = keyOf(a);
    const kb = keyOf(b);
    if (ka !== kb) return firstSeen.get(ka)!.localeCompare(firstSeen.get(kb)!) || ka.localeCompare(kb);
    return (scanPosition(a.filename)?.index ?? 0) - (scanPosition(b.filename)?.index ?? 0) || a.created_at.localeCompare(b.created_at);
  });
}

/**
 * Split pages (in scan order) into forms: a new form starts whenever the form's page
 * number drops (…4, 5, 1, 2…). A page scanned twice in a row stays in its form, where
 * the review asks to remove the copy. Pages the reader couldn't number stay with the
 * form they sit in.
 */
export function groupForms<T extends {page: number | null}>(ordered: T[]): T[][] {
  const forms: T[][] = [];
  let last: number | null = null;
  for (const p of ordered) {
    if (!forms.length || (p.page != null && last != null && p.page < last)) {
      forms.push([]);
      last = null;
    }
    forms[forms.length - 1].push(p);
    if (p.page != null) last = p.page;
  }
  return forms;
}
