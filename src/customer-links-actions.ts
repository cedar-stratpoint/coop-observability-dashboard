'use server';

import {revalidatePath, updateTag} from 'next/cache';
import {CUSTOMER_LINKS_TAG} from './customer-links-data';
import {linkPeopleWith, unlinkPeopleWith, type LinkDeps, type LinkResult} from './customer-links';
import {posClient, usingPosMock} from './pos-data';
import {reportsViewerEmail} from './reports-session';
import {writeError} from './supabase-errors';

// "Same person" on Ask Coop's matches table, and "Unlink" on the Website CRM Customers tab (RET-15 Slice B). The rules live in
// the pure src/customer-links.ts; this file only wires the session and the service-role client. A link adds metadata beside
// a customer; it never merges or changes the customer.

const PAGE = '/customers/website-crm';

function deps(): LinkDeps {
  const supabase = posClient();
  return {
    actor: reportsViewerEmail,
    insert: async (row) => writeError(await supabase.from('customer_links').insert(row)),
    // Filtered by id AND created_by in one statement: another person's link matches nothing and is left alone.
    deleteOwn: async (id, by) => {
      const r = await supabase.from('customer_links').delete().eq('id', id).eq('created_by', by).select('id'); // pagination-ok: a delete by primary key returns at most one row
      return {error: writeError(r), deleted: r.data?.length ?? 0};
    },
  };
}

function done(r: LinkResult): LinkResult {
  if (r.ok) {
    updateTag(CUSTOMER_LINKS_TAG); // read-your-own-write
    revalidatePath(PAGE);
  }
  return r;
}

const MOCK: LinkResult = {ok: false, error: 'Same-person links are not connected in this environment.'};

export async function linkPeople(input: {customerEmail: string; leadEmail?: string | null; leadMobile?: string | null; leadInstagram?: string | null; leadCampaign?: string | null}): Promise<LinkResult> {
  if (usingPosMock()) return MOCK;
  return done(await linkPeopleWith(deps(), input));
}

export async function unlinkPeople(id: string): Promise<LinkResult> {
  if (usingPosMock()) return MOCK;
  return done(await unlinkPeopleWith(deps(), id));
}
