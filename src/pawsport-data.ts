import 'server-only';
import {cache} from 'react';
import {unstable_cache} from 'next/cache';
import {createCrmClient} from './chat/crm/client';
import {resolveCrmAccess} from './chat/crm/config';
import {CRM_TAG} from './crm-cache';
import {loadPawsportHolders, type PawsportHolder, type PawsportRead} from './pawsport';
import {usingPosMock} from './pos-data';

/**
 * PawSport holders (RET-18 P1, D1 = A): read from Shopify through the CRM's read-only GraphQL door (/api/shopify/query, the
 * READ-scoped token, server-side only), reusing Ask Coop's CRM client. Cached 10 minutes and tagged CRM_TAG, so the Website CRM's
 * Refresh re-reads it. A failed read throws inside the cache (unstable_cache stores only results), so it is not pinned for 10
 * minutes, and the caller gets status 'unavailable': never an empty "ok".
 *
 * No CRM env: mock holders in full mock mode (no POS env either), else 'unavailable' (real leads must never show made-up passports).
 */
const PAWSPORT_REVALIDATE = 600;

const MOCK_HOLDERS: PawsportHolder[] = [
  {shopifyCustomerId: 'gid://shopify/Customer/9000001', email: 'mia@example.com', phone: '9171234567', number: 'ZMY26-MOCK-0001', issuedAt: '2026-11-12T03:00:00Z', pet: {name: 'Mimi', type: 'cat'}, route: 'qr'},
  {shopifyCustomerId: 'gid://shopify/Customer/9000002', email: 'leo@example.com', phone: null, number: 'ZMY26-MOCK-0002', issuedAt: '2026-11-15T03:00:00Z', pet: {name: 'Bruno', type: 'dog'}, route: 'form'},
];

export const getPawsportHolders = cache(async (): Promise<PawsportRead> => {
  const access = resolveCrmAccess(process.env);
  if (!access.enabled) {
    return usingPosMock() ? {status: 'ok', holders: MOCK_HOLDERS, warnings: ['Mock PawSport holders (no CRM env).']} : {status: 'unavailable', holders: [], warnings: [`CRM ${access.reason}`]};
  }
  try {
    return await holdersCached();
  } catch (err) {
    console.warn(`PawSport read failed: ${(err as Error).message}`); // a CrmError message is its code only, never the URL or token
    return {status: 'unavailable', holders: [], warnings: ['Shopify could not be read through the CRM.']};
  }
});

// No arguments: they would become part of the cache key, and the token must never be stored there.
const holdersCached = unstable_cache(
  (): Promise<PawsportRead> => {
    const access = resolveCrmAccess(process.env);
    if (!access.enabled) throw new Error(`CRM ${access.reason}`);
    return loadPawsportHolders(async (body) => {
      // One client per page: the client caps Shopify POSTs per chat turn (3), and this walk is not a chat turn.
      const client = createCrmClient({baseUrl: access.baseUrl, token: access.token, fetch});
      return (await client.postShopify(body)).body;
    });
  },
  ['pawsport-holders'],
  {revalidate: PAWSPORT_REVALIDATE, tags: [CRM_TAG]},
);
