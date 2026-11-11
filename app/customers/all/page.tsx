import {getCrmCustomers, getCrmMembershipConfig, getCrmOrders} from '@/src/crm-data';
import {enrichCustomers} from '@/src/crm-compute';
import {getLazadaItems} from '@/src/lazada-data';
import {itemsToCustomers} from '@/src/lazada-export';
import {getSpinLeads} from '@/src/spin-leads';
import {mergeContacts} from '@/src/contacts-merge';
import {ContactsView} from '@/components/analyst/contacts-view';

export const dynamic = 'force-dynamic';

/**
 * The Customers hub's landing view: all three contact lists as one.
 *
 * Each source is read through its own existing reader, so this page inherits
 * their caching and fail-soft behaviour — a Worker that is briefly down costs
 * the website column, not the page.
 */
export default async function Page() {
  const [customers, orders, membership, lazada, leads] = await Promise.all([
    getCrmCustomers(),
    getCrmOrders(),
    getCrmMembershipConfig(),
    getLazadaItems(),
    getSpinLeads(),
  ]);

  const contacts = mergeContacts(
    enrichCustomers(customers ?? [], orders ?? [], membership.programStart),
    leads,
    itemsToCustomers(lazada.items),
  );

  return <ContactsView contacts={contacts} fetchedAt={new Date().toISOString()} />;
}
