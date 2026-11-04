import 'server-only';
import {nichidoDb} from './nichido-client';
import {fetchAllRows} from './pos-fetch-paginate';

// Phase 0 — the known store registry, so an OCR'd store code off a scan can be
// snapped to a real store before pages are grouped (validation showed codes like
// "473" are misread as "472" at high confidence, which over-splits a form). Pure
// snapping/edit-distance logic is in goldline-segment.ts; this is only the read.

/** All store codes for a company (every chain), as strings, for snapStoreCode().
 *  Paginated like the other Goldline readers. */
export async function knownStoreCodes(companyId: string): Promise<string[]> {
  const supa = nichidoDb();
  const rows = (await fetchAllRows('stores', (from, to) =>
    supa.from('stores').select('store_code').eq('company_id', companyId).order('store_code').range(from, to),
  )) as unknown as Array<{store_code: string}>;
  return rows.map((r) => r.store_code).filter((c): c is string => typeof c === 'string' && c !== '');
}
