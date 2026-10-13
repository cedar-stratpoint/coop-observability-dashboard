'use client';

import {useState} from 'react';
import Link from 'next/link';
import {ArrowLeft, CalendarDays, MapPin, Pencil, Store} from 'lucide-react';
import type {EventRollup, PosEvent, PosOrder} from '@/src/pos-sales-types';
import type {SpinLead} from '@/src/spin-leads-types';
import {formatPeso} from '@/src/pos-format';
import {eventTimeState} from '@/src/pos-sales-compute';
import {MockNote} from './sections';
import {RefreshControl} from './refresh-control';
import {EventForm} from './event-form';
import {EventAnalytics} from './event-analytics';
import {CashReconciliation, EventStatusPill, eventDates} from './event-parts';

/**
 * A single event's page (/offline-sales/events/[eventId]): identity + headline
 * revenue, cash reconciliation, then the full analytics panel, always expanded.
 * Edit swaps the header for the inline EventForm (router.refresh on save).
 */
export function EventDetailView({
  rollup,
  orders,
  allEvents,
  leads,
  todayKey,
  usingMock,
  fetchedAt,
}: {
  rollup: EventRollup;
  orders: PosOrder[];
  allEvents: PosEvent[];
  leads: SpinLead[];
  todayKey: string;
  usingMock: boolean;
  fetchedAt: string;
}) {
  const {event, revenue, orders: orderCount} = rollup;
  const [editing, setEditing] = useState(false);
  const dates = eventDates(event.starts_on, event.ends_on);
  const place = [event.venue, event.city].filter(Boolean).join(', ');
  const name = event.name || 'Untitled event';

  return (
    <div className="mx-auto max-w-4xl px-6 py-8 md:px-10 max-md:px-4 max-md:py-6">
      <div className="mb-4 flex items-center justify-between gap-3">
        <Link href="/offline-sales/events" className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-3.5" /> Events
        </Link>
        <RefreshControl fetchedAt={fetchedAt} />
      </div>

      {usingMock && (
        <MockNote>
          Mock events. Set <code>SUPABASE_URL_ARCHIVE</code> / <code>SUPABASE_SERVICE_ROLE_KEY_ARCHIVE</code> to the
          Staging project to load real <code>pos_events</code>.
        </MockNote>
      )}

      {editing ? (
        <div className="mb-6">
          <EventForm initial={event} events={allEvents} onDone={() => setEditing(false)} />
        </div>
      ) : (
        <header className="mb-6 flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
          <div className="min-w-0">
            <EventStatusPill state={eventTimeState(event, todayKey)} />
            <h1 className="mt-2 text-2xl font-semibold tracking-tight">{name}</h1>
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
              {dates && (
                <span className="inline-flex items-center gap-1">
                  <CalendarDays className="size-3.5" /> {dates}
                </span>
              )}
              {place && (
                <span className="inline-flex items-center gap-1">
                  <MapPin className="size-3.5" /> {place}
                </span>
              )}
              {event.organizer && (
                <span className="inline-flex items-center gap-1">
                  <Store className="size-3.5" /> {event.organizer}
                </span>
              )}
            </div>
          </div>
          <div className="flex items-start gap-3">
            <div className="text-right">
              <div className="font-serif text-3xl font-normal leading-tight tracking-tight tabular-nums">{formatPeso(revenue)}</div>
              <div className="text-xs text-muted-foreground">
                {orderCount} {orderCount === 1 ? 'order' : 'orders'}
              </div>
            </div>
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs text-muted-foreground transition-[color,transform] duration-150 ease-out hover:text-foreground active:scale-95"
              aria-label={`Edit ${name}`}
            >
              <Pencil className="size-3" /> Edit
            </button>
          </div>
        </header>
      )}

      <CashReconciliation rollup={rollup} />

      <div className="mt-8 border-t pt-8">
        <EventAnalytics event={event} orders={orders} leads={leads} />
      </div>
    </div>
  );
}
