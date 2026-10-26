'use server';

import {revalidatePath, revalidateTag} from 'next/cache';
import {getDataContext} from '@/src/active-context';
import {canEditData} from '@/src/company';
import {glTags} from '@/src/goldline-ref-data';
import {runChecks} from '@/src/goldline-checks-data';
import {dismissSuggestion, linkSku, LinkError, unlinkSku} from '@/src/goldline-sku-links-data';

// Actions behind the Watsons SKU links screen. Links decide which sales count for which
// item across every store, so only a role that sees every store may change them.

export type LinkActionResult = {ok: true} | {ok: false; error: string};

const SKU = /^[0-9A-Za-z-]{1,40}$/;
const ITEM = /^.{1,80}$/;

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

async function run(company: string | null, fn: (companyId: string) => Promise<void>): Promise<LinkActionResult> {
  const c = await linkerContext(company);
  if ('error' in c) return {ok: false, error: c.error as string};
  try {
    await fn(c.companyId);
    // A link decides which sales count for an item, so the form vs. sales checks follow it.
    await runChecks(c.companyId).catch((e) => console.error('runChecks after SKU link change', e));
    refresh(c.companyId);
    return {ok: true};
  } catch (e) {
    if (e instanceof LinkError) return {ok: false, error: e.message};
    console.error('sku link action failed', e);
    return {ok: false, error: 'Couldn’t save that. Please try again.'};
  }
}

export async function linkSkuAction(input: {company: string | null; sku: string; item: string}): Promise<LinkActionResult> {
  if (!SKU.test(input.sku ?? '') || !ITEM.test(input.item ?? '')) return {ok: false, error: 'Pick a Watsons SKU and an item.'};
  return run(input.company, (companyId) => linkSku(companyId, input.sku, input.item));
}

export async function dismissSuggestionAction(input: {company: string | null; sku: string}): Promise<LinkActionResult> {
  if (!SKU.test(input.sku ?? '')) return {ok: false, error: 'Pick a Watsons SKU.'};
  return run(input.company, (companyId) => dismissSuggestion(companyId, input.sku));
}

export async function unlinkSkuAction(input: {company: string | null; sku: string}): Promise<LinkActionResult> {
  if (!SKU.test(input.sku ?? '')) return {ok: false, error: 'Pick a Watsons SKU.'};
  return run(input.company, (companyId) => unlinkSku(companyId, input.sku));
}
