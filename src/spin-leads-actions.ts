'use server';

import {revalidatePath, revalidateTag} from 'next/cache';
import {auth} from '@/auth';
import {devAuthEnabled} from './dev-auth';
import {fetchCrmSpinLeads} from './crm-data';
import {posClient, usingPosMock} from './pos-data';
import {fetchAllRows} from './pos-fetch-paginate';
import {SPIN_LEADS_TAG} from './spin-leads';
import {newSpinLeadRows} from './spin-leads-sync';

export type UpdateLeadsResult = {ok: true; added: number; total: number} | {ok: false; error: string};

/**
 * The leads page's Update button: pull every spin-the-wheel lead from Shopify
 * (through the CRM worker) and add the ones Coop doesn't have yet.
 *
 * Insert-only. Rows already in spin_wheel_leads are never updated or removed,
 * so the button can be pressed any number of times. Same guarantee as the CSV
 * import: ignoreDuplicates on the table's unique keys covers two presses that
 * race each other.
 */
export async function updateSpinLeads(): Promise<UpdateLeadsResult> {
  // The middleware already requires a sign-in for this page; this writes to the
  // prod table, so the action checks again rather than trusting its caller.
  if (!devAuthEnabled() && !(await auth().catch(() => null))?.user) return {ok: false, error: 'Sign in again to update leads.'};
  if (usingPosMock()) return {ok: false, error: 'Leads are not connected in this environment.'};

  let remote;
  try {
    remote = await fetchCrmSpinLeads();
  } catch (e) {
    console.warn(`spin-leads update: CRM read failed: ${e instanceof Error ? e.message : String(e)}`);
    return {ok: false, error: 'Could not reach the spin-wheel leads (CRM / Shopify). Nothing was changed.'};
  }

  const supabase = posClient();
  let existing;
  try {
    existing = await fetchAllRows('spin_wheel_leads contacts', (from, to) =>
      supabase.from('spin_wheel_leads').select('email,instagram').order('lead_id').range(from, to));
  } catch (e) {
    console.warn(`spin-leads update: reading existing leads failed: ${e instanceof Error ? e.message : String(e)}`);
    return {ok: false, error: 'Could not read the current leads. Nothing was changed.'};
  }

  const rows = newSpinLeadRows(
    remote,
    existing.map((r) => ({email: (r.email as string | null) ?? null, instagram: (r.instagram as string | null) ?? null})),
  );

  // Email and handle leads dedupe on their own unique key, hence two writes.
  for (const [col, batch] of [['email', rows.filter((r) => r.email)], ['instagram', rows.filter((r) => !r.email)]] as const) {
    if (!batch.length) continue;
    const {error} = await supabase
      .from('spin_wheel_leads')
      .upsert(batch, {onConflict: `${col},collected_at`, ignoreDuplicates: true});
    if (error) {
      console.warn(`spin-leads update: insert (${col}) failed: ${error.message}`);
      const hint = /picky/.test(error.message) ? ' Run supabase/spin_wheel_leads_picky.sql first.' : '';
      return {ok: false, error: `Saving new leads failed.${hint}`};
    }
  }

  revalidateTag(SPIN_LEADS_TAG, 'max');
  revalidatePath('/customers/leads');
  revalidatePath('/offline-sales/events', 'layout'); // the list and each event's own page
  return {ok: true, added: rows.length, total: existing.length + rows.length};
}
