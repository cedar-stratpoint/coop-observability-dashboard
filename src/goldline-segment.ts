// Goldline Phase 0 — turn a shuffled, multi-store, multi-version bundle of classified
// scan pages into ordered `{store · period · version · page}` form groups, with
// duplicate pages, missing pages, parked sales pages, and anomaly flags surfaced.
//
// PURE (no network, no SDK, no DB) so it unit-tests. The live per-page classifier
// (Claude Vision) lives in goldline-extract-run.ts and feeds its output here. The
// extractor is still V1/V2-shaped; this module only sorts and flags — version-aware
// extraction is Phase 1.

import {FORM_VERSIONS, INVENTORY_PAGES, PAGE_KINDS, type FormVersion, type PageKind} from './goldline-extract';

/** One page as read by the classifier (before any extraction). Mirrors
 *  PAGE_CLASSIFY_SCHEMA; see sanitizeClassification for the defensive parse. */
export type PageClassification = {
  page: number; // 0–6 (0 = no printed page number)
  kind: PageKind;
  orientation: 0 | 180;
  version: FormVersion;
  store_code: string | null;
  store_name?: string | null;
  period_start: string | null;
  period_end: string | null;
  consultant: string | null;
  confidence: number;
};

/** A classified page tagged with its upload id, so groups can name exact pages. */
export type ClassifiedPage = PageClassification & {id: string};

/** All the ids seen for one inventory page number within a form (length > 1 = dup). */
export type PageSlot = {page: number; ids: string[]};

/** One store+period+version form, assembled from its scattered pages. */
export type FormGroup = {
  key: string;
  store_code: string | null;
  period_start: string | null;
  period_end: string | null;
  version: FormVersion;
  /** Inventory pages 1–5 present in this form, each with the id(s) seen. */
  slots: PageSlot[];
  present: number[]; // inventory page numbers present (1–5)
  missing: number[]; // inventory pages 1–5 not present
  duplicates: PageSlot[]; // slots whose ids.length > 1
  salesIds: string[]; // page-6 sales report pages, parked (out of scope)
  blankIds: string[]; // bleed-through / blank pages, dropped
  flags: string[]; // see FORM_FLAGS below
};

/** Stable flag strings a FormGroup can carry (surfaced on the triage board). */
export const FORM_FLAGS = {
  duplicatePages: 'duplicate-pages',
  incomplete: 'incomplete',
  unknownVersion: 'unknown-version',
  unknownStore: 'unknown-store',
  periodMissing: 'period-missing',
  periodUnparsed: 'period-unparsed',
  periodInvalidDay: 'period-invalid-day',
  periodPartial: 'period-partial',
} as const;

const KIND_SET = new Set<string>(PAGE_KINDS);
const VERSION_SET = new Set<string>(FORM_VERSIONS);

/** Coerce a raw model `version` to a known value; anything else → 'unknown'. */
export function normalizeVersion(raw: unknown): FormVersion {
  return typeof raw === 'string' && VERSION_SET.has(raw) ? (raw as FormVersion) : 'unknown';
}

/** Coerce a raw model `kind` to a known value; anything else → 'unknown'. */
export function normalizeKind(raw: unknown): PageKind {
  return typeof raw === 'string' && KIND_SET.has(raw) ? (raw as PageKind) : 'unknown';
}

/** Only 0 or 180 — the scanner produced upright and upside-down pages; a 90°/270°
 *  reading (shouldn't happen for these forms) is treated as upright (0). */
export function normalizeOrientation(raw: unknown): 0 | 180 {
  return raw === 180 || raw === '180' ? 180 : 0;
}

/** Clamp a page number to 0–6 (0 = unrecognized). */
export function clampPage(raw: unknown): number {
  const n = typeof raw === 'number' ? Math.trunc(raw) : Number.parseInt(String(raw ?? ''), 10);
  return Number.isFinite(n) && n >= 0 && n <= 6 ? n : 0;
}

/** Defensive parse of a raw classifier response into a PageClassification. Never
 *  throws: unknown/empty fields become null or 'unknown' so a bad read can still be
 *  grouped (and flagged) rather than crashing the batch. */
