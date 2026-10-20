// The server seam for the chat's `contacts` tool (plan knowledge/tasks/2026-10-19-ask-coop-customer-leads-plan.md). It lives outside
// src/chat on purpose: src/chat may not import the data layer (test/chat-architecture.test.ts). It reuses the loaders behind
// /customers/leads, so the chat sees exactly what a signed-in owner sees there and no new database role or view is needed.
import {matchLeadsToOrders} from '@/src/lead-order-match';
import {getLazadaItems} from '@/src/lazada-data';
import {itemsToCustomers} from '@/src/lazada-export';
import {getOrdersWithPrizes} from '@/src/pos-prize-data';
import {getPosEvents, getPosOrders} from '@/src/pos-sales';
import {getSpinLeads} from '@/src/spin-leads';
import type {LeadsSource} from '@/src/chat/contacts/leads';

export async function loadLeadsSource(): Promise<LeadsSource> {
  const [leads, events, orders, prizeOrders, lazada] = await Promise.all([
    getSpinLeads(),
    getPosEvents(),
    // The purchase match is an extra, as on the leads page: a POS read failure must not take the contact list down with it.
    getPosOrders().catch(() => []),
    getOrdersWithPrizes().catch(() => []),
    // Lazada buyers (find / overlap): fail soft, the tool says when they are missing.
    getLazadaItems().then((r) => itemsToCustomers(r.items)).catch(() => null),
  ]);
  const dated = events.flatMap((e) => (e.name && e.starts_on ? [{event_id: e.event_id, name: e.name, starts_on: e.starts_on, ends_on: e.ends_on}] : []));
  return {leads, events: dated, matches: matchLeadsToOrders(leads, orders, new Set(prizeOrders)), lazada};
}
