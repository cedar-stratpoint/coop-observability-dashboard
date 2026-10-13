'use client';

import {useEffect, useState} from 'react';
import Link from 'next/link';
import {usePathname, useRouter, useSearchParams} from 'next/navigation';
import {Popover} from '@base-ui/react/popover';
import {CalendarDays, CalendarRange, Check, ChevronDown, CircleDot, SlidersHorizontal, Wallet, X, type LucideIcon} from 'lucide-react';
import {cn} from '@/lib/utils';
import {Button} from '@/components/ui/button';
import {RangeSlider} from '@/components/ui/slider';
import {Calendar, type DateRange} from '@/components/ui/calendar';
import {formatPeso} from '@/src/pos-format';
import {ORDER_METHOD_FILTERS, ORDER_STATUS_FILTERS} from '@/src/pos-sales-compute';
import type {PosEvent, PosOrdersFilter, PriceBounds} from '@/src/pos-sales-types';

type HrefWith = (patch: Record<string, string | null>) => string;
type Router = ReturnType<typeof useRouter>;

const POPUP =
  'z-50 origin-[var(--transform-origin)] rounded-lg border bg-popover text-popover-foreground shadow-md outline-none transition-[opacity,transform] duration-150 ease-out data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0';

const CLEARED = {method: null, status: null, event: null, from: null, to: null, min: null, max: null};

/**
 * Filter bar above the transactions list. Hick's law: the bar shows only a few
 * stable category triggers (Method, Date, Price, Status, Event) and keeps each
 * one's choices behind its own dropdown until asked for. What's applied reads
 * back as a row of removable pills plus Clear all, so the active state never
 * has to be decoded from the controls themselves.
 *
 * Every control writes to the URL search params (and resets to page 1) so the
 * server re-queries a filtered, paginated slice; the bar reads back from those
 * same params, so it's shareable and survives a refresh.
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

  const eventName = (ev: PosEvent) => ev.venue?.trim() || ev.name || 'Untitled event';
  const labelOf = (list: {value: string; label: string}[], v: string) => list.find((x) => x.value === v)?.label ?? v;
  const eventLabel =
    filter.event === 'untagged'
      ? 'Untagged'
      : (() => {
          const ev = eventOptions.find((e) => e.event_id === filter.event);
          return ev ? eventName(ev) : 'Unknown event';
        })();

  const dateActive = filter.startDate != null || filter.endDate != null;
  const priceActive = filter.minPrice != null || filter.maxPrice != null;

  // One pill per applied filter, in the same order as the triggers.
  const pills: {key: string; category: string; value: string; remove: Record<string, null>}[] = [];
  if (filter.method !== 'all')
    pills.push({key: 'method', category: 'Method', value: labelOf(ORDER_METHOD_FILTERS, filter.method), remove: {method: null}});
  if (dateActive) pills.push({key: 'date', category: 'Date', value: dateLabel(filter), remove: {from: null, to: null}});
  if (priceActive) pills.push({key: 'price', category: 'Price', value: priceLabel(filter), remove: {min: null, max: null}});
  if (filter.status !== 'all')
    pills.push({key: 'status', category: 'Status', value: labelOf(ORDER_STATUS_FILTERS, filter.status), remove: {status: null}});
  if (filter.event !== 'all') pills.push({key: 'event', category: 'Event', value: eventLabel, remove: {event: null}});

  /** The "All" row of a constant list becomes a null ("any") option. */
  const anyFirst = (list: {value: string; label: string}[], anyLabel: string) =>
    list.map((m) => ({value: m.value === 'all' ? null : m.value, label: m.value === 'all' ? anyLabel : m.label}));

  return (
    <div className="mb-4 flex flex-col gap-3">
      <div role="toolbar" aria-label="Filter transactions" className="flex flex-wrap items-center gap-2">
        <OptionMenu
          icon={Wallet}
          label="Method"
          options={anyFirst(ORDER_METHOD_FILTERS, 'Any method')}
          selected={filter.method === 'all' ? null : filter.method}
          hrefFor={(v) => hrefWith({method: v})}
        />
        <DateFilter filter={filter} active={dateActive} hrefWith={hrefWith} router={router} />
        <PriceFilter filter={filter} active={priceActive} bounds={bounds} hrefWith={hrefWith} router={router} />
        <OptionMenu
          icon={CircleDot}
          label="Status"
          options={anyFirst(ORDER_STATUS_FILTERS, 'Any status')}
          selected={filter.status === 'all' ? null : filter.status}
          hrefFor={(v) => hrefWith({status: v})}
        />
        {showEventFilter && (
          <OptionMenu
            icon={CalendarRange}
            label="Event"
            options={[
              {value: null, label: 'All events'},
              ...eventOptions.map((e) => ({value: e.event_id, label: eventName(e)})),
              {value: 'untagged', label: 'Untagged'},
            ]}
            selected={filter.event === 'all' ? null : filter.event}
            hrefFor={(v) => hrefWith({event: v})}
            width="w-60"
          />
        )}
      </div>

      {pills.length > 0 && (
        <ul aria-label="Applied filters" className="flex flex-wrap items-center gap-2">
          {pills.map((p) => (
            <li
              key={p.key}
              className="inline-flex h-7 max-w-full items-center gap-1.5 rounded-full border border-primary/25 bg-primary/8 pr-1 pl-3 text-xs transition-[opacity,transform] duration-150 ease-out starting:scale-95 starting:opacity-0"
            >
              <span className="shrink-0 text-muted-foreground">{p.category}</span>
              <span className="min-w-0 truncate font-medium text-foreground">{p.value}</span>
              <Link
                href={hrefWith(p.remove)}
                scroll={false}
                aria-label={`Remove ${p.category} filter: ${p.value}`}
                title={`Remove ${p.category} filter`}
                className="grid size-5 shrink-0 place-items-center rounded-full text-muted-foreground transition-[color,background-color,transform] duration-150 ease-out hover:bg-primary/15 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none active:scale-90"
              >
                <X className="size-3" aria-hidden />
              </Link>
            </li>
          ))}
          <li>
            <Link
              href={hrefWith(CLEARED)}
              scroll={false}
              className="inline-flex h-7 items-center rounded-md px-2 text-xs font-medium text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline"
            >
              Clear all
            </Link>
          </li>
        </ul>
      )}
    </div>
  );
}

