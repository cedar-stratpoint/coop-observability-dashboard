import 'server-only';
import {unstable_cache} from 'next/cache';
import {nichidoDb} from './nichido-client';
import {fetchAllRows} from './pos-fetch-paginate';
import {glTags} from './goldline-ref-data';

// Phase 0 — the known store registry, so an OCR'd store code off a scan can be
// snapped to a real store before pages are grouped (validation showed codes like
// "473" are misread as "472" at high confidence, which over-splits a form). Pure
// snapping/edit-distance logic is in goldline-segment.ts; this is only the read.

/** All store codes for a company (every chain), as strings, for snapStoreCode().
 *  Cached (store registry changes rarely; store writes revalidate glTags.stores) so the
 *  read pipeline and triage board don't re-query it on every page/navigation. */
export async function knownStoreCodes(companyId: string): Promise<string[]> {
  return unstable_cache(
    async () => {
      const supa = nichidoDb();
      const rows = (await fetchAllRows('stores', (from, to) =>
        supa.from('stores').select('store_code').eq('company_id', companyId).order('store_code').range(from, to),
      )) as unknown as Array<{store_code: string}>;
      return rows.map((r) => r.store_code).filter((c): c is string => typeof c === 'string' && c !== '');
    },
    ['gl-store-codes', companyId],
    {tags: [glTags.stores(companyId)], revalidate: 300},
  )();
}
