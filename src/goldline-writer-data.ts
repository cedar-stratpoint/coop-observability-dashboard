import 'server-only';
import {createClient, type SupabaseClient} from '@supabase/supabase-js';
import {fetchAllRows} from './pos-fetch-paginate';
import {GOLDLINE_BUCKET} from './goldline-data';
import {
  buildReferenceText,
  buildWriterNotes,
  diffUpload,
  pickReference,
  type Correction,
  type Counts,
  type ReaderStats,
  type ReferenceCandidate,
} from './goldline-writer';

// Builds the writer profile for one read from the CONNECTED database: the pages a
// person reviewed and committed here (Staging learns from Staging, prod from prod;
// nothing is baked into code). Reader output is kept in gl_extractions.rows and the
// confirmed values in gl_inventory (by source_upload_id), so every review is a
// labelled example with no extra writes. Any failure here returns an empty profile:
// the reader then works exactly as before, it never blocks an upload.

const url = process.env.SUPABASE_URL_ARCHIVE;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY_ARCHIVE;
let client: SupabaseClient | null = null;
const db = () => (client ??= createClient(url as string, key as string, {auth: {persistSession: false}}));

/** How many recent reviewed pages the profile looks at. */
const RECENT_PAGES = 40;
/** A reference scan bigger than this isn't worth sending (a phone photo saved as PDF). */
const MAX_REFERENCE_BYTES = 4_000_000;

export type WriterProfile = {
  reference: {uploadId: string; pdfBase64: string; text: string} | null;
  notes: string | null;
  stats: ReaderStats;
};

const EMPTY: WriterProfile = {reference: null, notes: null, stats: {pages: 0, cells: 0, corrected: 0}};
const COLS = 'item_code,store_code,stockroom,drawer,selling_area,delivery,ending_on_hand,source_upload_id';

/** One reviewed scan: what the reader read vs what the reviewer confirmed. */
type Reviewed = {uploadId: string; page: number; storeCode: string | null; createdAt: string; storagePath: string | null; profiled: boolean; reader: Counts[]; confirmed: Counts[]};

/** Recent reviewed scans per company, kept briefly in memory: a batch reads up to five
 *  pages at once and each would otherwise re-run the same three reads. */
const LEARN_TTL_MS = 60_000;
const learnCache = new Map<string, {at: number; value: Promise<Reviewed[]>}>();

/** Give up on the profile after this long: an upload must never wait on it. */
const PROFILE_TIMEOUT_MS = 8_000;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p, new Promise<T>((_, rej) => (t = setTimeout(() => rej(new Error(`${label} timed out`)), ms)))]).finally(() => clearTimeout(t));
}

function recentReviewed(companyId: string): Promise<Reviewed[]> {
  const hit = learnCache.get(companyId);
  if (hit && Date.now() - hit.at < LEARN_TTL_MS) return hit.value;
  const value = loadReviewed(companyId);
  learnCache.set(companyId, {at: Date.now(), value});
  value.catch(() => learnCache.delete(companyId)); // never cache a failure
  return value;
}

/** The company's recent committed scans with the reader's and the confirmed values. */
async function loadReviewed(companyId: string): Promise<Reviewed[]> {
  const ups = await db()
    .from('gl_uploads')
    .select('id,created_at,storage_path')
    .eq('company_id', companyId)
    .eq('kind', 'inventory_pdf')
    .eq('status', 'committed')
    .order('created_at', {ascending: false})
    .limit(RECENT_PAGES); // pagination-ok: bounded to the most recent RECENT_PAGES pages
  if (ups.error) throw new Error(`gl_uploads read failed: ${ups.error.message}`);
  const uploads = (ups.data ?? []) as {id: string; created_at: string; storage_path: string | null}[];
  if (!uploads.length) return [];
  const ids = uploads.map((u) => u.id);

  const [ext, inv] = await Promise.all([
    db().from('gl_extractions').select('upload_id,page,rows').eq('company_id', companyId).in('upload_id', ids).limit(RECENT_PAGES * 2), // pagination-ok: one row per upload, ≤ RECENT_PAGES uploads
    fetchAllRows('gl_inventory', (from, to) =>
      db().from('gl_inventory').select(COLS).eq('company_id', companyId).in('source_upload_id', ids).order('id').range(from, to),
    ),
  ]);
  if (ext.error) throw new Error(`gl_extractions read failed: ${ext.error.message}`);

  const confirmedBy = new Map<string, Counts[]>();
  const storeBy = new Map<string, string>();
  for (const r of inv as (Counts & {source_upload_id: string; store_code: string})[]) {
    const list = confirmedBy.get(r.source_upload_id) ?? [];
    list.push(r);
    confirmedBy.set(r.source_upload_id, list);
    storeBy.set(r.source_upload_id, r.store_code);
  }
  const extBy = new Map((ext.data ?? []).map((e) => [e.upload_id as string, e as {page: number; rows: {rows?: Counts[]; reader?: {profile?: boolean}} | null}]));

  const out: Reviewed[] = [];
  for (const u of uploads) {
    const e = extBy.get(u.id);
    const confirmed = confirmedBy.get(u.id);
    if (!e || !confirmed?.length || !Array.isArray(e.rows?.rows)) continue;
    out.push({
      uploadId: u.id,
      page: e.page,
      storeCode: storeBy.get(u.id) ?? null,
      createdAt: u.created_at,
      storagePath: u.storage_path,
      profiled: Boolean(e.rows.reader?.profile),
      reader: e.rows.rows,
      confirmed,
    });
  }
  return out;
}

