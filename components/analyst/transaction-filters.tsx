'use client';

import {useEffect, useState} from 'react';
import Link from 'next/link';
import {usePathname, useRouter, useSearchParams} from 'next/navigation';
import {Popover} from '@base-ui/react/popover';
import {CalendarDays, Check, ChevronDown, SlidersHorizontal, X} from 'lucide-react';
import {cn} from '@/lib/utils';
import {Button} from '@/components/ui/button';
import {RangeSlider} from '@/components/ui/slider';
import {Calendar, type DateRange} from '@/components/ui/calendar';
import {formatPeso} from '@/src/pos-format';
import {ORDER_METHOD_FILTERS, ORDER_STATUS_FILTERS, isFilterActive} from '@/src/pos-sales-compute';
import type {PosEvent, PosOrdersFilter, PriceBounds} from '@/src/pos-sales-types';

/**
 * Filter bar above the transactions list: payment-method pills, a date-range
 * calendar, and a price-range popover. Every control writes to the URL search
 * params (and resets to page 1) so the server re-queries a filtered, paginated
 * slice. The whole bar reads back from those same params, so it's shareable and
 * survives a refresh.
 */
export function TransactionFilters({
  filter,
  bounds,
  eventOptions,
  showEventFilter,
}: {
  filter: PosOrdersFilter;
  bounds: PriceBounds;
  eventOptions: PosEvent[];
  showEventFilter: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  /** Clone the current params, apply a patch, and always return to page 1. */
  function hrefWith(patch: Record<string, string | null>): string {
    const params = new URLSearchParams(searchParams?.toString());
    for (const [key, value] of Object.entries(patch)) {
      if (value == null || value === '') params.delete(key);
      else params.set(key, value);
    }
    params.delete('page');
    const qs = params.toString();
    return qs ? `${pathname}?${qs}` : pathname;
  }

  const anyActive = isFilterActive(filter);

  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-6 gap-y-3 rounded-xl border bg-card px-4 py-3">
      <Group label="Method">
        <Segmented
          items={ORDER_METHOD_FILTERS}
          active={filter.method}
          hrefFor={(value) => hrefWith({method: value === 'all' ? null : value})}
        />
      </Group>

      <Group label="When">
        <DateFilter filter={filter} hrefWith={hrefWith} router={router} />
      </Group>

      <Group label="Price">
        <PriceFilter filter={filter} bounds={bounds} hrefWith={hrefWith} router={router} />
      </Group>

      <Group label="Status">
        <Segmented
          items={ORDER_STATUS_FILTERS}
          active={filter.status}
          hrefFor={(value) => hrefWith({status: value === 'all' ? null : value})}
        />
      </Group>

      {showEventFilter && (
        <Group label="Event">
          <EventFilter filter={filter} options={eventOptions} hrefWith={hrefWith} />
        </Group>
      )}

      {anyActive && (
        <Link
          href={hrefWith({method: null, status: null, event: null, from: null, to: null, min: null, max: null})}
          scroll={false}
          className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          <X className="size-3.5" /> Clear filters
        </Link>
      )}
    </div>
  );
}

function Group({label, children}: {label: string; children: React.ReactNode}) {
  return (
    <div className="flex min-w-0 max-w-full items-center gap-2">
      <span className="shrink-0 text-[11px] font-medium tracking-wider text-muted-foreground uppercase">{label}</span>
      {children}
    </div>
  );
}

