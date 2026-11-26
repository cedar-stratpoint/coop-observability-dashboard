import 'server-only';
import {nichidoConfigured, nichidoDb} from './nichido-client';
import type {FlagInput, MarkKind, MarkSource, MarkStatus, ReviewMark} from './goldline-review-marks';
import {readerMarksFor, type ReaderMark} from './goldline-reader-marks';
import {readMarksEnabled} from './goldline-anchored-flag';
import {bandNote, cleanBands, type PaperBand} from './band-prices';

// Reads and writes for review marks (NICH-42). Nichido project, service role, scoped by
// company on every call. The actions (app/uploads/review-marks-actions.ts) check the role
// and the page before calling these. No DB configured: nothing to read, writes refuse.

type Row = {
  id: string;
  upload_id: string;
  item_code: string | null;
  row_index: number | null;
  kind: MarkKind;
  source: MarkSource;
  reason: string | null;
  status: MarkStatus;
  created_by: string | null;
  created_at: string;
  cleared_by: string | null;
  cleared_at: string | null;
};

const COLS = 'id,upload_id,item_code,row_index,kind,source,reason,status,created_by,created_at,cleared_by,cleared_at';

const toMark = (r: Row): ReviewMark => ({
  id: r.id,
  uploadId: r.upload_id,
  itemCode: r.item_code,
  rowIndex: r.row_index,
  kind: r.kind,
  source: r.source,
  reason: r.reason,
  status: r.status,
  createdBy: r.created_by,
  createdAt: r.created_at,
  clearedBy: r.cleared_by,
  clearedAt: r.cleared_at,
});

/** Every mark (open and cleared) on these pages. A review shows at most a few hundred pages. */
export async function marksForUploads(companyId: string, uploadIds: string[]): Promise<ReviewMark[]> {
  if (!nichidoConfigured() || !uploadIds.length) return [];
  const out: ReviewMark[] = [];
  // Chunked: a long id list would overflow the request URL. A page carries a few marks, so
  // each chunk stays far under the 1000-row cap. pagination-ok
  for (let i = 0; i < uploadIds.length; i += 100) {
    const res = await nichidoDb().from('review_marks').select(COLS).eq('company_id', companyId).in('upload_id', uploadIds.slice(i, i + 100)).order('created_at').limit(1000);
    if (res.error) throw new Error(`review_marks read failed: ${res.error.message}`);
    out.push(...((res.data ?? []) as unknown as Row[]).map(toMark));
  }
  return out;
}

/** Add or reopen a reviewer's mark. */
export async function saveReviewerMark(companyId: string, input: FlagInput, by: string | null): Promise<ReviewMark> {
  if (!nichidoConfigured()) throw new Error('The database is not connected.');
  const res = await nichidoDb().rpc('review_mark_upsert', {
    p_company: companyId,
    p_upload: input.uploadId,
    p_item: input.itemCode ?? '',
    p_row: input.rowIndex,
    p_kind: input.kind,
    p_source: 'reviewer',
    p_reason: input.reason ?? '',
    p_by: by,
  });
  if (res.error) throw new Error(`review_mark_upsert failed: ${res.error.message}`);
  const row = (Array.isArray(res.data) ? res.data[0] : res.data) as Row | null;
  if (!row) throw new Error('review_mark_upsert returned nothing');
  return toMark(row);
}

/** Clear a mark (kept, with who and when). Returns the page it was on, or null when not this company's. */
export async function clearMark(companyId: string, id: string, by: string | null): Promise<ReviewMark | null> {
  if (!nichidoConfigured()) throw new Error('The database is not connected.');
  const res = await nichidoDb()
    .from('review_marks')
    .update({status: 'cleared', cleared_by: by, cleared_at: new Date().toISOString(), updated_at: new Date().toISOString()})
    .eq('company_id', companyId)
    .eq('id', id)
    .select(COLS)
    .maybeSingle();
  if (res.error) throw new Error(`review_marks clear failed: ${res.error.message}`);
  return res.data ? toMark(res.data as unknown as Row) : null;
}

/** Reopen a cleared mark (the hub's Undo). Returns null when it is not this company's. */
export async function reopenMark(companyId: string, id: string): Promise<ReviewMark | null> {
  if (!nichidoConfigured()) throw new Error('The database is not connected.');
  const res = await nichidoDb()
    .from('review_marks')
    .update({status: 'open', cleared_by: null, cleared_at: null, updated_at: new Date().toISOString()})
    .eq('company_id', companyId)
    .eq('id', id)
    .select(COLS)
    .maybeSingle();
  if (res.error) throw new Error(`review_marks reopen failed: ${res.error.message}`);
  return res.data ? toMark(res.data as unknown as Row) : null;
}

/** The pages several marks are on, keyed by mark id (only this company's). */
export async function marksUploads(companyId: string, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!nichidoConfigured() || !ids.length) return out;
  for (let i = 0; i < ids.length; i += 100) {
    const res = await nichidoDb().from('review_marks').select('id,upload_id').eq('company_id', companyId).in('id', ids.slice(i, i + 100)); // pagination-ok: ≤100 ids, one row each
    if (res.error) throw new Error(`review_marks read failed: ${res.error.message}`);
    for (const r of (res.data ?? []) as Array<{id: string; upload_id: string}>) out.set(r.id, r.upload_id);
  }
  return out;
}

