'use server';

import {revalidatePath} from 'next/cache';
import {auth} from '@/auth';
import {getDataContext} from '@/src/active-context';
import {canEditData} from '@/src/company';
import {runChecks} from '@/src/goldline-checks-data';
import {addAdjustment, closeFlag, deleteAdjustment, FlagError, logLossFromFlag, reopenFlag, type AdjustmentReason} from '@/src/goldline-flags-writes';
import type {FlagCause} from '@/src/goldline-checks';

// Actions behind the flag queue and adjustments. Each re-derives the tenant context,
// re-checks write capability, and passes the role's store scope down so a store-scoped
// role can only touch its own stores.

export type FlagActionResult = {ok: true; note?: string} | {ok: false; error: string};

const UUID = /^[0-9a-f-]{36}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const CAUSES: FlagCause[] = ['human_error', 'unreadable', 'manipulation'];
const REASONS: AdjustmentReason[] = ['pull_out', 'damage', 'loss'];
const MAX_REMARK = 500;

async function editor(company: string | null) {
  const ctx = await getDataContext(company);
  if (!ctx || !ctx.companyId) return {error: 'Not authorized for this company.'} as const;
  if (!canEditData(ctx.role)) return {error: 'Your role can’t change flags.'} as const;
  if (Array.isArray(ctx.storeScope) && ctx.storeScope.length === 0) return {error: 'No stores are assigned to your role.'} as const;
  const session = await auth();
  return {companyId: ctx.companyId, scope: ctx.storeScope ?? null, by: session?.user?.email ?? null} as const;
}

async function run(company: string | null, fn: (e: {companyId: string; scope: string[] | null; by: string | null}) => Promise<string | void>): Promise<FlagActionResult> {
  const e = await editor(company);
  if ('error' in e) return {ok: false, error: e.error as string};
  try {
    const note = await fn(e);
    revalidatePath('/flags');
    revalidatePath('/stock', 'layout');
    return {ok: true, ...(note ? {note} : {})};
  } catch (err) {
    if (err instanceof FlagError) return {ok: false, error: err.message};
    console.error('flag action failed', err);
    return {ok: false, error: 'Couldn’t save that. Please try again.'};
  }
}

const remarkOf = (r: unknown) => (typeof r === 'string' ? r.trim().slice(0, MAX_REMARK) : '');

export async function closeFlagAction(input: {company: string | null; id: string; status: 'checked' | 'dismissed'; remark: string; cause?: FlagCause}): Promise<FlagActionResult> {
  const remark = remarkOf(input.remark);
  if (!UUID.test(input.id ?? '')) return {ok: false, error: 'Pick a flag.'};
  if (input.status !== 'checked' && input.status !== 'dismissed') return {ok: false, error: 'Pick checked or dismissed.'};
  if (!remark) return {ok: false, error: 'Add a remark: what was found, or why it’s fine.'};
  if (input.cause && !CAUSES.includes(input.cause)) return {ok: false, error: 'Pick a cause.'};
  return run(input.company, (e) => closeFlag(e.companyId, e.scope, {id: input.id, status: input.status, remark, cause: input.cause, by: e.by}));
}

export async function reopenFlagAction(input: {company: string | null; id: string}): Promise<FlagActionResult> {
  if (!UUID.test(input.id ?? '')) return {ok: false, error: 'Pick a flag.'};
  return run(input.company, (e) => reopenFlag(e.companyId, e.scope, input.id));
}

export async function logLossAction(input: {company: string | null; id: string; reason: AdjustmentReason; qty: number; remark: string}): Promise<FlagActionResult> {
  const remark = remarkOf(input.remark);
  if (!UUID.test(input.id ?? '')) return {ok: false, error: 'Pick a flag.'};
  if (!REASONS.includes(input.reason)) return {ok: false, error: 'Pick pull-out, damage or loss.'};
  if (!Number.isInteger(input.qty) || input.qty < 1 || input.qty > 100_000) return {ok: false, error: 'Enter how many units (1 or more).'};
  if (!remark) return {ok: false, error: 'Add a remark: what happened to the stock.'};
  return run(input.company, async (e) => {
    await logLossFromFlag(e.companyId, e.scope, {id: input.id, reason: input.reason, qty: input.qty, remark, by: e.by});
    return `Logged ${input.qty} as ${input.reason.replace('_', '-')} and closed the flag.`;
  });
}

export async function addAdjustmentAction(input: {
  company: string | null;
  store: string;
  item: string;
  periodStart: string;
  periodEnd: string;
  reason: AdjustmentReason;
  qty: number;
  note: string;
}): Promise<FlagActionResult> {
  if (!input.store || !input.item) return {ok: false, error: 'Pick a store and an item.'};
  if (!DATE.test(input.periodStart ?? '') || !DATE.test(input.periodEnd ?? '') || input.periodStart > input.periodEnd) return {ok: false, error: 'Pick the cycle it happened in.'};
  if (!REASONS.includes(input.reason)) return {ok: false, error: 'Pick pull-out, damage or loss.'};
  if (!Number.isInteger(input.qty) || input.qty < 1 || input.qty > 100_000) return {ok: false, error: 'Enter how many units (1 or more).'};
  return run(input.company, (e) =>
    addAdjustment(e.companyId, e.scope, {
      store: input.store,
      item: input.item,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      reason: input.reason,
      qty: input.qty,
      note: remarkOf(input.note) || null,
      by: e.by,
    }),
  );
}

export async function deleteAdjustmentAction(input: {company: string | null; id: string}): Promise<FlagActionResult> {
  if (!UUID.test(input.id ?? '')) return {ok: false, error: 'Pick an adjustment.'};
  return run(input.company, (e) => deleteAdjustment(e.companyId, e.scope, input.id));
}

export async function runChecksAction(input: {company: string | null}): Promise<FlagActionResult> {
  return run(input.company, async (e) => {
    const r = await runChecks(e.companyId, e.scope ?? undefined);
    return `Checks ran: ${r.opened} new, ${r.updated} still open, ${r.resolved} cleared.`;
  });
}
