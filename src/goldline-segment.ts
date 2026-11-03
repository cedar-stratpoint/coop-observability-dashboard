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

/** One store+period+version form, assembled from its scattered pages. Built from
 *  INVENTORY pages only — sales/blank/unplaceable pages are partitioned out by
 *  segmentBundle, so they never create a junk "unknown" form. */
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
  flags: string[]; // see FORM_FLAGS below
};

/** The whole bundle partitioned: inventory forms, plus the pages set aside. */
export type BundleSegmentation = {
  forms: FormGroup[];
  sales: ClassifiedPage[]; // page-6 sales reports, parked (out of scope)
  blanks: ClassifiedPage[]; // bleed-through / blank back sides, dropped
  unplaceable: ClassifiedPage[]; // looked like a form page but had no usable page number
};

/** True for a page that can be slotted into a form: an item page (1–5) that isn't a
 *  sales report or a blank. A 'unknown'-kind page with a good page number still
 *  counts (the model was unsure of the kind, not the page). */
export function isInventoryPage(c: Pick<PageClassification, 'kind' | 'page'>): boolean {
  return c.kind !== 'sales' && c.kind !== 'blank' && c.page >= 1 && c.page <= 5;
}

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
  periodMismatch: 'period-mismatch', // pages in one form reported different exact dates
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

/** A verbatim period string (actual dates) for display / exact comparison. */
export function canonicalPeriod(start: string | null, end: string | null): string {
  if (!start && !end) return 'unknown-period';
  return `${start ?? '?'}..${end ?? '?'}`;
}

/**
 * A period bucket for GROUPING: `YYYY-MM-H1|H2` (first half = starts before the
 * 16th, second half = 16th on). This is deliberately coarse so a one-digit date
 * misread or a genuine partial cut-off ("Sep 9–15") still lands in the right form
 * instead of splitting off its own group — validation showed handwritten dates are
 * misread often enough to over-split otherwise. The ACTUAL dates are preserved on
 * the group and still flagged (periodFlags); this only decides co-grouping.
 */
export function periodBucket(start: string | null, end: string | null): string {
  const base = parseYmd(start) ?? parseYmd(end);
  if (!base) return 'unknown-period';
  const half = base.d < 16 ? 'H1' : 'H2';
  return `${base.y}-${String(base.m).padStart(2, '0')}-${half}`;
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

/** The key identifying one FORM (its five pages share it): store · period-bucket ·
 *  version. Uses the coarse half-month bucket so date misreads don't over-split. */
export function formKey(c: Pick<PageClassification, 'store_code' | 'period_start' | 'period_end' | 'version'>): string {
  return [c.store_code ?? 'unknown-store', periodBucket(c.period_start, c.period_end), c.version].join('|');
}

/** The key identifying one PAGE within a form: form key · page number. Two pages
 *  sharing this are duplicates of the same {store · period · version · page}. */
export function pageKey(c: Pick<PageClassification, 'store_code' | 'period_start' | 'period_end' | 'version' | 'page'>): string {
  return `${formKey(c)}|p${c.page}`;
}

/**
 * Partition a whole bundle: group the INVENTORY pages into forms, and set aside the
 * sales reports, blanks, and any form-like page with no usable page number. Sales
 * and blank pages never create a form group (they carry no reliable store/period/
 * version), so a packet's parked pages can't masquerade as an "unknown" form.
 */
export function segmentBundle(pages: ClassifiedPage[]): BundleSegmentation {
  const sales: ClassifiedPage[] = [];
  const blanks: ClassifiedPage[] = [];
  const unplaceable: ClassifiedPage[] = [];
  const inventory: ClassifiedPage[] = [];

  for (const c of pages) {
    if (c.kind === 'sales' || c.page === 6) sales.push(c);
    else if (c.kind === 'blank') blanks.push(c);
    else if (isInventoryPage(c)) inventory.push(c);
    else unplaceable.push(c); // form-like but no usable page number → manual assign
  }

  return {forms: groupIntoForms(inventory), sales, blanks, unplaceable};
}

/**
 * Group INVENTORY pages into forms by {store · period · version}. Pass only item
 * pages (use segmentBundle to partition first). Each group reports present/missing
 * inventory pages, duplicates, and anomaly flags.
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
        flags: [],
      };
      groups.set(key, g);
    }
    return g;
  };

  // Distinct exact (start..end) reads seen across each form's member pages, so a
  // within-form date disagreement (one page misread) can be surfaced.
  const periodReads = new Map<string, Set<string>>();

  for (const c of pages) {
    if (!isInventoryPage(c)) continue; // defensive: only item pages form groups
    const g = ensure(c);
    const slot = g.slots.find((s) => s.page === c.page);
    if (slot) slot.ids.push(c.id);
    else g.slots.push({page: c.page, ids: [c.id]});
    if (c.period_start || c.period_end) {
      const set = periodReads.get(g.key) ?? new Set<string>();
      set.add(canonicalPeriod(c.period_start, c.period_end));
      periodReads.set(g.key, set);
    }
  }

  for (const g of groups.values()) {
    g.slots.sort((a, b) => a.page - b.page);
    g.present = g.slots.map((s) => s.page);
    g.missing = INVENTORY_PAGES.filter((p) => !g.present.includes(p));
    g.duplicates = g.slots.filter((s) => s.ids.length > 1);
    g.flags = formFlagsFor(g, (periodReads.get(g.key)?.size ?? 0) > 1);
  }

  return [...groups.values()].sort((a, b) => a.key.localeCompare(b.key));
}

function formFlagsFor(g: FormGroup, periodMismatch: boolean): string[] {
  const flags: string[] = [];
  if (g.duplicates.length > 0) flags.push(FORM_FLAGS.duplicatePages);
  if (g.missing.length > 0) flags.push(FORM_FLAGS.incomplete);
  if (g.version === 'unknown') flags.push(FORM_FLAGS.unknownVersion);
  if (!g.store_code) flags.push(FORM_FLAGS.unknownStore);
  if (periodMismatch) flags.push(FORM_FLAGS.periodMismatch);
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
