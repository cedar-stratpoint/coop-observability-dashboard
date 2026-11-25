'use server';

import {auth} from '@/auth';
import {getDataContext} from '@/src/active-context';
import {canEditData, outOfScopeStores} from '@/src/company';
import {getUpload, uploadStores} from '@/src/goldline-data';
import {parseFlagInput, type ReviewMark} from '@/src/goldline-review-marks';
import {clearMark, markUpload, saveReviewerMark} from '@/src/goldline-review-marks-data';

// The review page's Flag action (NICH-42): flag a row or the whole page, or clear a flag.
// Re-derives the tenant server-side, checks the role can edit, that the page is this
// company's and inside a store-limited role's stores. A flag never touches counts or the
// BA's score, so it works on a committed page too.

export type MarkResult = {ok: true; mark: ReviewMark} | {ok: false; error: string};

async function pageInScope(companyId: string, storeScope: string[] | null | undefined, uploadId: string): Promise<string | null> {
  const upload = await getUpload(companyId, uploadId);
  if (!upload) return 'That page could not be found.';
  if (Array.isArray(storeScope)) {
    const stores = await uploadStores(companyId, uploadId);
    if (outOfScopeStores(storeScope, stores).length) return 'That page is for a store outside your access.';
  }
  return null;
}

export async function flagAction(input: {company: string | null; flag: unknown}): Promise<MarkResult> {
  const ctx = await getDataContext(input.company);
  if (!ctx || !ctx.companyId) return {ok: false, error: 'Not authorized for this company.'};
  if (!canEditData(ctx.role)) return {ok: false, error: 'Your role cannot flag rows.'};
  const parsed = parseFlagInput(input.flag);
  if (!parsed.ok) return parsed;
  try {
    const denied = await pageInScope(ctx.companyId, ctx.storeScope, parsed.input.uploadId);
    if (denied) return {ok: false, error: denied};
    const by = (await auth())?.user?.email ?? null;
    return {ok: true, mark: await saveReviewerMark(ctx.companyId, parsed.input, by)};
  } catch (e) {
    console.error('flagAction', e);
    return {ok: false, error: 'Couldn’t save the flag. Try again.'};
  }
}

export async function clearMarkAction(input: {company: string | null; id: string}): Promise<MarkResult> {
  const ctx = await getDataContext(input.company);
  if (!ctx || !ctx.companyId) return {ok: false, error: 'Not authorized for this company.'};
  if (!canEditData(ctx.role)) return {ok: false, error: 'Your role cannot clear flags.'};
  const id = typeof input.id === 'string' ? input.id.trim() : '';
  if (!/^[0-9a-f-]{36}$/i.test(id)) return {ok: false, error: 'That flag could not be found.'};
  try {
    const uploadId = await markUpload(ctx.companyId, id);
    if (!uploadId) return {ok: false, error: 'That flag could not be found.'};
    const denied = await pageInScope(ctx.companyId, ctx.storeScope, uploadId);
    if (denied) return {ok: false, error: denied};
    const by = (await auth())?.user?.email ?? null;
    const mark = await clearMark(ctx.companyId, id, by);
    return mark ? {ok: true, mark} : {ok: false, error: 'That flag could not be found.'};
  } catch (e) {
    console.error('clearMarkAction', e);
    return {ok: false, error: 'Couldn’t clear the flag. Try again.'};
  }
}
