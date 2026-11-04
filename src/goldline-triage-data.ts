import 'server-only';
import {nichidoConfigured, nichidoDb} from './nichido-client';
import {fetchAllRows} from './pos-fetch-paginate';
import {applyStoreRegistry, reconcileYears, segmentBundle, type ClassifiedPage, type FormGroup} from './goldline-segment';
import {diffExtractions, type DiffRow, type ExtractionDiff} from './goldline-dup-diff';
import {knownStoreCodes} from './goldline-store-registry';
import {uploadSource} from './goldline-upload-groups';
import type {FormVersion} from './goldline-extract';

// Phase 2 — the store-day triage board. Reads the Phase 0/1 classification that the
// upload route persisted on `uploads` (page_no, page_kind, orientation, form_version,
// classification jsonb, page_key), regroups the shuffled bundle into store · period ·
// version forms with the shared, tested `segmentBundle`, and shapes it for the board.
// Server-only, Nichido project. Mock fallback mirrors the real Sept scan so the board
// renders populated with the Supabase env unset.

/** One store-day form as the board shows it: identity + page coverage + flags + the
 *  per-page upload state so the card can link into review and show progress. */
export type TriageForm = {
  key: string;
  storeCode: string | null;
  storeName: string | null;
  consultant: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  version: FormVersion;
  present: number[];
  missing: number[];
  duplicates: Array<{page: number; count: number}>;
  flags: string[];
  uploadIds: string[];
  batchId: string | null;
  needsReview: number; // pages awaiting human review
  committed: number; // pages already committed
};

/** A page set aside by the bundle: the page-6 sales report or a blank back side. */
export type ParkedPage = {uploadId: string; filename: string; kind: 'sales' | 'blank' | 'unplaceable'};

export type TriageResult = {
  configured: boolean;
  forms: TriageForm[];
  parked: ParkedPage[];
  totals: {forms: number; inventoryPages: number; sales: number; blank: number; unplaceable: number};
  mock: boolean;
};

export type UploadClsRow = {
  id: string;
  filename: string;
  status: string;
  batch_id: string | null;
  page_no: number | null;
  page_kind: string | null;
  orientation: number | null;
  form_version: string | null;
  classification: Record<string, unknown> | null;
};

/** The `uploads` columns a classification mapping needs — the shared select string so
 *  the triage board and the batch split read the same shape. */
export const UPLOAD_CLS_COLS = 'id,filename,status,batch_id,page_no,page_kind,orientation,form_version,classification';

/** The consultant (BA) a page read, from its classification jsonb (null if absent). */
export function consultantOf(u: UploadClsRow): string | null {
  const c = (u.classification ?? {}) as Record<string, unknown>;
  return typeof c.consultant === 'string' && c.consultant.trim() !== '' ? c.consultant.trim() : null;
}

/** Map a persisted upload row to the ClassifiedPage shape `segmentBundle` consumes.
 *  Prefers the top-level classifier columns; store/period/consultant come from the
 *  classification jsonb (using the snapped store code the grouping was keyed on). */