/** Shared look for every category trigger: a stable label, plus a dot when applied. */
function triggerClass(active: boolean) {
  return cn(
    'inline-flex h-8 items-center gap-1.5 rounded-lg border bg-card px-3 text-xs font-medium transition-[color,border-color,transform] duration-150 ease-out active:scale-[0.97] data-[popup-open]:border-foreground/30 data-[popup-open]:text-foreground',
    active ? 'border-primary/40 text-foreground' : 'text-muted-foreground hover:border-foreground/20 hover:text-foreground',
  );
}

function TriggerContent({icon: Icon, label, active}: {icon: LucideIcon; label: string; active: boolean}) {
  return (
    <>
      <Icon className="size-3.5" aria-hidden />
      {label}
      {active && (
        <>
          <span className="size-1.5 rounded-full bg-primary" aria-hidden />
          <span className="sr-only">(applied)</span>
        </>
      )}
      <ChevronDown className="size-3 opacity-60" aria-hidden />
    </>
  );
}

/** A single-choice dropdown (Method, Status, Event): picking a row applies it. */
function OptionMenu({
  icon,
  label,
  options,
  selected,
  hrefFor,
  width = 'w-48',
}: {
  icon: LucideIcon;
  label: string;
  options: {value: string | null; label: string}[];
  selected: string | null;
  hrefFor: (value: string | null) => string;
  width?: string;
}) {
  const [open, setOpen] = useState(false);
  const active = selected != null;
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger className={triggerClass(active)}>
        <TriggerContent icon={icon} label={label} active={active} />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="start" sideOffset={6}>
          <Popover.Popup className={cn(POPUP, width, 'max-h-80 overflow-y-auto p-1')}>
            {options.map((o, i) => {
              const isActive = o.value === selected;
              return (
                <div key={o.value ?? 'any'}>
                  <Link
                    href={hrefFor(o.value)}
                    scroll={false}
                    onClick={() => setOpen(false)}
                    aria-current={isActive ? 'true' : undefined}
                    className={cn(
                      'flex items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-xs transition-colors hover:bg-muted',
                      isActive ? 'font-medium text-foreground' : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    <span className="truncate">{o.label}</span>
                    {isActive && <Check className="size-3.5 shrink-0 text-primary" aria-hidden />}
                  </Link>
                  {/* Divider after the "any" row so the real choices read as one group. */}
                  {i === 0 && o.value === null && <div className="mx-2 my-1 h-px bg-border" />}
                </div>
              );
            })}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** Header row inside a filter popover: caption on the left, Reset on the right. */
function PopupHeader({title, onReset}: {title: string; onReset?: () => void}) {
  return (
    <div className="mb-3 flex items-center justify-between">
      <span className="text-[11px] font-medium tracking-wider text-muted-foreground uppercase">{title}</span>
      {onReset && (
        <button type="button" onClick={onReset} className="text-xs font-medium text-muted-foreground transition-colors hover:text-foreground">
          Reset
        </button>
      )}
    </div>
  );
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** An ISO instant → the calendar day it falls on in the viewer's timezone. */
function instantToCivil(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Today shifted by `days` → a viewer-local civil day. */
function civilDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
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

/** One-click ranges, in viewer-local civil days (inclusive). */
const DATE_PRESETS: {label: string; start: () => string; end: () => string}[] = [
  {label: 'Today', start: () => civilDaysAgo(0), end: () => civilDaysAgo(0)},
  {label: 'Yesterday', start: () => civilDaysAgo(1), end: () => civilDaysAgo(1)},
  {label: 'Last 7 days', start: () => civilDaysAgo(6), end: () => civilDaysAgo(0)},
  {label: 'Last 30 days', start: () => civilDaysAgo(29), end: () => civilDaysAgo(0)},
];

/** The applied from/to as civil days (null when unset). */
function appliedCivil(filter: PosOrdersFilter): DateRange {
  return {
    start: filter.startDate ? instantToCivil(filter.startDate) : null,
    end: filter.endDate ? instantToCivil(filter.endDate) : null,
  };
}

/** Human label for the applied range: a preset name, "Sep 1 to Sep 9", or one day. */
function dateLabel(filter: PosOrdersFilter): string {
  const {start: s, end: e} = appliedCivil(filter);
  const preset = DATE_PRESETS.find((p) => p.start() === s && p.end() === e);
  if (preset) return preset.label;
  if (s && e) return s === e ? shortDate(s) : `${shortDate(s)} to ${shortDate(e)}`;
  if (s) return `From ${shortDate(s)}`;
  if (e) return `Until ${shortDate(e)}`;
  return 'Any date';
}

/** "₱100 to ₱500", "₱100 and up", or "Up to ₱500". */
function priceLabel(filter: PosOrdersFilter): string {
  const {minPrice: lo, maxPrice: hi} = filter;
  if (lo != null && hi != null) return `${formatPeso(lo)} to ${formatPeso(hi)}`;
  if (lo != null) return `${formatPeso(lo)} and up`;
  if (hi != null) return `Up to ${formatPeso(hi)}`;
  return 'Any price';
}

function DateFilter({filter, active, hrefWith, router}: {filter: PosOrdersFilter; active: boolean; hrefWith: HrefWith; router: Router}) {
  const [open, setOpen] = useState(false);
  // The calendar works in civil days; the applied filter holds instants. Convert
  // in on read and out on apply so the picker matches the local times listed.
  const [range, setRange] = useState<DateRange>(appliedCivil(filter));

  // Re-sync the draft when the applied filter changes (navigation, pill removal, Clear all).
  useEffect(() => {
    setRange(appliedCivil(filter));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only the date bounds matter
  }, [filter.startDate, filter.endDate]);

  function push(start: string, end: string) {
    router.push(hrefWith({from: civilStartInstant(start), to: civilEndInstant(end)}), {scroll: false});
    setOpen(false);
  }

  function apply() {
    if (!range.start) return;
    // A lone start with no end reads as a single day; mirror it to both bounds.
    push(range.start, range.end ?? range.start);
  }

  function reset() {
    setRange({start: null, end: null});
    router.push(hrefWith({from: null, to: null}), {scroll: false});
    setOpen(false);
  }

  const applied = appliedCivil(filter);

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger className={triggerClass(active)}>
        <TriggerContent icon={CalendarDays} label="Date" active={active} />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="start" sideOffset={6}>
          <Popover.Popup className={cn(POPUP, 'w-72 p-4')}>
            <PopupHeader title="Quick ranges" onReset={range.start || range.end ? reset : undefined} />
            <div className="mb-4 grid grid-cols-2 gap-1.5">
              {DATE_PRESETS.map((p) => {
                const isActive = applied.start === p.start() && applied.end === p.end();
                return (
                  <button
                    key={p.label}
                    type="button"
                    onClick={() => push(p.start(), p.end())}
                    aria-pressed={isActive}
                    className={cn(
                      'h-8 rounded-md border px-2 text-xs font-medium transition-[color,background-color,border-color,transform] duration-150 ease-out active:scale-[0.97]',
                      isActive
                        ? 'border-primary/40 bg-primary/10 text-foreground'
                        : 'text-muted-foreground hover:border-foreground/20 hover:text-foreground',
                    )}
                  >
                    {p.label}
                  </button>
                );
              })}
            </div>

            <div className="mb-3 border-t pt-3 text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
              {range.start && !range.end ? 'Pick an end date' : 'Custom range'}
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
  active,
  bounds,
  hrefWith,
  router,
}: {
  filter: PosOrdersFilter;
  active: boolean;
  bounds: PriceBounds;
  hrefWith: HrefWith;
  router: Router;
}) {
  const shownMin = filter.minPrice ?? bounds.min;
  const shownMax = filter.maxPrice ?? bounds.max;
  const step = bounds.max > 200 ? 10 : 1;

  const [open, setOpen] = useState(false);
  const [range, setRange] = useState<[number, number]>([shownMin, shownMax]);

  // Re-sync the draft when the applied filter or dataset bounds change (e.g.
  // after navigation, a pill removal, or Clear all).
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
      <Popover.Trigger className={triggerClass(active)}>
        <TriggerContent icon={SlidersHorizontal} label="Price" active={active} />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="start" sideOffset={6}>
          <Popover.Popup className={cn(POPUP, 'w-64 p-4')}>
            <PopupHeader title="Order total" onReset={active ? reset : undefined} />

            <div className="mb-1 flex items-center gap-2">
              <MoneyInput label="Minimum price" value={range[0]} onCommit={(n) => setRange(([, hi]) => [clamp(n), hi])} />
              <span className="text-xs text-muted-foreground">to</span>
              <MoneyInput label="Maximum price" value={range[1]} onCommit={(n) => setRange(([lo]) => [lo, clamp(n)])} />
            </div>

            <RangeSlider value={range} onValueChange={([lo, hi]) => setRange([lo, hi])} min={bounds.min} max={bounds.max} step={step} />

            <Button size="sm" className="mt-3 w-full" onClick={apply}>
              Apply
            </Button>
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
