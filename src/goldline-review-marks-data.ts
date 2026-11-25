import 'server-only';
import {nichidoConfigured, nichidoDb} from './nichido-client';
import type {FlagInput, MarkKind, MarkSource, MarkStatus, ReviewMark} from './goldline-review-marks';
import {readerMarksFor, type ReaderMark} from './goldline-reader-marks';
import {readMarksEnabled} from './goldline-anchored-flag';

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
  const del = await nichidoDb().from('review_marks').delete().eq('company_id', companyId).eq('upload_id', uploadId).eq('source', 'reader');
  if (del.error) throw new Error(`review_marks reader clear failed: ${del.error.message}`);
  if (!marks.length) return 0;
  const ins = await nichidoDb()
    .from('review_marks')
    .insert(marks.map((m) => ({company_id: companyId, upload_id: uploadId, item_code: m.itemCode, row_index: m.rowIndex, kind: m.kind, source: 'reader', created_by: 'reader'})));
  if (ins.error) throw new Error(`review_marks reader write failed: ${ins.error.message}`);
  return marks.length;
}

/** Write a read page's reader flags when GOLDLINE_READ_MARKS is on. Never fails the read. */
export async function syncReaderMarks(companyId: string, uploadId: string, page: Parameters<typeof readerMarksFor>[0] | null | undefined): Promise<void> {
  if (!readMarksEnabled() || !page || !Array.isArray(page.rows)) return;
  try {
    await replaceReaderMarks(companyId, uploadId, readerMarksFor(page));
  } catch (e) {
    console.error('reader review flags skipped', uploadId, e instanceof Error ? e.message : e);
  }
}
