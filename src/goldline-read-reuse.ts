import 'server-only';
import {createHash} from 'node:crypto';
import {nichidoDb} from './nichido-client';
import {EXTRACT_MODEL} from './goldline-extract';
import {readReuseKey} from './goldline-read-reuse-key';

// QA fix 9: the same page uploaded twice gave different confidence and notes. The reader model
// takes no temperature setting, so its self-rated confidence and wording drift run to run (QA's
// Nov 24 upload of San Pablo p.7 matched Nov 23 on every count but moved ~5 points on 46 rows).
// A read records the file's SHA-256 and the reader that read it; a new upload of the identical
// file read by the same deploy copies that read instead of reading again (same result, no read
// cost). A re-read always reads fresh, and a new deploy changes the reader, so a reader change is
// always measured rather than served from an older read.

const db = nichidoDb;

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Who read a page: the model plus the deployed code version. Null off Vercel (local dev), where
 *  code changes without a commit, so a local read is never reused. */
export function readerSignature(): string | null {
  return readReuseKey(EXTRACT_MODEL, process.env.VERCEL_GIT_COMMIT_SHA);
}

/** Record the page file's fingerprint (always) and, once its read is saved, the reader. */
export async function stampFingerprint(uploadId: string, patch: {sha?: string; readerSig?: string | null}): Promise<void> {
  const upd: Record<string, unknown> = {};
  if (patch.sha) upd.content_sha256 = patch.sha;
  if (patch.readerSig !== undefined) upd.reader_sig = patch.readerSig;
  if (!Object.keys(upd).length) return;
  const res = await db().from('uploads').update(upd).eq('id', uploadId);
  if (res.error) console.error('goldline read: fingerprint update failed', res.error.message);
}

type Prior = {
  id: string;
  status: string;
  page_no: number | null;
  page_kind: string | null;
  orientation: number | null;
  form_version: string | null;
  page_key: string | null;
  classification: unknown;
  page_count: number | null;
};

/**
 * Copy the latest read of an identical file (same company, same SHA-256, same reader) onto this
 * upload: its classification and its saved read. Only reads that reached review (needs_review or
 * committed) are reused. Returns the copied read's summary, or null when there is none.
 */
export async function reuseIdenticalRead(
  companyId: string,
  uploadId: string,
  sha: string,
  readerSig: string,
): Promise<{fromId: string; page: number; rows: unknown; docConfidence: number | null; formVersion: string | null; orientation: number | null; classification: unknown} | null> {
  const supa = db();
  const found = await supa
    .from('uploads')
    .select('id,status,page_no,page_kind,orientation,form_version,page_key,classification,page_count')
    .eq('company_id', companyId)
    .eq('content_sha256', sha)
    .eq('reader_sig', readerSig)
    .neq('id', uploadId)
    .in('status', ['needs_review', 'committed'])
    .order('created_at', {ascending: false})
    .limit(1);
  if (found.error) throw new Error(`reuse lookup failed: ${found.error.message}`);
  const prior = (found.data?.[0] ?? null) as Prior | null;
  if (!prior) return null;
  const ex = await supa.from('extractions').select('page,rows,doc_confidence').eq('company_id', companyId).eq('upload_id', prior.id).maybeSingle();
  if (ex.error) throw new Error(`reuse extraction read failed: ${ex.error.message}`);
  if (!ex.data) return null;
  const upd = await supa
    .from('uploads')
    .update({
      page_no: prior.page_no,
      page_kind: prior.page_kind,
      orientation: prior.orientation,
      form_version: prior.form_version,
      page_key: prior.page_key,
      classification: prior.classification,
      classified_at: new Date().toISOString(),
      reader_sig: readerSig,
    })
    .eq('id', uploadId);
  if (upd.error) throw new Error(`reuse classification copy failed: ${upd.error.message}`);
  const ins = await supa.from('extractions').upsert(
    {company_id: companyId, upload_id: uploadId, page: ex.data.page, rows: ex.data.rows, doc_confidence: ex.data.doc_confidence, status: 'pending_review'},
    {onConflict: 'upload_id,page'},
  );
  if (ins.error) throw new Error(`reuse extraction copy failed: ${ins.error.message}`);
  return {
    fromId: prior.id,
    page: ex.data.page as number,
    rows: ex.data.rows,
    docConfidence: (ex.data.doc_confidence as number | null) ?? null,
    formVersion: prior.form_version,
    orientation: prior.orientation,
    classification: prior.classification,
  };
}
