import {
  crmConfigured,
  getCrmBirthdayVouchers,
  getCrmCheckouts,
  getCrmCustomers,
  getCrmMembershipConfig,
  getCrmMembershipEvents,
  getCrmMetrics,
  getCrmOrders,
} from '@/src/crm-data';
import {getCustomerContacts} from '@/src/customer-contacts-data';
import {getCustomerCohorts} from '@/src/customer-cohorts-data';
import {reportsViewerEmail} from '@/src/reports-session';
import {CrmView} from '@/components/analyst/crm-view';

// Live proxy over the CRM Worker: never statically rendered, because the point
// of the page is that it agrees with the storefront admin right now.
export const dynamic = 'force-dynamic';

export default async function Page() {
  const [metrics, customers, orders, checkouts, birthdayVouchers, membershipEvents, membership, contacts, cohorts, viewer] = await Promise.all([
    getCrmMetrics(),
    getCrmCustomers(),
    getCrmOrders(),
    getCrmCheckouts(),
    getCrmBirthdayVouchers(),
    // RET-07 7C: null = unread (unknown); {live: false} = the CRM route is not deployed yet (not counted, with a note).
    getCrmMembershipEvents(),
    getCrmMembershipConfig(),
    // The manual contact log (RET-05): null when the table is not applied yet, so the page shows "unavailable", never 0.
    getCustomerContacts(),
    // RET-10 saved cohorts (rules only; members are matched live on the page): null when the table is not applied = "unavailable".
    getCustomerCohorts(),
    // Who is looking: the log shows a delete control only on contacts this person logged (the action checks again).
    reportsViewerEmail(),
  ]);
  // One server clock for the whole render: days since last order and the membership year are computed from it on
  // both the server and the client, so the two renders agree. "Updated" is stamped only when the CRM answered.
  const now = new Date().toISOString();
  const answered = metrics !== null || customers !== null || orders !== null || checkouts !== null;
  return (
    <CrmView
      metrics={metrics}
      customers={customers}
      orders={orders}
      checkouts={checkouts}
      birthdayVouchers={birthdayVouchers}
      membershipEvents={membershipEvents}
      membership={membership}
      contacts={contacts}
      cohorts={cohorts}
      viewer={viewer}
      configured={crmConfigured()}
      now={now}
      fetchedAt={answered ? now : null}
    />
  );
}