function Segmented<T extends string>({
  items,
  active,
  hrefFor,
}: {
  items: {value: T; label: string}[];
  active: T;
  hrefFor: (value: T) => string;
}) {
  return (
    <div className="inline-flex min-w-0 max-w-full overflow-x-auto rounded-md border p-0.5 [scrollbar-width:none]">
      {items.map((it) => (
        <Link
          key={it.value}
          href={hrefFor(it.value)}
          scroll={false}
          className={cn(
            'shrink-0 rounded px-2.5 py-1 text-xs font-medium transition-colors',
            it.value === active ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {it.label}
        </Link>
      ))}
    </div>
  );
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** An ISO instant → the calendar day it falls on in the viewer's timezone. */
function instantToCivil(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** A picked calendar day → the viewer-local start-of-day instant. */
function civilStartInstant(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(y, m - 1, d, 0, 0, 0, 0).toISOString();
}

/** A picked calendar day → the viewer-local end-of-day instant (inclusive). */
function civilEndInstant(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(y, m - 1, d, 23, 59, 59, 999).toISOString();
}

/** "Sep 1" or "Sep 1, 2025" (year shown only when it isn't the current one). */
function shortDate(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const opts: Intl.DateTimeFormatOptions =
    y === new Date().getFullYear() ? {month: 'short', day: 'numeric'} : {month: 'short', day: 'numeric', year: 'numeric'};
  return date.toLocaleDateString(undefined, opts);
}

/** Human label for the applied from/to instants, e.g. "Sep 1 – Sep 9". */
function dateLabel(filter: PosOrdersFilter): string {
  const s = filter.startDate ? instantToCivil(filter.startDate) : null;
  const e = filter.endDate ? instantToCivil(filter.endDate) : null;
  if (s && e) return s === e ? shortDate(s) : `${shortDate(s)} – ${shortDate(e)}`;
  if (s) return `From ${shortDate(s)}`;
  if (e) return `Until ${shortDate(e)}`;
  return 'Any date';
}

function DateFilter({
  filter,
  hrefWith,
  router,
}: {
  filter: PosOrdersFilter;
  hrefWith: (patch: Record<string, string | null>) => string;
  router: ReturnType<typeof useRouter>;
}) {
  const dateActive = filter.startDate != null || filter.endDate != null;
  const [open, setOpen] = useState(false);
  // The calendar works in civil days; the applied filter holds instants. Convert
  // in on read and out on apply so the picker matches the local times listed.
  const appliedRange: DateRange = {
    start: filter.startDate ? instantToCivil(filter.startDate) : null,
    end: filter.endDate ? instantToCivil(filter.endDate) : null,
  };
  const [range, setRange] = useState<DateRange>(appliedRange);

  // Re-sync the draft when the applied filter changes (navigation, Clear, etc.).
  useEffect(() => {
    setRange({
      start: filter.startDate ? instantToCivil(filter.startDate) : null,
      end: filter.endDate ? instantToCivil(filter.endDate) : null,
    });
  }, [filter.startDate, filter.endDate]);

  function apply() {
    if (!range.start) return;
    // A lone start with no end reads as a single day; mirror it to both bounds.
    const endCivil = range.end ?? range.start;
    router.push(
      hrefWith({from: civilStartInstant(range.start), to: civilEndInstant(endCivil)}),
      {scroll: false},
    );
    setOpen(false);
  }

  function reset() {
    setRange({start: null, end: null});
    router.push(hrefWith({from: null, to: null}), {scroll: false});
    setOpen(false);
  }

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        className={cn(
          'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors',
          dateActive ? 'border-primary/50 text-foreground' : 'text-muted-foreground hover:text-foreground',
        )}
      >
        <CalendarDays className="size-3" />
        {dateLabel(filter)}
        <ChevronDown className="size-3 opacity-60" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="start" sideOffset={8}>
          <Popover.Popup className="z-50 w-72 rounded-lg border bg-popover p-4 text-popover-foreground shadow-md outline-none">
            <div className="mb-3 flex items-center justify-between">
              <span className="text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
                {range.start && !range.end ? 'Pick an end date' : 'Date range'}
              </span>
              {(range.start || range.end) && (
                <button
                  type="button"
                  onClick={reset}
                  className="text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
                >
                  Reset
                </button>
              )}
            </div>

            <Calendar value={range} onChange={setRange} />

            <Button size="sm" className="mt-3 w-full" onClick={apply} disabled={!range.start}>
              Apply
            </Button>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

function PriceFilter({
  filter,
  bounds,
  hrefWith,
  router,
}: {
  filter: PosOrdersFilter;
  bounds: PriceBounds;
  hrefWith: (patch: Record<string, string | null>) => string;
  router: ReturnType<typeof useRouter>;
}) {
  const priceActive = filter.minPrice != null || filter.maxPrice != null;
  const shownMin = filter.minPrice ?? bounds.min;
  const shownMax = filter.maxPrice ?? bounds.max;
  const step = bounds.max > 200 ? 10 : 1;

  const [open, setOpen] = useState(false);
  const [range, setRange] = useState<[number, number]>([shownMin, shownMax]);

  // Re-sync the draft when the applied filter or dataset bounds change (e.g.
  // after navigation, or a Clear filters press elsewhere in the bar).
  useEffect(() => {
    setRange([shownMin, shownMax]);
  }, [shownMin, shownMax]);

  function clamp(n: number): number {
    if (!Number.isFinite(n)) return bounds.min;
    return Math.min(bounds.max, Math.max(bounds.min, Math.round(n)));
  }

  function apply() {
    const [lo, hi] = range[0] <= range[1] ? range : [range[1], range[0]];
    router.push(
      hrefWith({
        min: lo <= bounds.min ? null : String(lo),
        max: hi >= bounds.max ? null : String(hi),
      }),
      {scroll: false},
    );
    setOpen(false);
  }

  function reset() {
    setRange([bounds.min, bounds.max]);
    router.push(hrefWith({min: null, max: null}), {scroll: false});
    setOpen(false);
  }

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        className={cn(
          'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors',
          priceActive ? 'border-primary/50 text-foreground' : 'text-muted-foreground hover:text-foreground',
        )}
      >
        <SlidersHorizontal className="size-3" />
        {priceActive ? `${formatPeso(shownMin)} – ${formatPeso(shownMax)}` : 'Any price'}
        <ChevronDown className="size-3 opacity-60" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="start" sideOffset={8}>
          <Popover.Popup className="z-50 w-64 rounded-lg border bg-popover p-4 text-popover-foreground shadow-md outline-none">
            <div className="mb-3 flex items-center justify-between">
              <span className="text-[11px] font-medium tracking-wider text-muted-foreground uppercase">Price range</span>
              {priceActive && (
                <button
                  type="button"
                  onClick={reset}
                  className="text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
                >
                  Reset
                </button>
              )}
            </div>

            <div className="mb-1 flex items-center gap-2">
              <MoneyInput
                label="Minimum price"
                value={range[0]}
                onCommit={(n) => setRange(([, hi]) => [clamp(n), hi])}
              />
              <span className="text-muted-foreground">–</span>
              <MoneyInput
                label="Maximum price"
                value={range[1]}
                onCommit={(n) => setRange(([lo]) => [lo, clamp(n)])}
              />
            </div>

            <RangeSlider
              value={range}
              onValueChange={([lo, hi]) => setRange([lo, hi])}
              min={bounds.min}
              max={bounds.max}
              step={step}
            />

            <Button size="sm" className="mt-3 w-full" onClick={apply}>
              Apply
            </Button>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

/**
 * Event filter dropdown, shown only when the current scope has 2+ events (see
 * eventFilterScope). Lists All, each scope event, and Untagged. Like the other
 * controls it writes the `event` URL param so the server re-queries.
 */
function EventFilter({
  filter,
  options,
  hrefWith,
}: {
  filter: PosOrdersFilter;
  options: PosEvent[];
  hrefWith: (patch: Record<string, string | null>) => string;
}) {
  const [open, setOpen] = useState(false);
  const active = filter.event;
  const name = (ev: PosEvent) => ev.venue?.trim() || ev.name || 'Untitled event';
  const selected = options.find((e) => e.event_id === active);
  const currentLabel = active === 'all' ? 'All events' : active === 'untagged' ? 'Untagged' : selected ? name(selected) : 'Event';
  const rows: {value: string | null; label: string}[] = [
    {value: null, label: 'All events'},
    ...options.map((e) => ({value: e.event_id, label: name(e)})),
    {value: 'untagged', label: 'Untagged'},
  ];

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        className={cn(
          'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors',
          active !== 'all' ? 'border-primary/50 text-foreground' : 'text-muted-foreground hover:text-foreground',
        )}
      >
        <CalendarDays className="size-3" />
        {currentLabel}
        <ChevronDown className="size-3 opacity-60" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="start" sideOffset={8}>
          <Popover.Popup className="z-50 w-52 rounded-lg border bg-popover p-1 text-popover-foreground shadow-md outline-none">
            {rows.map((r) => {
              const isActive = (r.value ?? 'all') === active;
              return (
                <Link
                  key={r.value ?? 'all'}
                  href={hrefWith({event: r.value})}
                  scroll={false}
                  onClick={() => setOpen(false)}
                  className={cn(
                    'flex items-center justify-between gap-2 rounded px-2 py-1.5 text-xs transition-colors hover:bg-muted',
                    isActive && 'text-primary',
                  )}
                >
                  <span className="truncate">{r.label}</span>
                  {isActive && <Check className="size-3.5 shrink-0" />}
                </Link>
              );
            })}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** Small ₱-prefixed number field; commits on change (parent clamps the value). */
function MoneyInput({label, value, onCommit}: {label: string; value: number; onCommit: (n: number) => void}) {
  return (
    <div className="relative flex-1">
      <span className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-xs text-muted-foreground">₱</span>
      <input
        type="number"
        inputMode="numeric"
        aria-label={label}
        value={value}
        onChange={(e) => onCommit(Number(e.target.value))}
        className="h-8 w-full rounded-md border bg-background pr-2 pl-5 text-sm tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      />
    </div>
  );
}
