'use server';

import {revalidatePath, updateTag} from 'next/cache';
import type {ActionResult} from './pos-actions';
import {planEditor} from './plan-auth';
import {PLAN_TAG, getGmvActuals, planClient} from './plan-data';
import {METRICS, currentMonthKey, gmvSnapshot, MONTH_NOT_OVER, closeBlocker, monthEnded, monthTag, targetLock, validateLine} from './plan-compute';
import {phDay} from './custom-range';

// Business Health Report writes. The ONLY write path for typed monthly lines: the editor check re-reads memberships (src/plan-auth.ts), input
// is validated here, and the save is one SECURITY DEFINER RPC (supabase/plan_report.sql) that compares the value the person last saw and writes
// the change and its log row in one transaction. Middleware gates URLs, not actions, so every action checks for itself.

const RPC_ERRORS: Record<string, string> = {
  stale_value: 'Someone else changed this just now. The page has been refreshed, check the new number and try again.',
  month_closed: 'This month is closed. Unlock it with a reason before changing it.',
  negative_cost: 'This number cannot be negative.',
  invalid_line: 'Unknown line.',
  invalid_month: 'Unknown month.',
  already_closed: 'This month was just closed by someone else.',
  month_not_over: 'This month is not over yet. It can be closed once the month has ended.',
  gmv_incomplete: 'Marketplace, Website and Events data must all be complete before a month can be closed. Check the GMV numbers and try again.',
  earlier_month_open: 'An earlier month is still open. Cash carries from month to month, so close the oldest unclosed month first.',
  month_incomplete: 'Close needs every typed line to hold a value (0 counts). Fill in the empty ones first.',
  reason_required: 'Say why you are unlocking this month.',
  not_closed: 'This month is not closed.',
  no_plan_version: 'There is no plan version stored yet.',
  invalid_snapshot: 'Could not take the GMV snapshot. Please try again.',
  stale_version: 'Someone else changed the plan just now. The page has been refreshed, check the new targets and try again.',
  past_month: 'That month is already over. Only the current and future months can be changed.',
  unknown_target: 'That target is not in the plan.',
  calculated_target: 'Total GMV is calculated from the three channels, so it cannot be typed.',
  derived_target: 'That target is calculated by the workbook from other targets, so it cannot be typed.',
  no_changes: 'Change at least one target first.',
  invalid_part: 'That breakdown does not belong to this line.',
  invalid_change: 'One of the targets is not a valid number.',
};
const rpcMessage = (message: string | undefined): string => RPC_ERRORS[(message ?? '').trim()] ?? 'Could not save. Please try again.';

const MONTH = /^\d{4}-(0[1-9]|1[0-2])-01$/;

/** Save one typed line for one month. `amountPhp` is pesos (null clears the cell); `expected` is the value the page showed (null = it was empty). */
export async function savePlanLineAction(input: {month: string; metric: string; amountPhp: number | null; expected: number | null}): Promise<ActionResult> {
  const editor = await planEditor();
  if (!editor) return {ok: false, error: 'Not authorized. You need to be a Coop Admin or a Zoomy admin to change these numbers.'};
  if (!input || typeof input.month !== 'string' || !MONTH.test(input.month)) return {ok: false, error: 'Unknown month.'};
  const bad = validateLine(input.metric, input.amountPhp);
  if (bad) return {ok: false, error: bad};
  if (input.expected !== null && (typeof input.expected !== 'number' || !Number.isFinite(input.expected))) return {ok: false, error: 'Unreadable previous value. Refresh the page.'};
  const sb = planClient();
  if (!sb) return {ok: false, error: 'Demo mode: no database is connected, so nothing was saved.'};
  const {error} = await sb.rpc('plan_set_actual', {p_month: input.month, p_metric: input.metric, p_amount: input.amountPhp, p_expected: input.expected, p_by: editor.email});
  if (error) {
    if (error.message?.trim() === 'stale_value') revalidatePath('/health-report');
    else if (!RPC_ERRORS[error.message?.trim() ?? '']) console.error('savePlanLineAction', error.message);
    return {ok: false, error: rpcMessage(error.message)};
  }
  revalidatePath('/health-report');
  return {ok: true};
}


const NOT_ALLOWED = 'Not authorized. You need to be a Coop Admin or a Zoomy admin to change these numbers.';

/**
 * Close a month: the server takes the GMV snapshot NOW (from Coop's own readers, never from the browser) and one RPC records the close, the
 * snapshot and the plan version, and locks the month's cells. Only after the month has ended (Manila time), only with all three GMV channels complete (checked here and in the RPC), and only with every typed line filled (the RPC checks).
 */