export function toClassifiedPage(u: UploadClsRow): ClassifiedPage {
  const c = (u.classification ?? {}) as Record<string, unknown>;
  const snap = (c.store_snap ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
  return {
    id: u.id,
    page: typeof u.page_no === 'number' ? u.page_no : 0,
    kind: (u.page_kind as ClassifiedPage['kind']) ?? 'unknown',
    orientation: u.orientation === 180 ? 180 : 0,
    version: (u.form_version as FormVersion) ?? 'unknown',
    store_code: str(snap.code) ?? str(c.store_code),
    store_name: str(c.store_name),
    period_start: str(c.period_start),
    period_end: str(c.period_end),
    consultant: str(c.consultant),
    confidence: typeof c.confidence === 'number' ? c.confidence : 0,
  };
}

function toTriageForm(g: FormGroup, byId: Map<string, UploadClsRow>): TriageForm {
  const ids = g.slots.flatMap((s) => s.ids);
  const rows = ids.map((id) => byId.get(id)).filter((r): r is UploadClsRow => Boolean(r));
  const first = rows[0]?.classification as Record<string, unknown> | undefined;
  const batchIds = new Set(rows.map((r) => r.batch_id).filter(Boolean));
  return {
    key: g.key,
    storeCode: g.store_code,
    storeName: (first?.store_name as string) ?? null,
    consultant: (first?.consultant as string) ?? null,
    periodStart: g.period_start,
    periodEnd: g.period_end,
    version: g.version,
    present: g.present,
    missing: g.missing,
    duplicates: g.duplicates.map((d) => ({page: d.page, count: d.ids.length})),
    flags: g.flags,
    uploadIds: ids,
    batchId: batchIds.size === 1 ? [...batchIds][0] : null,
    needsReview: rows.filter((r) => r.status === 'needs_review').length,
    committed: rows.filter((r) => r.status === 'committed').length,
  };
}

/**
 * Build the triage board for a company from its classified inventory-PDF uploads.
 * With `source` given, scopes to one scan drop (every page whose filename shares that
 * source name) — the per-scan "forms found" view. The company-wide inbox omits it.
 */
export async function triageBoard(companyId: string, opts?: {source?: string}): Promise<TriageResult> {
  if (!nichidoConfigured()) return mockTriage();
  const supa = nichidoDb();
  const all = (await fetchAllRows('uploads', (from, to) =>
    supa
      .from('uploads')
      .select(UPLOAD_CLS_COLS)
      .eq('company_id', companyId)
      .eq('kind', 'inventory_pdf')
      .not('classified_at', 'is', null)
      .order('created_at', {ascending: false})
      .range(from, to),
  )) as unknown as UploadClsRow[];
  const rows = opts?.source ? all.filter((r) => uploadSource(r.filename) === opts.source) : all;

  const byId = new Map(rows.map((r) => [r.id, r]));
  // Re-snap store codes against the current registry, then reconcile OCR year noise
  // (the handwritten year is the noisiest field) to the bundle's dominant year before
  // grouping — so neither a drifted store code ("DS 5300") nor a misread year spins a
  // page off into its own fake form. Snapped pages are flagged on their form.
  const known = await knownStoreCodes(companyId);
  const {forms, sales, blanks, unplaceable} = segmentBundle(reconcileYears(applyStoreRegistry(rows.map(toClassifiedPage), known)));

  const parked: ParkedPage[] = [
    ...sales.map((p) => ({uploadId: p.id, filename: byId.get(p.id)?.filename ?? '', kind: 'sales' as const})),
    ...blanks.map((p) => ({uploadId: p.id, filename: byId.get(p.id)?.filename ?? '', kind: 'blank' as const})),
    ...unplaceable.map((p) => ({uploadId: p.id, filename: byId.get(p.id)?.filename ?? '', kind: 'unplaceable' as const})),
  ];
  const inventoryPages = forms.reduce((n, g) => n + g.slots.reduce((m, s) => m + s.ids.length, 0), 0);

  return {
    configured: true,
    forms: forms.map((g) => toTriageForm(g, byId)),
    parked,
    totals: {forms: forms.length, inventoryPages, sales: sales.length, blank: blanks.length, unplaceable: unplaceable.length},
    mock: false,
  };
}

/** A prior upload of the same page, with the row-level diff against the current one. */
export type DuplicateMatch = {
  uploadId: string;
  filename: string;
  status: string;
  createdAt: string;
  committed: boolean;
  diff: ExtractionDiff | null; // null if either side has no extraction to compare
};

/**
 * Phase 2 — for an upload that shares a page_key with earlier uploads (a re-upload or
 * an in-bundle duplicate), return the most recent prior one plus a diff of its extracted
 * counts against this upload's. Flag-only: the reviewer decides which to keep. Empty
 * when the upload has no page_key or no prior match.
 */
export async function duplicateMatchFor(companyId: string, uploadId: string): Promise<DuplicateMatch | null> {
  if (!nichidoConfigured()) return null;
  const supa = nichidoDb();
  const self = await supa.from('uploads').select('page_key').eq('company_id', companyId).eq('id', uploadId).maybeSingle();
  if (self.error) throw new Error(`uploads read failed: ${self.error.message}`);
  const pageKey = (self.data as {page_key: string | null} | null)?.page_key ?? null;
  if (!pageKey) return null;

  const priors = await supa
    .from('uploads')
    .select('id,filename,status,created_at')
    .eq('company_id', companyId)
    .eq('page_key', pageKey)
    .neq('id', uploadId)
    .order('created_at', {ascending: false})
    .limit(1);
  if (priors.error) throw new Error(`uploads duplicate read failed: ${priors.error.message}`);
  const prior = (priors.data ?? [])[0] as {id: string; filename: string; status: string; created_at: string} | undefined;
  if (!prior) return null;

  const [curExt, priorExt] = await Promise.all([
    readRows(supa, companyId, uploadId),
    readRows(supa, companyId, prior.id),
  ]);
  const diff = curExt && priorExt ? diffExtractions(curExt, priorExt) : null;

  return {
    uploadId: prior.id,
    filename: prior.filename,
    status: prior.status,
    createdAt: prior.created_at,
    committed: prior.status === 'committed',
    diff,
  };
}

/** The extraction rows (for the diff) of one upload, or null if none staged. */
async function readRows(
  supa: ReturnType<typeof nichidoDb>,
  companyId: string,
  uploadId: string,
): Promise<DiffRow[] | null> {
  const res = await supa
    .from('extractions')
    .select('rows')
    .eq('company_id', companyId)
    .eq('upload_id', uploadId)
    .order('page', {ascending: true})
    .limit(1)
    .maybeSingle();
  if (res.error) throw new Error(`extractions read failed: ${res.error.message}`);
  const rows = (res.data as {rows?: {rows?: DiffRow[]}} | null)?.rows?.rows;
  return Array.isArray(rows) ? rows : null;
}

// ── Mock: the real Sept bundle, so the board renders populated with no DB ───────────
function mockTriage(): TriageResult {
  const f = (p: Partial<TriageForm> & Pick<TriageForm, 'storeCode' | 'consultant' | 'version' | 'periodStart' | 'periodEnd'>): TriageForm => ({
    key: `${p.storeCode}|${p.periodStart}|${p.version}`,
    storeName: null,
    present: [1, 2, 3, 4, 5],
    missing: [],
    duplicates: [],
    flags: [],
    uploadIds: [],
    batchId: null,
    needsReview: 5,
    committed: 0,
    ...p,
  });
  const forms: TriageForm[] = [
    f({storeCode: '473', storeName: 'Watsons SM San Pablo', consultant: 'Leonisa Ramos', version: 'legacy',
      periodStart: '2026-09-01', periodEnd: '2026-09-15', missing: [], flags: [], needsReview: 5}),
    f({storeCode: null, storeName: 'Robinsons dept store', consultant: 'Alyza Mae Beral', version: 'v1',
      periodStart: '2026-09-01', periodEnd: '2026-09-15', flags: ['unknown-store'], needsReview: 5}),
    f({storeCode: '854', storeName: 'Gaisano Mall Davao', consultant: 'Vanessa Diamante', version: 'v1',
      periodStart: '2026-09-01', periodEnd: '2026-09-15', duplicates: [{page: 2, count: 2}], flags: ['duplicate-pages'], needsReview: 5}),
    f({storeCode: '473', storeName: 'Watsons SM San Pablo', consultant: 'Leonisa Ramos', version: 'v2',
      periodStart: '2026-09-16', periodEnd: '2026-09-30', present: [1, 2, 4, 5], missing: [3], flags: ['incomplete', 'store-corrected'], needsReview: 4}),
    f({storeCode: '5300', storeName: 'SM Sta Rosa', consultant: 'Ma. Sofia Lucero', version: 'v1',
      periodStart: '2026-09-09', periodEnd: '2026-09-15', flags: ['period-mismatch', 'period-partial'], needsReview: 5}),
    f({storeCode: '473', storeName: 'Watsons SM San Pablo', consultant: 'Leonisa Ramos', version: 'v2',
      periodStart: '2026-10-01', periodEnd: '2026-10-15', flags: ['store-corrected'], needsReview: 2, committed: 3}),
    // A page whose misread year (2020) was reconciled to 2026, so it groups with its
    // real cut-off and carries the year-auto-corrected flag.
    f({storeCode: '2166', storeName: 'Gaisano Mall Digos', consultant: 'Rhea Mae Bermil', version: 'v1',
      periodStart: '2026-09-01', periodEnd: '2026-09-15', present: [5], missing: [1, 2, 3, 4], flags: ['incomplete', 'year-reconciled'], needsReview: 1}),
    // A page whose period couldn't be read at all — always last.
    f({storeCode: null, storeName: null, consultant: 'Unknown', version: 'unknown',
      periodStart: null, periodEnd: null, present: [3], missing: [1, 2, 4, 5], flags: ['period-missing', 'unknown-store', 'unknown-version'], needsReview: 1}),
  ];
  return {
    configured: false,
    forms,
    parked: [
      {uploadId: 'm-s1', filename: 'Scan p3 (sales report).pdf', kind: 'sales'},
      {uploadId: 'm-s2', filename: 'Scan p6 (sales report).pdf', kind: 'sales'},
      {uploadId: 'm-b1', filename: 'Scan p45 (blank back).pdf', kind: 'blank'},
    ],
    totals: {forms: forms.length, inventoryPages: 29, sales: 2, blank: 1, unplaceable: 0},
    mock: true,
  };
}
