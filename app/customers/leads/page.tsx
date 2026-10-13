import {getSpinLeads} from '@/src/spin-leads';
import {getPosOrders} from '@/src/pos-sales';
import {getOrdersWithPrizes} from '@/src/pos-prize-data';
import {matchLeadsToOrders} from '@/src/lead-order-match';
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
  const [leads, orders, prizeOrders] = await Promise.all([
    getSpinLeads(),
    // The purchase match is an extra; a POS read failure must not take the
    // contact list down with it.
    getPosOrders().catch(() => []),
    getOrdersWithPrizes().catch(() => []),
  ]);
  const matches = matchLeadsToOrders(leads, orders, new Set(prizeOrders));
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
      <LeadsView leads={leads} matches={matches} />
    </div>
  );
}