export async function closeMonthAction(input: {month: string}): Promise<ActionResult> {
  const editor = await planEditor();
  if (!editor) return {ok: false, error: NOT_ALLOWED};
  if (!input || typeof input.month !== 'string' || !MONTH.test(input.month)) return {ok: false, error: 'Unknown month.'};
  const today = phDay(Date.now());
  if (!monthEnded(input.month, today)) return {ok: false, error: MONTH_NOT_OVER(monthTag(input.month))};
  const sb = planClient();
  if (!sb) return {ok: false, error: 'Demo mode: no database is connected, so nothing was saved.'};
  const snapshot = gmvSnapshot(await getGmvActuals([input.month], currentMonthKey(new Date())));
  // The same snapshot is what the RPC stores and validates again: a month closes only with all three channels complete.
  const blocked = closeBlocker({month: input.month, today, tag: monthTag(input.month), gmv: snapshot});
  if (blocked) return {ok: false, error: blocked};
  const {error} = await sb.rpc('plan_close_month', {p_month: input.month, p_by: editor.email, p_gmv: snapshot});
  if (error) {
    if (!RPC_ERRORS[error.message?.trim() ?? '']) console.error('closeMonthAction', error.message);
    revalidatePath('/health-report');
    return {ok: false, error: rpcMessage(error.message)};
  }
  revalidatePath('/health-report');
  return {ok: true};
}

/** Unlock a closed month. A reason is required; the RPC logs it in the same transaction as the unlock. The month needs Close month again. */
export async function unlockMonthAction(input: {month: string; reason: string}): Promise<ActionResult> {
  const editor = await planEditor();
  if (!editor) return {ok: false, error: NOT_ALLOWED};
  if (!input || typeof input.month !== 'string' || !MONTH.test(input.month)) return {ok: false, error: 'Unknown month.'};
  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (!reason) return {ok: false, error: rpcMessage('reason_required')};
  if (reason.length > 500) return {ok: false, error: 'Keep the reason under 500 characters.'};
  const sb = planClient();
  if (!sb) return {ok: false, error: 'Demo mode: no database is connected, so nothing was saved.'};
  const {error} = await sb.rpc('plan_unlock_month', {p_month: input.month, p_reason: reason, p_by: editor.email});
  if (error) {
    if (!RPC_ERRORS[error.message?.trim() ?? '']) console.error('unlockMonthAction', error.message);
    revalidatePath('/health-report');
    return {ok: false, error: rpcMessage(error.message)};
  }
  revalidatePath('/health-report');
  return {ok: true};
}

/**
 * Change future-month targets as a NEW plan version (BHR-05). The reason is required here and again in the RPC; the RPC copies the newest version,
 * applies the changes, rejects closed and past months, and refuses if `expectedVersion` is not the newest (someone saved first). Old versions are kept.
 */
export async function editTargetsAction(input: {changes: Array<{month: string; metric: string; value: number}>; reason: string; expectedVersion: number}): Promise<ActionResult> {
  const editor = await planEditor();
  if (!editor) return {ok: false, error: NOT_ALLOWED};
  const reason = typeof input?.reason === 'string' ? input.reason.trim() : '';
  if (!reason) return {ok: false, error: 'Say why you are changing the plan. A reason is required.'};
  if (reason.length > 500) return {ok: false, error: 'Keep the reason under 500 characters.'};
  const changes = input.changes;
  if (!Array.isArray(changes) || changes.length === 0) return {ok: false, error: rpcMessage('no_changes')};
  if (changes.length > 400) return {ok: false, error: 'Too many changes at once.'};
  for (const c of changes) {
    if (!c || typeof c.month !== 'string' || !MONTH.test(c.month)) return {ok: false, error: 'Unknown month.'};
    if (!METRICS.some((m) => m.id === c.metric)) return {ok: false, error: rpcMessage('unknown_target')};
    if (c.metric === 'gmv_total') return {ok: false, error: rpcMessage('calculated_target')};
    const lock = targetLock(c.metric);
    if (lock.locked) return {ok: false, error: lock.reason};
    if (typeof c.value !== 'number' || !Number.isFinite(c.value) || Math.abs(c.value) > 1e12) return {ok: false, error: rpcMessage('invalid_change')};
  }
  if (typeof input.expectedVersion !== 'number' || !Number.isInteger(input.expectedVersion)) return {ok: false, error: 'Unreadable plan version. Refresh the page.'};
  const sb = planClient();
  if (!sb) return {ok: false, error: 'Demo mode: no database is connected, so nothing was saved.'};
  const clean = changes.map((c) => ({month: c.month, metric: c.metric, value: c.value}));
  const {error} = await sb.rpc('plan_edit_targets', {p_changes: clean, p_reason: reason, p_by: editor.email, p_expected_version: input.expectedVersion});
  if (error) {
    if (!RPC_ERRORS[error.message?.trim() ?? '']) console.error('editTargetsAction', error.message);
    updateTag(PLAN_TAG); // the plan read is cached for a minute: expire it so the next page load has the newest version
    revalidatePath('/health-report');
    return {ok: false, error: rpcMessage(error.message)};
  }
  updateTag(PLAN_TAG);
  revalidatePath('/health-report');
  return {ok: true};
}
