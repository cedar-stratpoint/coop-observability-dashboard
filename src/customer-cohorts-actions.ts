'use server';

import {revalidatePath, updateTag} from 'next/cache';
import {CUSTOMER_COHORTS_TAG} from './customer-cohorts-data';
import {createCohortWith, deleteCohortWith, updateCohortWith, type CohortDeps, type CohortResult} from './customer-cohorts';
import type {CohortRule} from './crm-compute';
import {posClient, usingPosMock} from './pos-data';
import {reportsViewerEmail} from './reports-session';
import {writeError} from './supabase-errors';

// Saved cohorts on the Website CRM page (RET-10 Stage 9A). The rules (validation, idempotent create, creator-only edit/delete)
// live in the pure src/customer-cohorts.ts; this file only wires the session and the service-role client. createCohort is the
// ONE save path for the hand builder and, in 9B, Ask Coop's "Save cohort" button (knowledge/best-practices/chat-proposed-writes.md):
// every call re-checks the session and re-validates the label and rule, whatever the browser sent. A cohort labels customers
// on this page; nothing here, or anywhere in cohorts, sends a message.

const PAGE = '/customers/website-crm';
const DEMO = 'Not available in demo mode: cohorts are not connected in this environment.';

/** ILIKE with the pattern characters escaped: an exact, case-insensitive match (the unique index is on lower()). */
const exactILike = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);

function deps(): CohortDeps {
  const supabase = posClient();
  return {
    // The signed-in email, lower-cased (dev bypass: dev@localhost). No session = null: never a shared "coop" author.
    actor: reportsViewerEmail,
    insert: async (row) => {
      const r = await supabase.from('customer_cohorts').insert(row).select('id'); // pagination-ok: an insert of one row returns that one row
      return {error: writeError(r), id: (r.data?.[0]?.id as string | undefined) ?? null};
    },
    findByLabel: async ({group, name}) => {
      const r = await supabase
        .from('customer_cohorts')
        .select('id,rule,created_by')
        .ilike('group_name', exactILike(group))
        .ilike('name', exactILike(name))
        .limit(1);
      const hit = r.data?.[0];
      return hit ? {id: String(hit.id), rule: hit.rule as CohortRule, createdBy: String(hit.created_by)} : null;
    },
    // Filtered by id AND created_by in one statement: another person's cohort matches nothing and is left alone.
    updateOwn: async (id, by, patch) => {
      const r = await supabase
        .from('customer_cohorts')
        .update({...patch, updated_at: new Date().toISOString()})
        .eq('id', id)
        .eq('created_by', by)
        .select('id'); // pagination-ok: an update by primary key returns at most one row
      return {error: writeError(r), updated: r.data?.length ?? 0};
    },
    deleteOwn: async (id, by) => {
      const r = await supabase.from('customer_cohorts').delete().eq('id', id).eq('created_by', by).select('id'); // pagination-ok: a delete by primary key returns at most one row
      return {error: writeError(r), deleted: r.data?.length ?? 0};
    },
  };
}

function done(r: CohortResult): CohortResult {
  if (r.ok) {
    updateTag(CUSTOMER_COHORTS_TAG); // read-your-own-write: the next render waits for the fresh list
    revalidatePath(PAGE);
  }
  return r;
}

export type CohortInput = {group: string; name: string; rule: CohortRule};

export async function createCohort(input: CohortInput, origin: 'builder' | 'ask_coop' = 'builder'): Promise<CohortResult> {
  if (usingPosMock()) return {ok: false, error: DEMO};
  return done(await createCohortWith(deps(), input, origin === 'ask_coop' ? 'ask_coop' : 'builder'));
}

export async function updateCohort(id: string, input: CohortInput): Promise<CohortResult> {
  if (usingPosMock()) return {ok: false, error: DEMO};
  return done(await updateCohortWith(deps(), id, input));
}

export async function deleteCohort(id: string): Promise<CohortResult> {
  if (usingPosMock()) return {ok: false, error: DEMO};
  return done(await deleteCohortWith(deps(), id));
}
