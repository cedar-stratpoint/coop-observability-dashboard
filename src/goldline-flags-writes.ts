import 'server-only';
import {nichidoDb} from './nichido-client';
import {runChecks, type FlagStatus} from './goldline-checks-data';
import type {FlagCause} from './goldline-checks';

// Writes behind the flag queue (F7) and adjustments (F5): close or reopen a flag (a
// remark is required, the cause may change), log stock that left without a sale, and
// re-run the store's checks after every adjustment so the next start is right.
// Store-scoped roles pass their scope; anything outside it is refused.

const db = nichidoDb;

export type AdjustmentReason = 'pull_out' | 'damage' | 'loss';

export class FlagError extends Error {}

async function flagFor(companyId: string, id: string, scope: string[] | null) {
  const res = await db()
    .from('flags')
    .select('id,store_code,item_code,period_start,period_end,status,cause')
    .eq('company_id', companyId)
    .eq('id', id)
    .maybeSingle();
  if (res.error) throw new Error(res.error.message);
  if (!res.data) throw new FlagError('That flag no longer exists.');
  if (scope && !scope.includes(res.data.store_code)) throw new FlagError(`Store ${res.data.store_code} is outside your access.`);
  return res.data as {
    id: string;
    store_code: string;
    item_code: string;
    period_start: string;
    period_end: string;
    status: FlagStatus;
    cause: FlagCause;
  };
}

/** Close a flag as checked or dismissed. A remark is required (plan F7); the cause may change. */
export async function closeFlag(
  companyId: string,
  scope: string[] | null,
  input: {
    id: string;
    status: 'checked' | 'dismissed';
    remark: string;
    cause?: FlagCause;
    by: string | null;
  },
) {
  const f = await flagFor(companyId, input.id, scope);
  if (f.status !== 'open') throw new FlagError('This flag is already closed.');
  const changed = input.cause && input.cause !== f.cause;
  const res = await db()
    .from('flags')
    .update({
      status: input.status,
      remark: input.remark,
      closed_by: input.by,
      closed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      ...(changed ? {cause: input.cause, original_cause: f.cause} : {}),
    })
    .eq('company_id', companyId)
    .eq('id', input.id)
    .eq('status', 'open');
  if (res.error) throw new Error(`close failed: ${res.error.message}`);
}

/** Reopen a flag an admin closed by mistake. */
export async function reopenFlag(companyId: string, scope: string[] | null, id: string) {
  const f = await flagFor(companyId, id, scope);
  if (f.status === 'open') return;
  const res = await db()
    .from('flags')
    .update({
      status: 'open',
      closed_by: null,
      closed_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq('company_id', companyId)
    .eq('id', id);
  if (res.error) throw new Error(`reopen failed: ${res.error.message}`);
}

/** Log stock that left without a sale (F5), then re-run that store's checks. */
export async function addAdjustment(
  companyId: string,
  scope: string[] | null,
  input: {
    store: string;
    item: string;
    periodStart: string;
    periodEnd: string;
    reason: AdjustmentReason;
    qty: number;
    note: string | null;
    by: string | null;
    flagId?: string | null;
  },
  rerun = true,
): Promise<void> {
  if (scope && !scope.includes(input.store)) throw new FlagError(`Store ${input.store} is outside your access.`);
  const supa = db();
  const [store, item] = await Promise.all([
    supa.from('stores').select('store_code').eq('company_id', companyId).eq('store_code', input.store).maybeSingle(),
    supa.from('products').select('item_code').eq('company_id', companyId).eq('item_code', input.item).maybeSingle(),
  ]);
  if (!store.data) throw new FlagError(`Store ${input.store} isn’t in the store list.`);
  if (!item.data) throw new FlagError(`Item ${input.item} isn’t in the catalog.`);
  const res = await supa.from('adjustments').insert({
    company_id: companyId,
    store_code: input.store,
    item_code: input.item,
    period_start: input.periodStart,
    period_end: input.periodEnd,
    reason: input.reason,
    qty: input.qty,
    note: input.note,
    created_by: input.by,
    source_flag_id: input.flagId ?? null,
  });
  if (res.error) throw new Error(`adjustment failed: ${res.error.message}`);
  if (rerun) await runChecks(companyId, [input.store]);
}

/** Log the missing stock behind a sales-gap flag as an adjustment and close the flag. */
export async function logLossFromFlag(
  companyId: string,
  scope: string[] | null,
  input: {
    id: string;
    reason: AdjustmentReason;
    qty: number;
    remark: string;
    by: string | null;
  },
): Promise<void> {
  const f = await flagFor(companyId, input.id, scope);
  if (f.status !== 'open') throw new FlagError('This flag is already closed.');
  // Record the loss first (it validates store and item), then close the flag, then re-run
  // the store's checks. A failure before the close leaves the flag open to try again.
  await addAdjustment(
    companyId,
    scope,
    {
      store: f.store_code,
      item: f.item_code,
      periodStart: f.period_start,
      periodEnd: f.period_end,
      reason: input.reason,
      qty: input.qty,
      note: input.remark,
      by: input.by,
      flagId: input.id,
    },
    false,
  );
  await closeFlag(companyId, scope, {
    id: input.id,
    status: 'checked',
    remark: input.remark,
    by: input.by,
  });
  await runChecks(companyId, [f.store_code]);
}

export async function deleteAdjustment(companyId: string, scope: string[] | null, id: string): Promise<void> {
  const supa = db();
  const a = await supa.from('adjustments').select('store_code').eq('company_id', companyId).eq('id', id).maybeSingle();
  if (a.error) throw new Error(a.error.message);
  if (!a.data) throw new FlagError('That adjustment no longer exists.');
  if (scope && !scope.includes(a.data.store_code)) throw new FlagError(`Store ${a.data.store_code} is outside your access.`);
  const res = await supa.from('adjustments').delete().eq('company_id', companyId).eq('id', id);
  if (res.error) throw new Error(`delete failed: ${res.error.message}`);
  await runChecks(companyId, [a.data.store_code]);
}
