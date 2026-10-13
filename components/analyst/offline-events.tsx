'use client';

import {useEffect, useMemo, useState} from 'react';
import Link from 'next/link';
import {ArrowLeft, CalendarDays, ChevronRight, MapPin, Plus, Search, X} from 'lucide-react';
import type {EventRollup} from '@/src/pos-sales-types';
import {formatPeso} from '@/src/pos-format';
import {
  EVENT_SORT_OPTIONS,
  EVENT_WHEN_FILTERS,
  eventTimeState,
  filterAndSortEvents,
  type EventSort,
  type EventWhen,
} from '@/src/pos-sales-compute';
import {cn} from '@/lib/utils';
import {Card, CardContent} from '@/components/ui/card';
import {Eyebrow, MockNote} from './sections';
import {RefreshControl} from './refresh-control';
import {SegmentedControl} from './segmented-control';
import {Pagination} from './pagination';
import {EventForm} from './event-form';
import {EventStatusPill, eventDates} from './event-parts';

const EVENTS_PER_PAGE = 12;

export function OfflineEventsView({
  rollups,
  currentEventIds,
  todayKey,
  usingMock,
  fetchedAt,
}: {
  rollups: EventRollup[];
  currentEventIds: string[];
  todayKey: string;
  usingMock: boolean;
  fetchedAt: string;
}) {
  const [creating, setCreating] = useState(false);

  // Search + time bucket + sort + page, all client-side (see filterAndSortEvents):
  // the list is modest and each tile only needs its rollup. Any result-set change
  // snaps back to page 1. Analytics live on the per-event detail page.
  const [query, setQuery] = useState('');
  const [when, setWhen] = useState<EventWhen>('all');
  const [sort, setSort] = useState<EventSort>('recent');
  const [page, setPage] = useState(1);
  useEffect(() => { setPage(1); }, [query, when, sort]);

  // Every event, for the form's live "runs alongside" note.
  const allEvents = useMemo(() => rollups.map((r) => r.event), [rollups]);

  // Which events are live today (same-day events allowed, so there can be several).
  const currentSet = useMemo(() => new Set(currentEventIds), [currentEventIds]);

  // Filter + sort, then pin every live event to the top so they stay on page 1.
  const ordered = useMemo(() => {
    const list = filterAndSortEvents(rollups, {query, when, sort}, todayKey);
    if (currentSet.size === 0) return list;
    const live = list.filter((r) => currentSet.has(r.event.event_id));
    const rest = list.filter((r) => !currentSet.has(r.event.event_id));
    return [...live, ...rest];
  }, [rollups, query, when, sort, todayKey, currentSet]);

  const total = rollups.length;
  const matches = ordered.length;
  const pageCount = Math.max(1, Math.ceil(matches / EVENTS_PER_PAGE));
  const safePage = Math.min(page, pageCount);
  const pageItems = ordered.slice((safePage - 1) * EVENTS_PER_PAGE, safePage * EVENTS_PER_PAGE);
  const filtering = query.trim() !== '' || when !== 'all';

  return (
    <div className="mx-auto max-w-4xl px-6 py-8 md:px-10 max-md:px-4 max-md:py-6">
      <Link href="/offline-sales" className="mb-3 inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-3.5" /> Offline Sales
      </Link>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <Eyebrow icon={CalendarDays}>Events</Eyebrow>
          <p className="text-sm text-muted-foreground">Schedule a bazaar so the POS auto-tags that day&rsquo;s sales. Sales and cash reconcile here.</p>
        </div>
        <div className="flex items-center gap-2">
          <RefreshControl fetchedAt={fetchedAt} />
          {!creating && (
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-transform duration-150 ease-out active:scale-95"
            >
              <Plus className="size-3.5" /> New event
            </button>
          )}
        </div>
      </div>

      {usingMock && (
        <MockNote>
          Mock events. Set <code>SUPABASE_URL_ARCHIVE</code> / <code>SUPABASE_SERVICE_ROLE_KEY_ARCHIVE</code> to the
          Staging project to load real <code>pos_events</code>.
        </MockNote>
      )}

      {creating && (
        <div className="mb-3">
          <EventForm events={allEvents} onDone={() => setCreating(false)} />
        </div>
      )}

      {total === 0 && !creating ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No events yet. Use &ldquo;New event&rdquo; to schedule a bazaar with its dates, location, and opening cash. Its
            sales and till reconciliation appear here once the POS runs on those days.
          </CardContent>
        </Card>
      ) : (
        <>
          {total > 0 && (
            <EventsToolbar
              query={query}
              onQuery={setQuery}
              when={when}
              onWhen={setWhen}
              sort={sort}
              onSort={setSort}
            />
          )}

          {total > 0 && (
            <p className="mb-3 text-xs text-muted-foreground">
              {filtering ? `${matches} of ${total} ${total === 1 ? 'event' : 'events'}` : `${total} ${total === 1 ? 'event' : 'events'}`}
            </p>
          )}

          {matches === 0 ? (
            <Card>
              <CardContent className="flex flex-col items-center gap-3 py-10 text-center text-sm text-muted-foreground">
                No events match your search.
                <button
                  type="button"
                  onClick={() => { setQuery(''); setWhen('all'); }}
                  className="inline-flex items-center gap-1 text-xs font-medium text-primary transition-opacity hover:opacity-80"
                >
                  <X className="size-3.5" /> Clear filters
                </button>
              </CardContent>
            </Card>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {pageItems.map((r) => (
                <EventTile
                  key={r.event.event_id}
                  rollup={r}
                  todayKey={todayKey}
                  spotlight={currentSet.has(r.event.event_id)}
                />
              ))}
            </div>
          )}

          <Pagination page={safePage} pageCount={pageCount} onPage={setPage} className="mt-6" />
        </>
      )}
    </div>
  );
}

