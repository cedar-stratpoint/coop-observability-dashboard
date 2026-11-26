// The server seam for what Ask Coop says about a person's team contact status and PawSport (RET-18 P2, plan
// knowledge/tasks/2026-11-25-pawsport-data-in-coop.md). It lives outside src/chat on purpose: src/chat may not import the data layer
// (test/chat-architecture.test.ts). It reuses the Website CRM page's own reads, so the chat says exactly what a signed-in owner sees.
// Read only. The log's note and author never leave this file: the chat needs only who was contacted, when, and whether they replied.
import {getCustomerContactLog} from '@/src/customer-contacts-data';
import {getCustomerLinks} from '@/src/customer-links-data';
import {getPawsportHolders} from '@/src/pawsport-data';
import type {PeopleFacts} from '@/src/chat/contacts/status';

export async function loadPeopleFacts(): Promise<PeopleFacts> {
  const [log, links, pawsport] = await Promise.all([
    getCustomerContactLog().catch(() => null), // null = unreadable: status reads unknown, never "not contacted"
    getCustomerLinks().catch(() => null),
    getPawsportHolders(), // never throws: 'unavailable' = PawSport reads unknown, never "no"
  ]);
  return {log: log ? {rows: log.rows.map((r) => ({...r, note: null, createdBy: ''})), legacy: log.legacy} : null, links, pawsport};
}
