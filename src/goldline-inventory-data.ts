import 'server-only';
import {createClient, type SupabaseClient} from '@supabase/supabase-js';
import {fetchAllRows} from './pos-fetch-paginate';
import {pageCoverage} from './goldline-inventory';

// Server-only reads for the Goldline Inventory page. Every query is filtered by the
// active company_id — the service-role key bypasses RLS, so that filter is the
// tenant fence. The page shows ONE store × form period at a time (≤ ~260 rows), so
// nothing here scans the whole inventory history; the pickers come from the
// gl_inventory_snapshots view.

const url = process.env.SUPABASE_URL_ARCHIVE;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY_ARCHIVE;

function db(): SupabaseClient {
  return createClient(url as string, key as string, {auth: {persistSession: false}});
}

export type InventorySource = {
  uploadId: string;
  filename: string;
  page: number | null;
  uploadedBy: string | null;
  createdAt: string;
};

export type CountSources = {
  latest: {period_start: string; period_end: string; consultant: string | null; last_committed_at: string | null} | null;
  sources: InventorySource[];
  missingPages: number[];
  pendingReview: number;
};

/**
 * What the Inventory board shows about a store's latest count: when, by whom, the
 * scans it was committed from (with their form pages) and pages not in yet — plus how
 * many scans are waiting for review. One store's latest count only (≤ a few hundred
 * rows), never the inventory history. `store` null = just the review count.
 */
export async function getCountSources(companyId: string, store: string | null, storeScope?: string[] | null): Promise<CountSources> {
  const empty: CountSources = {latest: null, sources: [], missingPages: [], pendingReview: 0};
  if (!url || !key) return empty;
  if (store && storeScope && !storeScope.includes(store)) store = null;
  const supa = db();
  if (!store) {
    // pagination-ok: count-only head request, returns no rows.
    const pending = await supa.from('gl_uploads').select('id', {count: 'exact', head: true}).eq('company_id', companyId).eq('status', 'needs_review');
    return {...empty, pendingReview: pending.count ?? 0};
  }
  // One round trip (gl_count_sources): latest count + its scans + the review count.
  const {data, error} = await supa.rpc('gl_count_sources', {p_company: companyId, p_store: store});
  if (error) throw new Error(`gl_count_sources failed: ${error.message}`);
  const r = (data ?? {}) as {
    pending?: number;
    latest?: CountSources['latest'];
    sources?: Array<{id: string; filename: string; uploaded_by: string | null; created_at: string; page: number | null}>;
  };
  const sources: InventorySource[] = (r.sources ?? []).map((u) => ({uploadId: u.id, filename: u.filename, page: u.page ?? null, uploadedBy: u.uploaded_by, createdAt: u.created_at}));
  return {
    latest: r.latest ?? null,
    sources,
    missingPages: r.latest ? pageCoverage(sources.map((s) => s.page)).missing : [],
    pendingReview: Number(r.pending ?? 0),
  };
}

/** Where a committed scan landed (store + period), for the review page's
 *  "View in Inventory" link. Null when the upload hasn't been committed. */
export async function committedSnapshotFor(
  companyId: string,
  uploadId: string,
): Promise<{store_code: string; period_start: string; period_end: string} | null> {
  if (!url || !key) return null;
  // pagination-ok: single row.
  const res = await db()
    .from('gl_inventory')
    .select('store_code,period_start,period_end')
    .eq('company_id', companyId)
    .eq('source_upload_id', uploadId)
    .limit(1)
    .maybeSingle();
  return (res.data as {store_code: string; period_start: string; period_end: string} | null) ?? null;
}