/** Search box + When/Sort segmented controls above the event list. */
function EventsToolbar({
  query,
  onQuery,
  when,
  onWhen,
  sort,
  onSort,
}: {
  query: string;
  onQuery: (v: string) => void;
  when: EventWhen;
  onWhen: (v: EventWhen) => void;
  sort: EventSort;
  onSort: (v: EventSort) => void;
}) {
  return (
    <div className="mb-4 flex flex-col gap-3">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <input
          type="search"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder="Search events by name, venue, or city"
          aria-label="Search events"
          className="h-10 w-full rounded-lg border bg-background pl-9 pr-9 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-primary/50 focus-visible:ring-2 focus-visible:ring-ring/40"
        />
        {query && (
          <button
            type="button"
            onClick={() => onQuery('')}
            aria-label="Clear search"
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-muted-foreground transition-colors hover:text-foreground active:scale-95"
          >
            <X className="size-4" />
          </button>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
        <ToolbarGroup label="When">
          <SegmentedControl ariaLabel="Filter by when" options={EVENT_WHEN_FILTERS} value={when} onChange={onWhen} />
        </ToolbarGroup>
        <ToolbarGroup label="Sort">
          <SegmentedControl ariaLabel="Sort events" options={EVENT_SORT_OPTIONS} value={sort} onChange={onSort} />
        </ToolbarGroup>
      </div>
    </div>
  );
}

function ToolbarGroup({label, children}: {label: string; children: React.ReactNode}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

/** One event as a compact tile: status, name, when/where, and the headline
 *  revenue. The whole tile links to the event's detail page, which holds the
 *  cash reconciliation, the analytics, and the edit form. */
function EventTile({rollup, todayKey, spotlight}: {rollup: EventRollup; todayKey: string; spotlight: boolean}) {
  const {event, revenue, orders} = rollup;
  const dates = eventDates(event.starts_on, event.ends_on);
  const place = [event.venue, event.city].filter(Boolean).join(', ');
  const name = event.name || 'Untitled event';

  return (
    <Link
      href={`/offline-sales/events/${encodeURIComponent(event.event_id)}`}
      aria-label={`Open ${name}`}
      className={cn(
        'group flex h-full flex-col gap-3 rounded-xl border bg-card p-4 sm:gap-4 sm:p-5 transition-[background-color,border-color,transform] duration-150 ease-out',
        'hover:border-foreground/20 hover:bg-muted/40 active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
        spotlight && 'border-transparent ring-1 ring-[var(--status-good)]/40',
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <EventStatusPill state={eventTimeState(event, todayKey)} />
        <ChevronRight className="size-4 text-muted-foreground transition-transform duration-150 ease-out group-hover:translate-x-0.5 group-hover:text-foreground" />
      </div>

      <div className="min-w-0 flex-1">
        <h3 className="line-clamp-2 text-[15px] font-semibold leading-snug tracking-tight">{name}</h3>
        <div className="mt-2 flex flex-col gap-1 text-xs text-muted-foreground">
          {dates && (
            <span className="inline-flex min-w-0 items-center gap-1.5">
              <CalendarDays className="size-3.5 shrink-0" /> <span className="truncate">{dates}</span>
            </span>
          )}
          {place && (
            <span className="inline-flex min-w-0 items-center gap-1.5">
              <MapPin className="size-3.5 shrink-0" /> <span className="truncate">{place}</span>
            </span>
          )}
        </div>
      </div>

      <div className="flex items-baseline justify-between gap-3 border-t pt-3 sm:pt-4">
        <span className="font-serif text-2xl font-normal leading-none tracking-tight tabular-nums">{formatPeso(revenue)}</span>
        <span className="text-xs tabular-nums text-muted-foreground">
          {orders} {orders === 1 ? 'order' : 'orders'}
        </span>
      </div>
    </Link>
  );
}
