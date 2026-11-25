import {getSpinLeads} from '@/src/spin-leads';
import {getPosOrders} from '@/src/pos-sales';
import {getOrdersWithPrizes} from '@/src/pos-prize-data';
import {matchLeadsToOrders} from '@/src/lead-order-match';
import {getCrmOrders} from '@/src/crm-data';
import {getCustomerContactLog} from '@/src/customer-contacts-data';
import {getCustomerLinks} from '@/src/customer-links-data';
import {contactsOf} from '@/src/person-identity';
import {leadPerson, leadStatuses} from '@/src/spin-leads-types';
import type {CustomerContact} from '@/src/customer-contacts';
import {reportsViewerEmail} from '@/src/reports-session';
import {spinVoucherOrderAt, spinVoucherState, type SpinVoucherInfo} from '@/src/spin-voucher';
import {leadKey} from '@/src/lead-order-match';
import {LeadsView} from '@/components/analyst/leads-view';
import {LeadsUpdateButton} from '@/components/analyst/leads-update-button';

export const dynamic = 'force-dynamic';

/**
 * Every spin-the-wheel lead ever collected, across events — the booth's contact
 * list, with what each lead bought at the till (matched by time, see
 * src/lead-order-match.ts) and the day-1 / day-5 follow-up messages that builds.
 * The per-event slice of the same leads stays on the event page.
 */
export default async function Page() {
  const [leads, orders, prizeOrders, crmOrders, log, links, viewer] = await Promise.all([
    getSpinLeads(),
    // The purchase match is an extra; a POS read failure must not take the
    // contact list down with it.
    getPosOrders().catch(() => []),
    getOrdersWithPrizes().catch(() => []),
    // RET-13B: website orders decide "ordered since the spin"; an unread list is unknown, never "no order".
    getCrmOrders().catch(() => null),
    // RET-05 / RET-17 log: null when not applied or unread (every status reads "Unknown", never "Not contacted").
    getCustomerContactLog().catch(() => null),
    // RET-17 D3: a Same person link joins a lead to a website customer's contacts. Unread = no links (the lead's own keys still count).
    getCustomerLinks().catch(() => null),
    reportsViewerEmail(),
  ]);
  // Computed here so the CRM orders list (customer emails) never reaches the browser.
  const vouchers: Record<string, SpinVoucherInfo> = {};
  for (const l of leads) vouchers[leadKey(l)] = {state: spinVoucherState(l, crmOrders), orderAt: crmOrders ? spinVoucherOrderAt(l, crmOrders) : null};
  const matches = matchLeadsToOrders(leads, orders, new Set(prizeOrders));
  // RET-17: status and each lead's contacts are computed here, so the links (website customers' emails) never reach the browser.
  const contacts = log?.rows ?? null;
  const read = {legacy: log?.legacy ?? false};
  const statuses = leadStatuses(leads, contacts, links ?? [], read);
  // Only what a dialog would show: a lead with contacts, or one whose contacts cannot be read (null). Absent = none yet, or
  // (logRead false) the whole log is unread.
  const histories: Record<string, CustomerContact[] | null> = {};
  if (contacts) for (const l of leads) {
    const mine = contactsOf(leadPerson(l), contacts, links ?? [], read);
    if (mine === null || mine.length > 0) histories[leadKey(l)] = mine;
  }
  return (
    <div className="space-y-6 p-6 md:p-10">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-serif text-3xl font-normal tracking-tight">Event lead contacts</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Emails, Instagram handles and mobile numbers given in person at the booth, in exchange for a
            spin. Market to them on that basis only, and honour an unsubscribe on either channel.
          </p>
        </div>
        <LeadsUpdateButton />
      </header>
      <LeadsView leads={leads} matches={matches} vouchers={vouchers} statuses={statuses} histories={histories} legacy={read.legacy} logRead={contacts !== null} viewer={viewer} />
    </div>
  );
}
