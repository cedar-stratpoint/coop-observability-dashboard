'use server';

import {revalidatePath, revalidateTag} from 'next/cache';
import {getDataContext} from '@/src/active-context';
import {canEditData} from '@/src/company';
import {glTags} from '@/src/goldline-ref-data';
import {setStoreScope, SupplyError} from '@/src/goldline-supply-writes';

// Store scope (F2, S2): automatic (sold in the last 3 loaded months) unless an admin
// switches a store always in or always out. Company-wide roles only.

export type ScopeResult = {ok: true} | {ok: false; error: string};

export async function setStoreScopeAction(input: {company: string | null; store: string; scope: 'auto' | 'in' | 'out'}): Promise<ScopeResult> {
  const ctx = await getDataContext(input.company);
  if (!ctx || !ctx.companyId) return {ok: false, error: 'Not authorized for this company.'};
  if (!canEditData(ctx.role)) return {ok: false, error: 'Your role can’t change store scope.'};
  if (ctx.storeScope) return {ok: false, error: 'Only company-wide roles can change store scope.'};
  if (!/^[A-Za-z0-9-]{1,20}$/.test(input.store ?? '')) return {ok: false, error: 'Store not found.'};
  if (!['auto', 'in', 'out'].includes(input.scope)) return {ok: false, error: 'Pick automatic, always in or always out.'};
  try {
    await setStoreScope(ctx.companyId, input.store, input.scope === 'auto' ? null : input.scope === 'in');
    revalidateTag(glTags.stores(ctx.companyId), {expire: 0});
    revalidatePath('/stores');
    return {ok: true};
  } catch (err) {
    if (err instanceof SupplyError) return {ok: false, error: 'Store not found.'};
    console.error('setStoreScopeAction', err);
    return {ok: false, error: 'Couldn’t save that. Please try again.'};
  }
}