export function sanitizeClassification(raw: unknown): PageClassification {
  const r = (raw ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
  const conf = typeof r.confidence === 'number' && Number.isFinite(r.confidence) ? Math.min(1, Math.max(0, r.confidence)) : 0;
  return {
    page: clampPage(r.page),
    kind: normalizeKind(r.kind),
    orientation: normalizeOrientation(r.orientation),
    version: normalizeVersion(r.version),
    store_code: normalizeStoreCode(str(r.store_code)),
    store_name: str(r.store_name),
    period_start: str(r.period_start),
    period_end: str(r.period_end),
    consultant: str(r.consultant),
    confidence: conf,
  };
}

/** Normalize a store code for keying: trim, collapse inner spaces, drop a leading
 *  '#'. Kept as a string ('473', '5300'); null stays null. */
export function normalizeStoreCode(raw: string | null): string | null {
  if (!raw) return null;
  const s = raw.replace(/^#/, '').replace(/\s+/g, ' ').trim();
  return s === '' ? null : s;
}

/** A stable period string for keying. Keeps the actual dates — a partial "9–15" is
 *  NOT collapsed into "1–15" (that would hide a real anomaly and create false dups). */
export function canonicalPeriod(start: string | null, end: string | null): string {
  if (!start && !end) return 'unknown-period';
  return `${start ?? '?'}..${end ?? '?'}`;
}

function parseYmd(s: string | null): {y: number; m: number; d: number} | null {
  if (!s) return null;
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1) return null;
  return {y, m: mo, d};
}

function daysInMonth(y: number, m: number): number {
  return new Date(y, m, 0).getDate();
}

/** Anomaly flags for a period, best-effort. Empty for a clean standard cut-off
 *  (1st–15th or 16th–end). Does not mutate the dates; Phase 3 decides what to do. */
export function periodFlags(start: string | null, end: string | null): string[] {
  if (!start || !end) return [FORM_FLAGS.periodMissing];
  const s = parseYmd(start);
  const e = parseYmd(end);
  if (!s || !e) return [FORM_FLAGS.periodUnparsed];
  const flags: string[] = [];
  // Day written beyond the month's length (e.g. "Sept 16–31" — Sep has 30 days).
  if (e.d > daysInMonth(e.y, e.m)) flags.push(FORM_FLAGS.periodInvalidDay);
  // A cut-off should start on the 1st or the 16th; anything else is a partial.
  if (s.d !== 1 && s.d !== 16) flags.push(FORM_FLAGS.periodPartial);
  return flags;
}

/** The key identifying one FORM (its five pages share it): store · period · version. */
export function formKey(c: Pick<PageClassification, 'store_code' | 'period_start' | 'period_end' | 'version'>): string {
  return [c.store_code ?? 'unknown-store', canonicalPeriod(c.period_start, c.period_end), c.version].join('|');
}

/** The key identifying one PAGE within a form: form key · page number. Two pages
 *  sharing this are duplicates of the same {store · period · version · page}. */
export function pageKey(c: Pick<PageClassification, 'store_code' | 'period_start' | 'period_end' | 'version' | 'page'>): string {
  return `${formKey(c)}|p${c.page}`;
}

/**
 * Sort classified pages into form groups. Inventory pages are bucketed by page
 * number (duplicates surfaced); the page-6 sales report is parked; blanks are set
 * aside. Each group reports present/missing inventory pages and anomaly flags.
 */
export function groupIntoForms(pages: ClassifiedPage[]): FormGroup[] {
  const groups = new Map<string, FormGroup>();

  const ensure = (c: ClassifiedPage): FormGroup => {
    const key = formKey(c);
    let g = groups.get(key);
    if (!g) {
      g = {
        key,
        store_code: c.store_code,
        period_start: c.period_start,
        period_end: c.period_end,
        version: c.version,
        slots: [],
        present: [],
        missing: [],
        duplicates: [],
        salesIds: [],
        blankIds: [],
        flags: [],
      };
      groups.set(key, g);
    }
    return g;
  };

  for (const c of pages) {
    const g = ensure(c);
    if (c.kind === 'sales' || c.page === 6) {
      g.salesIds.push(c.id);
      continue;
    }
    if (c.kind === 'blank') {
      g.blankIds.push(c.id);
      continue;
    }
    // Inventory (or unknown-but-numbered) page. Only 1–5 are real item pages.
    if (c.page >= 1 && c.page <= 5) {
      const slot = g.slots.find((s) => s.page === c.page);
      if (slot) slot.ids.push(c.id);
      else g.slots.push({page: c.page, ids: [c.id]});
    } else {
      // No usable page number — park as blank so it surfaces for manual assignment.
      g.blankIds.push(c.id);
    }
  }

  for (const g of groups.values()) {
    g.slots.sort((a, b) => a.page - b.page);
    g.present = g.slots.map((s) => s.page);
    g.missing = INVENTORY_PAGES.filter((p) => !g.present.includes(p));
    g.duplicates = g.slots.filter((s) => s.ids.length > 1);
    g.flags = formFlagsFor(g);
  }

  return [...groups.values()].sort((a, b) => a.key.localeCompare(b.key));
}

function formFlagsFor(g: FormGroup): string[] {
  const flags: string[] = [];
  if (g.duplicates.length > 0) flags.push(FORM_FLAGS.duplicatePages);
  if (g.missing.length > 0) flags.push(FORM_FLAGS.incomplete);
  if (g.version === 'unknown') flags.push(FORM_FLAGS.unknownVersion);
  if (!g.store_code) flags.push(FORM_FLAGS.unknownStore);
  for (const f of periodFlags(g.period_start, g.period_end)) flags.push(f);
  return flags;
}

/** Flat list of every duplicated page across the whole bundle (intra-bundle dup
 *  flag): same {store · period · version · page} seen more than once. */
export function duplicatePages(pages: ClassifiedPage[]): Array<{key: string; page: number; ids: string[]}> {
  const byKey = new Map<string, {page: number; ids: string[]}>();
  for (const c of pages) {
    if (c.page < 1 || c.page > 5) continue; // only real inventory pages can collide meaningfully
    const k = pageKey(c);
    const e = byKey.get(k);
    if (e) e.ids.push(c.id);
    else byKey.set(k, {page: c.page, ids: [c.id]});
  }
  return [...byKey.entries()]
    .filter(([, v]) => v.ids.length > 1)
    .map(([key, v]) => ({key, page: v.page, ids: v.ids}));
}
