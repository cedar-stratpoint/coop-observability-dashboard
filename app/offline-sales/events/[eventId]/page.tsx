import {notFound} from 'next/navigation';
import {getPosEvents, getPosOrders} from '@/src/pos-sales';
import {usingPosMock} from '@/src/pos-data';
import {eventRollups, manilaDayKey, resolveOrderEvents} from '@/src/pos-sales-compute';
import {EventDetailView} from '@/components/analyst/event-detail';
import {getSpinLeads} from '@/src/spin-leads';

export const dynamic = 'force-dynamic';

// One event's page: header, cash reconciliation, and the full analytics panel
// (KPIs, revenue trend, payment split, pet mix, top sellers, booth leads). The
// Events list links each tile here. Orders use the same read-time event
// attribution as the list (resolveOrderEvents), so the totals agree.
export default async function Page(props: {params: Promise<{eventId: string}>}) {
  const {eventId: rawId} = await props.params;
  const eventId = decodeURIComponent(rawId);
  const [events, rawOrders, leads] = await Promise.all([getPosEvents(), getPosOrders(), getSpinLeads()]);
  const event = events.find((e) => e.event_id === eventId);
  if (!event) notFound();

  const orders = resolveOrderEvents(rawOrders, events).filter((o) => o.event_id === eventId);
  const rollup = eventRollups([event], orders)[0];

  return (
    <EventDetailView
      rollup={rollup}
      orders={orders}
      allEvents={events}
      leads={leads}
      todayKey={manilaDayKey(new Date().toISOString())}
      usingMock={usingPosMock()}
      fetchedAt={new Date().toISOString()}
    />
  );
}
