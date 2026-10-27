'use server';

import {revalidatePath, revalidateTag} from 'next/cache';
import {auth} from '@/auth';
import {getDataContext} from '@/src/active-context';
import {canEditData} from '@/src/company';
import {glTags} from '@/src/goldline-ref-data';
import {runChecks} from '@/src/goldline-checks-data';
import {dismissSuggestion, linkSku, LinkError, saveReview, unlinkSku} from '@/src/goldline-sku-links-data';

// Actions behind the Watsons SKU links screen. Links decide which sales count for which
// item across every store, so only a role that sees every store may change them. Every
// decision is recorded with who made it and an optional remark (latest only).

export type LinkActionResult = {ok: true} | {ok: false; error: string};

const SKU = /^[0-9A-Za-z-]{1,40}$/;
const ITEM = /^.{1,80}$/;
const REMARK_MAX = 500;

type Base = {company: string | null; sku: string; remark?: string | null};

const remarkOf = (r: string | null | undefined) => (r ?? '').trim().slice(0, REMARK_MAX) || null;

async function actor(): Promise<string | null> {
  const u = (await auth())?.user;
  return u?.name?.trim() || u?.email || null;
}

async function linkerContext(company: string | null) {
  const ctx = await getDataContext(company);
  if (!ctx || !ctx.companyId) return {error: 'Not authorized for this company.'} as const;
  if (!canEditData(ctx.role)) return {error: 'Your role can’t change SKU links.'} as const;
  if (Array.isArray(ctx.storeScope)) return {error: 'Only someone who sees every store can change SKU links.'} as const;
  return {companyId: ctx.companyId} as const;
}

function refresh(companyId: string) {
  revalidateTag(glTags.catalog(companyId), {expire: 0});
  revalidatePath('/stock', 'layout');
  revalidatePath('/overview');
  revalidatePath('/flags');
}

async function run(company: string | null, fn: (companyId: string) => Promise<unknown>, opts: {recheck?: boolean} = {}): Promise<LinkActionResult> {
  const c = await linkerContext(company);
  if ('error' in c) return {ok: false, error: c.error as string};
  try {
    await fn(c.companyId);
    // A link decides which sales count for an item, so the form vs. sales checks follow it.
    if (opts.recheck !== false) await runChecks(c.companyId).catch((e) => console.error('runChecks after SKU link change', e));
    refresh(c.companyId);
    return {ok: true};
  } catch (e) {
    if (e instanceof LinkError) return {ok: false, error: e.message};
    console.error('sku link action failed', e);
    return {ok: false, error: 'Couldn’t save that. Please try again.'};
  }
}

/** Approve Coop's suggestion: link the SKU to the item it suggested. */
export async function approveSuggestionAction(input: Base & {item: string}): Promise<LinkActionResult> {
  if (!SKU.test(input.sku ?? '') || !ITEM.test(input.item ?? '')) return {ok: false, error: 'Pick a Watsons SKU and an item.'};
  const by = await actor();
  return run(input.company, async (companyId) => {
    await linkSku(companyId, input.sku, input.item);
    await saveReview(companyId, input.sku, {action: 'approved', itemCode: input.item, remark: remarkOf(input.remark), by});
  });
}

/** Reject Coop's suggestion: it is never offered again, and the next best is looked for. */
export async function rejectSuggestionAction(input: Base & {item: string}): Promise<LinkActionResult> {
  if (!SKU.test(input.sku ?? '') || !ITEM.test(input.item ?? '')) return {ok: false, error: 'Pick a Watsons SKU.'};
  const by = await actor();
  // Turning one down can auto-link a strong next match, so the checks still re-run.
  return run(input.company, async (companyId) => {
    const rejected = await dismissSuggestion(companyId, input.sku, input.item);
    await saveReview(companyId, input.sku, {action: 'rejected', itemCode: rejected, remark: remarkOf(input.remark), by});
  });
}

/** Link a SKU to an item picked by hand. */
export async function linkSkuAction(input: Base & {item: string}): Promise<LinkActionResult> {
  if (!SKU.test(input.sku ?? '') || !ITEM.test(input.item ?? '')) return {ok: false, error: 'Pick a Watsons SKU and an item.'};
  const by = await actor();
  return run(input.company, async (companyId) => {
    await linkSku(companyId, input.sku, input.item);
    await saveReview(companyId, input.sku, {action: 'linked', itemCode: input.item, remark: remarkOf(input.remark), by});
  });
}

/** Undo a link. The pair is remembered as turned down so matching won't redo it. */
export async function unlinkSkuAction(input: Base): Promise<LinkActionResult> {
  if (!SKU.test(input.sku ?? '')) return {ok: false, error: 'Pick a Watsons SKU.'};
  const by = await actor();
  return run(input.company, async (companyId) => {
    const item = await unlinkSku(companyId, input.sku);
    await saveReview(companyId, input.sku, {action: 'unlinked', itemCode: item, remark: remarkOf(input.remark), by});
  });
}

/** Save a remark on its own (replaces the last one). */
export async function saveRemarkAction(input: Base): Promise<LinkActionResult> {
  if (!SKU.test(input.sku ?? '')) return {ok: false, error: 'Pick a Watsons SKU.'};
  const remark = remarkOf(input.remark);
  if (!remark) return {ok: false, error: 'Write a remark first.'};
  const by = await actor();
  return run(input.company, (companyId) => saveReview(companyId, input.sku, {action: null, remark, by}), {recheck: false});
}
