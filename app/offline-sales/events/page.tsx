import {getPosEvents, getPosOrders} from '@/src/pos-sales';
import {usingPosMock} from '@/src/pos-data';
import {eventRollups, featuredEvent, manilaDayKey, resolveOrderEvents} from '@/src/pos-sales-compute';
import {OfflineEventsView} from '@/components/analyst/offline-events';

export const dynamic = 'force-dynamic';

export default async function Page() {
  const [events, rawOrders] = await Promise.all([getPosEvents(), getPosOrders()]);
  // Attribute untagged past-day sales to any event whose dates now cover them
  // (automatic, read-time — see resolveOrderEvents). Everything below groups by the
  // resolved event_id, so extending an event's dates folds those sales in.
  const orders = resolveOrderEvents(rawOrders, events);
  // The event running today (if any) is pinned to the top with a highlight ring.
  // Each tile links to /offline-sales/events/[eventId] for the full analytics.
  const todayKey = manilaDayKey(new Date().toISOString());
  const featured = featuredEvent(events, todayKey);
  const currentEventIds = featured?.state === 'current' ? [featured.event.event_id] : [];

  return (
    <OfflineEventsView
      rollups={eventRollups(events, orders)}
      currentEventIds={currentEventIds}
      todayKey={todayKey}
      usingMock={usingPosMock()}
      fetchedAt={new Date().toISOString()}
    />
  );
}