/** Only the stores this user may see (store-scoped roles), so another store's scan is
 *  never sent as their reference nor counted in their stats. Null scope = all stores. */
const inScope = (r: Reviewed, storeScope: string[] | null | undefined) => !storeScope || (r.storeCode !== null && storeScope.includes(r.storeCode));

type Summary = {stats: ReaderStats; before: ReaderStats; after: ReaderStats; corrections: Correction[]; candidates: (ReferenceCandidate & {page: number; storagePath: string | null})[]};

function summarize(rows: Reviewed[]): Summary {
  const zero = (): ReaderStats => ({pages: 0, cells: 0, corrected: 0});
  const s: Summary = {stats: zero(), before: zero(), after: zero(), corrections: [], candidates: []};
  for (const r of rows) {
    const d = diffUpload(r.uploadId, r.reader, r.confirmed);
    for (const g of [s.stats, r.profiled ? s.after : s.before]) {
      g.pages++;
      g.cells += d.cells;
      g.corrected += d.corrections.length;
    }
    s.corrections.push(...d.corrections);
    s.candidates.push({uploadId: r.uploadId, storeCode: r.storeCode, createdAt: r.createdAt, cells: d.cells, page: r.page, storagePath: r.storagePath});
  }
  return s;
}

/**
 * The writer profile to send with a read of `page`: a confirmed reference scan of the
 * same page (same store preferred) and notes from past corrections. Empty when
 * nothing has been reviewed yet, on any error, or after PROFILE_TIMEOUT_MS.
 */
export async function getWriterProfile(companyId: string, page: number, storeCode: string | null, storeScope?: string[] | null): Promise<WriterProfile> {
  if (!url || !key || process.env.GL_WRITER_PROFILE === 'off') return EMPTY;
  try {
    return await withTimeout(buildProfile(companyId, page, storeCode, storeScope), PROFILE_TIMEOUT_MS, 'writer profile');
  } catch (e) {
    console.error('goldline writer profile: skipped', e instanceof Error ? e.message : e);
    return EMPTY;
  }
}

async function buildProfile(companyId: string, page: number, storeCode: string | null, storeScope?: string[] | null): Promise<WriterProfile> {
  const rows = (await recentReviewed(companyId)).filter((r) => inScope(r, storeScope));
  if (!rows.length) return EMPTY;
  const s = summarize(rows);
  const notes = buildWriterNotes(s.corrections, s.stats);
  const pick = pickReference(
    s.candidates.filter((c) => c.page === page && c.storagePath),
    storeCode,
  );
  let reference: WriterProfile['reference'] = null;
  if (pick) {
    const path = s.candidates.find((c) => c.uploadId === pick.uploadId)?.storagePath as string;
    const file = await db().storage.from(GOLDLINE_BUCKET).download(path);
    if (file.error) throw new Error(`reference download failed: ${file.error.message}`);
    const buf = Buffer.from(await file.data.arrayBuffer());
    if (buf.byteLength <= MAX_REFERENCE_BYTES) {
      const confirmed = rows.find((r) => r.uploadId === pick.uploadId)?.confirmed ?? [];
      reference = {uploadId: pick.uploadId, pdfBase64: buf.toString('base64'), text: buildReferenceText(page, confirmed)};
    }
  }
  return {reference, notes, stats: s.stats};
}

export type ReaderAccuracy = ReaderStats & {before: ReaderStats; after: ReaderStats};

/** Reader accuracy over the recent reviewed scans this user may see, split by whether
 *  the writer profile was used (for the Uploads page). Null when nothing is reviewed
 *  yet, on error, or if it's slow (the page never waits on it). */
export async function getReaderAccuracy(companyId: string, storeScope?: string[] | null): Promise<ReaderAccuracy | null> {
  if (!url || !key) return null;
  try {
    const rows = (await withTimeout(recentReviewed(companyId), PROFILE_TIMEOUT_MS, 'reader stats')).filter((r) => inScope(r, storeScope));
    const s = summarize(rows);
    return s.stats.cells ? {...s.stats, before: s.before, after: s.after} : null;
  } catch (e) {
    console.error('goldline reader stats failed', e instanceof Error ? e.message : e);
    return null;
  }
}
