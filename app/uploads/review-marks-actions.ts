'use server';

import {auth} from '@/auth';
import {getDataContext} from '@/src/active-context';
import {canEditData, outOfScopeStores} from '@/src/company';
import {getUpload, uploadStores} from '@/src/goldline-data';
import {parseFlagInput, type ReviewMark} from '@/src/goldline-review-marks';
import {clearMark, markUpload, marksUploads, reopenMark, saveReviewerMark, setMarksStatus} from '@/src/goldline-review-marks-data';

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

/** Undo a clear (the Flags hub). Same checks as clearing. */
export async function reopenMarkAction(input: {company: string | null; id: string}): Promise<MarkResult> {
  const ctx = await getDataContext(input.company);
  if (!ctx || !ctx.companyId) return {ok: false, error: 'Not authorized for this company.'};
  if (!canEditData(ctx.role)) return {ok: false, error: 'Your role cannot change flags.'};
  const id = typeof input.id === 'string' ? input.id.trim() : '';
  if (!/^[0-9a-f-]{36}$/i.test(id)) return {ok: false, error: 'That flag could not be found.'};
  try {
    const uploadId = await markUpload(ctx.companyId, id);
    if (!uploadId) return {ok: false, error: 'That flag could not be found.'};
    const denied = await pageInScope(ctx.companyId, ctx.storeScope, uploadId);
    if (denied) return {ok: false, error: denied};
    const mark = await reopenMark(ctx.companyId, id);
    return mark ? {ok: true, mark} : {ok: false, error: 'That flag could not be found.'};
  } catch (e) {
    console.error('reopenMarkAction', e);
    return {ok: false, error: 'Couldn’t reopen the flag. Try again.'};
  }
}

export type MarksResult = {ok: true; count: number} | {ok: false; error: string};

const BULK_MAX = 1000;

/**
 * Clear (or, for Undo, reopen) several review marks at once: the Flags hub's "Clear all" on a
 * kind. Checks never pass through here. Every page the marks are on must be this company's and
 * inside a store-limited role's stores; one page outside refuses the whole set.
 */
export async function setMarksAction(input: {company: string | null; ids: string[]; open: boolean}): Promise<MarksResult> {
  const ctx = await getDataContext(input.company);
  if (!ctx || !ctx.companyId) return {ok: false, error: 'Not authorized for this company.'};
  if (!canEditData(ctx.role)) return {ok: false, error: 'Your role cannot clear flags.'};
  const ids = [...new Set((Array.isArray(input.ids) ? input.ids : []).filter((x): x is string => typeof x === 'string' && /^[0-9a-f-]{36}$/i.test(x)))];
  if (!ids.length) return {ok: false, error: 'Pick the flags first.'};
  if (ids.length > BULK_MAX) return {ok: false, error: `Clear at most ${BULK_MAX} flags at a time.`};
  try {
    const pages = await marksUploads(ctx.companyId, ids);
    if (pages.size !== ids.length) return {ok: false, error: 'Some of those flags could not be found. Reload the page.'};
    if (Array.isArray(ctx.storeScope)) {
      for (const uploadId of new Set(pages.values())) {
        const denied = await pageInScope(ctx.companyId, ctx.storeScope, uploadId);
        if (denied) return {ok: false, error: denied};
      }
    }
    const by = (await auth())?.user?.email ?? null;
    return {ok: true, count: await setMarksStatus(ctx.companyId, ids, input.open === true, by)};
  } catch (e) {
    console.error('setMarksAction', e);
    return {ok: false, error: 'Couldn’t update the flags. Try again.'};
  }
}
