'use server';

import {revalidatePath, updateTag} from 'next/cache';
import {CUSTOMER_CONTACTS_TAG} from './customer-contacts-data';
import {deleteContactWith, logContactWith, type ContactLogDeps, type ContactResult} from './customer-contacts';
import {posClient, usingPosMock} from './pos-data';
import {reportsViewerEmail} from './reports-session';
import {writeError} from './supabase-errors';

// "Log contact" on the Website CRM page's Customers tab (RET-05). The rules (validation, delete-own) live in the pure
// src/customer-contacts.ts; this file only wires the session and the service-role client. It records a contact that a
// person already made by hand: nothing here, or anywhere in the log, sends a message.

const PAGE = '/customers/website-crm';

function deps(): ContactLogDeps {
  const supabase = posClient();
  return {
    // The signed-in email, lower-cased (dev bypass: dev@localhost). No session = null: never a shared "coop" author.
    actor: reportsViewerEmail,
    insert: async (row) => writeError(await supabase.from('customer_contacts').insert(row)),
    // Filtered by id AND created_by in one statement: another person's row matches nothing and is left alone.
    deleteOwn: async (id, by) => {
      const r = await supabase.from('customer_contacts').delete().eq('id', id).eq('created_by', by).select('id'); // pagination-ok: a delete by primary key returns at most one row
      return {error: writeError(r), deleted: r.data?.length ?? 0};
    },
  };
}

function done(r: ContactResult): ContactResult {
  if (r.ok) {
    updateTag(CUSTOMER_CONTACTS_TAG); // read-your-own-write: the next render waits for the fresh log
    revalidatePath(PAGE);
  }
  return r;
}

export async function logContact(input: {email: string | null; channel: string; note: string}): Promise<ContactResult> {
  if (usingPosMock()) return {ok: false, error: 'The contact log is not connected in this environment.'};
  return done(await logContactWith(deps(), input));
}

export async function deleteContact(id: string): Promise<ContactResult> {
  if (usingPosMock()) return {ok: false, error: 'The contact log is not connected in this environment.'};
  return done(await deleteContactWith(deps(), id));
}
