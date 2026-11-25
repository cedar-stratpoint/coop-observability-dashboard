'use client';

import {useState} from 'react';
import {Popover} from '@base-ui/react/popover';
import {CalendarDays, ChevronDown, X} from 'lucide-react';
import {cn} from '@/lib/utils';
import {Calendar, type DateRange} from '@/components/ui/calendar';
import {FILTER_PILL, FILTER_PILL_ACTIVE, FILTER_PILL_IDLE, FILTER_POPUP} from '@/components/ui/filter-select';
import {rangeLabel} from '@/src/chat/range';

// One pill for an inclusive day range (YYYY-MM-DD, local days), in place of two browser
// date boxes. Opens a calendar with quick ranges; picking the second day applies it.

const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return ymd(d);
}

const PRESETS: Array<{label: string; range: () => {from: string; to: string}}> = [
  {label: 'Today', range: () => ({from: daysAgo(0), to: daysAgo(0)})},
  {label: 'Last 7 days', range: () => ({from: daysAgo(6), to: daysAgo(0)})},
  {label: 'Last 30 days', range: () => ({from: daysAgo(29), to: daysAgo(0)})},
  {
    label: 'This month',
    range: () => {
      const t = new Date();
      return {from: ymd(new Date(t.getFullYear(), t.getMonth(), 1)), to: ymd(t)};
    },
  },
];

export function DateRangeFilter({
  from,
  to,
  onChange,
  placeholder = 'Any date',
  label = 'Filter by date',
}: {
  from: string;
  to: string;
  /** Empty strings clear that end. */
  onChange: (next: {from: string; to: string}) => void;
  placeholder?: string;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<DateRange>({start: from || null, end: to || null});
  const active = Boolean(from || to);
  const text = from && to ? rangeLabel(from, to) : from ? `From ${rangeLabel(from, from)}` : to ? `Until ${rangeLabel(to, to)}` : placeholder;

  function apply(next: {from: string; to: string}) {
    onChange(next);
    setOpen(false);
  }

  return (
    <span className="relative inline-flex max-w-full">
      <Popover.Root
        open={open}
        onOpenChange={(o) => {
          if (o) setDraft({start: from || null, end: to || null});
          setOpen(o);
        }}
      >
        <Popover.Trigger aria-label={label} className={cn(FILTER_PILL, active ? cn(FILTER_PILL_ACTIVE, 'pr-8') : FILTER_PILL_IDLE)}>
          <CalendarDays aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          <span className={cn('truncate', active && 'tabular-nums')}>{text}</span>
          {!active && (
            <ChevronDown aria-hidden className="size-3.5 text-muted-foreground transition-transform duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] group-data-[popup-open]:rotate-180" />
          )}
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Positioner side="bottom" align="start" sideOffset={6} collisionPadding={16} className="z-50 outline-none">
            <Popover.Popup className={cn(FILTER_POPUP, 'flex w-[min(30rem,calc(100vw-2rem))] gap-1 p-2 max-sm:flex-col')}>
              <div role="group" aria-label="Quick ranges" className="flex shrink-0 flex-col gap-0.5 border-border p-1 max-sm:flex-row max-sm:flex-wrap sm:w-32 sm:border-r sm:pr-2">
                {PRESETS.map((p) => {
                  const r = p.range();
                  const on = r.from === from && r.to === to;
                  return (
                    <button
                      key={p.label}
                      type="button"
                      onClick={() => apply(r)}
                      aria-pressed={on}
                      className={cn(
                        'rounded-lg px-2.5 py-1.5 text-left text-sm transition-[background-color,color,scale] duration-100 active:scale-[0.97] motion-reduce:active:scale-100',
                        on ? 'bg-primary/12 font-medium text-foreground' : 'text-foreground/80 hover:bg-muted hover:text-foreground',
                      )}
                    >
                      {p.label}
                    </button>
                  );
                })}
                {active && (
                  <button
                    type="button"
                    onClick={() => apply({from: '', to: ''})}
                    className="rounded-lg px-2.5 py-1.5 text-left text-sm text-muted-foreground transition-colors duration-100 hover:bg-muted hover:text-foreground"
                  >
                    Any date
                  </button>
                )}
              </div>
              <div className="flex min-w-0 flex-1 flex-col gap-2 p-2">
                <Calendar
                  value={draft}
                  onChange={(r) => {
                    setDraft(r);
                    if (r.start && r.end) apply({from: r.start, to: r.end});
                  }}
                />
                <div className="flex items-center justify-between gap-2 border-t pt-2.5">
                  <p className="text-xs text-muted-foreground" aria-live="polite">
                    {draft.start && !draft.end ? 'Pick the last day, or use one day.' : 'Pick the first day.'}
                  </p>
                  {draft.start && !draft.end && (
                    <button
                      type="button"
                      onClick={() => draft.start && apply({from: draft.start, to: draft.start})}
                      className="shrink-0 rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground transition-[filter,scale] duration-100 hover:brightness-110 active:scale-[0.97]"
                    >
                      Just {rangeLabel(draft.start, draft.start)}
                    </button>
                  )}
                </div>
              </div>
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
      {active && (
        <button
          type="button"
          onClick={() => onChange({from: '', to: ''})}
          aria-label="Clear dates"
          className="absolute top-1/2 right-1.5 grid size-5 -translate-y-1/2 place-items-center rounded-full text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground"
        >
          <X className="size-3" />
        </button>
      )}
    </span>
  );
}
