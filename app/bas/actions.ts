'use server';

import {revalidatePath} from 'next/cache';
import {auth} from '@/auth';
import {getDataContext} from '@/src/active-context';
import {canEditData} from '@/src/company';
import {assignBa, BaError} from '@/src/goldline-ba-data';

// Actions behind the BA list (BAs come from the forms; /bas only corrects a store's BA). Each re-derives the tenant context, re-checks write
// capability, and passes the role's store scope down.

export type BaActionResult = {ok: true; note: string} | {ok: false; error: string};

const DATE = /^\d{4}-\d{2}-\d{2}$/;

async function run(company: string | null, fn: (e: {companyId: string; scope: string[] | null; by: string | null}) => Promise<string>): Promise<BaActionResult> {
  const ctx = await getDataContext(company);
  if (!ctx || !ctx.companyId) return {ok: false, error: 'Not authorized for this company.'};
  if (!canEditData(ctx.role)) return {ok: false, error: 'Your role can’t change the BA list.'};
  if (Array.isArray(ctx.storeScope) && ctx.storeScope.length === 0) return {ok: false, error: 'No stores are assigned to your role.'};
  const session = await auth();
  try {
    const note = await fn({companyId: ctx.companyId, scope: ctx.storeScope ?? null, by: session?.user?.email ?? null});
    revalidatePath('/bas');
    revalidatePath('/flags');
    return {ok: true, note};
  } catch (err) {
    if (err instanceof BaError) return {ok: false, error: err.message};
    console.error('BA action failed', err);
    return {ok: false, error: 'Couldn’t save that. Please try again.'};
  }
}

const filledNote = (n: number) => (n ? ' Saved forms from that date with no BA name now count against them.' : '');

export async function assignBaAction(input: {company: string | null; store: string; name: string; from: string}): Promise<BaActionResult> {
  if (!input.store) return {ok: false, error: 'Pick a store.'};
  if (!DATE.test(input.from ?? '')) return {ok: false, error: 'Pick the date they started.'};
  return run(input.company, async (e) => {
    const r = await assignBa(e.companyId, e.scope, {store: input.store, name: input.name ?? '', from: input.from, by: e.by});
    return r.unchanged && !r.filled ? 'Already this store’s BA.' : `Saved.${filledNote(r.filled)}`;
  });
}