/** Clear or reopen several marks at once (the hub's "Clear all" and its Undo). */
export async function setMarksStatus(companyId: string, ids: string[], open: boolean, by: string | null): Promise<number> {
  if (!nichidoConfigured()) throw new Error('The database is not connected.');
  const now = new Date().toISOString();
  let n = 0;
  for (let i = 0; i < ids.length; i += 100) {
    const res = await nichidoDb()
      .from('review_marks') // pagination-ok: an update of ≤100 ids, ids returned
      .update(open ? {status: 'open', cleared_by: null, cleared_at: null, updated_at: now} : {status: 'cleared', cleared_by: by, cleared_at: now, updated_at: now})
      .eq('company_id', companyId)
      .in('id', ids.slice(i, i + 100))
      .select('id');
    if (res.error) throw new Error(`review_marks update failed: ${res.error.message}`);
    n += (res.data ?? []).length;
  }
  return n;
}

/** The page a mark is on, for the scope check before clearing. */
export async function markUpload(companyId: string, id: string): Promise<string | null> {
  if (!nichidoConfigured()) return null;
  const res = await nichidoDb().from('review_marks').select('upload_id').eq('company_id', companyId).eq('id', id).maybeSingle();
  if (res.error) throw new Error(`review_marks read failed: ${res.error.message}`);
  return (res.data as {upload_id: string} | null)?.upload_id ?? null;
}

/**
 * Replace a page's reader-set flags with what its latest read saw (NICH-36). A re-read starts
 * fresh; reviewer flags are never touched. Flags cleared by a reviewer come back if the new read
 * still sees them (a new read is new evidence).
 */
export async function replaceReaderMarks(companyId: string, uploadId: string, marks: ReaderMark[]): Promise<number> {
  if (!nichidoConfigured()) return 0;
  // Band price marks have their own sync (always on), so a reader-flags pass leaves them be.
  const del = await nichidoDb().from('review_marks').delete().eq('company_id', companyId).eq('upload_id', uploadId).eq('source', 'reader').neq('kind', 'price');
  if (del.error) throw new Error(`review_marks reader clear failed: ${del.error.message}`);
  if (!marks.length) return 0;
  const ins = await nichidoDb()
    .from('review_marks')
    .insert(marks.map((m) => ({company_id: companyId, upload_id: uploadId, item_code: m.itemCode, row_index: m.rowIndex, kind: m.kind, source: 'reader', created_by: 'reader'})));
  if (ins.error) throw new Error(`review_marks reader write failed: ${ins.error.message}`);
  return marks.length;
}

/** The "Price written" marks a read page carries: one per band whose paper points at another
 *  price than the printed one, on the band's first row, with the prices as the reason. */
export function bandMarksFor(page: {rows: Array<{item_code: string}>; bands?: unknown}): Array<{itemCode: string; rowIndex: number; reason: string; open: boolean}> {
  const out: Array<{itemCode: string; rowIndex: number; reason: string; open: boolean}> = [];
  const seen = new Set<string>();
  for (const b of cleanBands(page.bands)) {
    if (b.kind == null) continue;
    const code = page.rows[b.first_index ?? -1]?.item_code?.trim();
    if (!code || seen.has(code)) continue;
    seen.add(code);
    out.push({itemCode: code, rowIndex: b.first_index as number, reason: bandNote(b), open: b.use_price == null});
  }
  return out;
}

/** Replace a page's band price marks with what its latest read saw. Always on (it is Coop's own
 *  check of the paper, not a reader option). Never fails the read. */
export async function syncBandMarks(companyId: string, uploadId: string, page: {rows: Array<{item_code: string}>; bands?: PaperBand[] | null} | null | undefined): Promise<void> {
  if (!nichidoConfigured() || !page || !Array.isArray(page.rows)) return;
  try {
    const del = await nichidoDb().from('review_marks').delete().eq('company_id', companyId).eq('upload_id', uploadId).eq('source', 'reader').eq('kind', 'price');
    if (del.error) throw new Error(del.error.message);
    const marks = bandMarksFor(page);
    if (!marks.length) return;
    const ins = await nichidoDb()
      .from('review_marks')
      .insert(marks.map((m) => ({company_id: companyId, upload_id: uploadId, item_code: m.itemCode, row_index: m.rowIndex, kind: 'price', source: 'reader', reason: m.reason, status: m.open ? 'open' : 'cleared', created_by: 'reader'})));
    if (ins.error) throw new Error(ins.error.message);
  } catch (e) {
    console.error('band price flags skipped', uploadId, e instanceof Error ? e.message : e);
  }
}

/** Open or clear a band's price mark when the reviewer picks (or takes back) its price. */
export async function setBandMarkStatus(companyId: string, uploadId: string, itemCode: string, open: boolean, by: string | null): Promise<void> {
  if (!nichidoConfigured()) return;
  const now = new Date().toISOString();
  const res = await nichidoDb()
    .from('review_marks') // pagination-ok: an update of one page's one mark, no rows returned
    .update(open ? {status: 'open', cleared_by: null, cleared_at: null, updated_at: now} : {status: 'cleared', cleared_by: by, cleared_at: now, updated_at: now})
    .eq('company_id', companyId)
    .eq('upload_id', uploadId)
    .eq('kind', 'price')
    .eq('source', 'reader')
    .eq('item_code', itemCode);
  if (res.error) throw new Error(`review_marks price update failed: ${res.error.message}`);
}

/** Write a read page's reader flags when GOLDLINE_READ_MARKS is on, and its band price flags
 *  always. Never fails the read. */
export async function syncReaderMarks(companyId: string, uploadId: string, page: (Parameters<typeof readerMarksFor>[0] & {bands?: PaperBand[] | null}) | null | undefined): Promise<void> {
  await syncBandMarks(companyId, uploadId, page);
  if (!readMarksEnabled() || !page || !Array.isArray(page.rows)) return;
  try {
    await replaceReaderMarks(companyId, uploadId, readerMarksFor(page));
  } catch (e) {
    console.error('reader review flags skipped', uploadId, e instanceof Error ? e.message : e);
  }
}
