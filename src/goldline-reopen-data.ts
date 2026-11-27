import 'server-only';
import {nichidoConfigured, nichidoDb} from './nichido-client';
import {fetchAllRows} from './pos-fetch-paginate';
import {getExtraction, getUpload} from './goldline-data';
import {committedCodes, restoreCommitted, type CommittedRow} from './goldline-reopen';

// Reopen for review (Nov 27): server reads + the one write. Every query is fenced by company_id
// (the service-role key bypasses RLS). Plan: knowledge/tasks/2026-11-27-reopen-flare-band-wording.md.

const db = nichidoDb;
const COLS = 'item_code,store_code,period_start,period_end,consultant,stockroom,drawer,selling_area,delivery,ending_on_hand,extra';

/** The counts a page is still the source of. */
export async function committedRowsFor(companyId: string, uploadId: string): Promise<CommittedRow[]> {
  if (!nichidoConfigured()) return [];
  return (await fetchAllRows('inventory', (from, to) =>
    db().from('inventory').select(COLS).eq('company_id', companyId).eq('source_upload_id', uploadId).order('id').range(from, to), // pagination-ok: paged by fetchAllRows (.range below)
  )) as unknown as CommittedRow[];
}

/** Codes of this page whose count for its store and period now comes from another page. */
async function keptElsewhereFor(companyId: string, uploadId: string, head: CommittedRow | undefined, codes: string[]): Promise<string[]> {
  if (!head || !codes.length) return [];
  const out = new Set<string>();
  for (let i = 0; i < codes.length; i += 200) {
    const res = await db()
      .from('inventory') // pagination-ok: ≤200 codes for one store and period, one row each
      .select('item_code,source_upload_id')
      .eq('company_id', companyId)
      .eq('store_code', head.store_code)
      .eq('period_start', head.period_start)
      .eq('period_end', head.period_end)
      .in('item_code', codes.slice(i, i + 200));
    if (res.error) throw new Error(`inventory read failed: ${res.error.message}`);
    for (const r of (res.data ?? []) as Array<{item_code: string; source_upload_id: string | null}>) if (r.source_upload_id !== uploadId) out.add(r.item_code);
  }
  return [...out].sort();
}

/** Coop's checks that came from this page and are still open or resolved (withdrawn by a reopen). */
async function checksFrom(companyId: string, uploadId: string): Promise<number> {
  const res = await db()
    .from('flags') // pagination-ok: a head count, no rows returned
    .select('id', {count: 'exact', head: true})
    .eq('company_id', companyId)
    .eq('source_upload_id', uploadId)
    .neq('status', 'withdrawn');
  if (res.error) throw new Error(`flags count failed: ${res.error.message}`);
  return res.count ?? 0;
}

export type ReopenImpact = {
  page: number | null;
  /** Counts that leave Inventory. */
  counts: number;
  store: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  /** Codes whose Inventory count now comes from another page (they stay). */
  keptElsewhere: string[];
  /** Coop's checks from this page that would stop counting against the BA. */
  checks: number;
};

/** What a reopen would change, for the confirmation. Null when the page isn't a committed scan. */
export async function reopenImpact(companyId: string, uploadId: string): Promise<ReopenImpact | null> {
  const upload = await getUpload(companyId, uploadId);
  if (!upload || upload.kind !== 'inventory_pdf' || upload.status !== 'committed') return null;
  const [ex, committed, checks] = await Promise.all([getExtraction(companyId, uploadId), committedRowsFor(companyId, uploadId), checksFrom(companyId, uploadId)]);
  const head = committed[0];
  const codes = ex?.data ? committedCodes(ex.data, upload.form_version, ex.page).filter((c) => !committed.some((r) => r.item_code === c)) : [];
  return {
    page: ex?.page ?? null,
    counts: committed.length,
    store: head?.store_code ?? null,
    periodStart: head?.period_start ?? null,
    periodEnd: head?.period_end ?? null,
    keptElsewhere: await keptElsewhereFor(companyId, uploadId, head, codes),
    checks,
  };
}

export class ReopenStateError extends Error {
  constructor(public reason: 'not_found' | 'not_committed' | 'no_read') {
    super(`reopen: ${reason}`);
  }
}

/** Reopen a committed page: restore its read from its committed counts, then (one transaction)
 *  take the counts out of Inventory and put the page back in review. Returns the store the counts
 *  were in (for the checks) and how many counts left. */
export async function reopenUpload(companyId: string, uploadId: string, by: string | null): Promise<{store: string | null; removed: number}> {
  const upload = await getUpload(companyId, uploadId);
  if (!upload || upload.kind !== 'inventory_pdf') throw new ReopenStateError('not_found');
  if (upload.status !== 'committed') throw new ReopenStateError('not_committed');
  const ex = await getExtraction(companyId, uploadId);
  if (!ex?.data || !Array.isArray(ex.data.rows)) throw new ReopenStateError('no_read');
  const committed = await committedRowsFor(companyId, uploadId);
  const head = committed[0];
  const missing = committedCodes(ex.data, upload.form_version, ex.page).filter((c) => !committed.some((r) => r.item_code === c));
  const keptElsewhere = await keptElsewhereFor(companyId, uploadId, head, missing);
  const {page} = restoreCommitted(ex.data, committed, {version: upload.form_version, pageNo: ex.page, at: new Date().toISOString(), by, keptElsewhere});
  const {data, error} = await db().rpc('reopen_upload', {p_company: companyId, p_upload: uploadId, p_page: page});
  if (error) {
    const msg = error.message ?? '';
    if (msg.includes('upload_not_committed')) throw new ReopenStateError('not_committed');
    if (msg.includes('upload_not_found')) throw new ReopenStateError('not_found');
    throw new Error(`reopen_upload failed: ${msg}`);
  }
  return {store: head?.store_code ?? null, removed: typeof data === 'number' ? data : 0};
}
