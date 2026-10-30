'use client';

import {useEffect, useState} from 'react';
import {usePathname, useRouter, useSearchParams} from 'next/navigation';
import {Popover} from '@base-ui/react/popover';
import {ArrowLeftRight, CalendarDays, ChevronDown, X} from 'lucide-react';
import {cn} from '@/lib/utils';
import {Button} from '@/components/ui/button';
import {Calendar, type DateRange} from '@/components/ui/calendar';
import {dayKeysBetween, rangeLabel} from '../../src/chat/range';
import {resolveSpan, snapToWeeks} from '../../src/sales-range';

/**
 * "Custom dates" beside the reporting-period switcher. Any day with data up to today, or "All time", via `?from=&to=` (YYYY-MM-DD,
 * PH days) or `?span=all`. The Sales page then shows that span instead of one week (src/sales-range.ts). The calendar starts on
 * Monday so a row is one stored week; "Snap to whole weeks" moves dates that cut a week out to whole weeks, only on a click.
 */
export function CustomRangePicker({min, max}: {min: string; max: string}) {
  const router = useRouter();
  const pathname = usePathname() || '/';
  const searchParams = useSearchParams();
  const from = searchParams.get('from');
  const to = searchParams.get('to');
  // No week, dates or span in the link means Sales is on All time (app/page.tsx), so it is listed as selected.
  const all = searchParams.get('span') === 'all' || (!from && !to && !searchParams.get('week'));
  const active = all || Boolean(from && to);
  const resolved = from && to ? resolveSpan({from, to}, {firstDay: min, todayDay: max}) : null;

  const [open, setOpen] = useState(false);
  const [range, setRange] = useState<DateRange>({start: resolved?.fromDay ?? null, end: resolved?.toDay ?? null});
  useEffect(() => setRange({start: resolved?.fromDay ?? null, end: resolved?.toDay ?? null}), [resolved?.fromDay, resolved?.toDay]);

  function push(next: {from: string; to: string} | 'all' | null) {
    const params = new URLSearchParams(searchParams.toString());
    for (const k of ['from', 'to', 'span']) params.delete(k);
    if (next === 'all') params.set('span', 'all');
    else if (next) {
      params.set('from', next.from);
      params.set('to', next.to);
    }
    router.push(`${pathname}?${params.toString()}`, {scroll: false});
    setOpen(false);
  }

  const snap = resolved && !all ? snapToWeeks(resolved.fromDay, resolved.toDay, {firstDay: min, todayDay: max}) : null;
  const picked = range.start ? dayKeysBetween(range.start, range.end ?? range.start) : [];
  const summary = !range.start ? 'Pick a start date' : !range.end ? 'Pick an end date, or Apply for one day' : `${rangeLabel(range.start, range.end)} · ${picked.length} ${picked.length === 1 ? 'day' : 'days'}`;
  const chip = 'rounded-full border px-3 py-1 text-xs font-medium transition-colors duration-150 ease-out active:scale-[0.97]';

  return (
    <div className="inline-flex items-center">
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger
          className={cn(
            'inline-flex items-center gap-2 rounded-full border bg-background px-3 py-1.5 text-sm transition-colors hover:bg-muted',
            active ? 'border-primary/50 pr-8 text-foreground' : 'border-border text-foreground/80',
          )}
        >
          <CalendarDays className="size-3.5 text-muted-foreground" />
          <span className={cn('text-xs', active ? 'font-mono tabular-nums' : 'font-medium')}>
            {all ? 'All time' : resolved ? rangeLabel(resolved.fromDay, resolved.toDay) : 'Custom dates'}
          </span>
          {!active && <ChevronDown className={cn('size-3.5 text-muted-foreground transition-transform', open && 'rotate-180')} />}
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Positioner side="bottom" align="start" sideOffset={8}>
            <Popover.Popup className="z-50 w-80 rounded-xl border bg-popover p-4 text-popover-foreground shadow-lg outline-none">
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <button type="button" onClick={() => push('all')} aria-pressed={all} className={cn(chip, all ? 'border-primary bg-primary/10 text-foreground' : 'border-border bg-card text-muted-foreground hover:text-foreground')}>
                  All time
                </button>
                {snap && (
                  <button
                    type="button"
                    onClick={() => push({from: snap.fromDay, to: snap.toDay})}
                    className={cn(chip, 'inline-flex items-center gap-1.5')}
                    style={{background: 'var(--amber-bg)', color: 'var(--amber-fg)', borderColor: 'color-mix(in oklab, var(--amber-fg) 35%, transparent)'}}
                  >
                    <ArrowLeftRight className="size-3" />
                    Snap to whole weeks: {rangeLabel(snap.fromDay, snap.toDay)}
                  </button>
                )}
              </div>
              <Calendar value={range} onChange={setRange} min={min} max={max} weekStartsOn={1} />
              <p className="mt-3 text-sm tabular-nums text-foreground" aria-live="polite">{summary}</p>
              <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
                Sales, orders, units and AOV are exact for the days you pick. Ad spend, ROAS and top products use the whole export windows inside your dates.
              </p>
              <div className="mt-3 flex gap-2">
                <Button size="sm" disabled={!range.start} onClick={() => range.start && push({from: range.start, to: range.end ?? range.start})}>
                  Apply
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    const last = resolveSpan({}, {firstDay: min, todayDay: max});
                    push({from: last.fromDay, to: last.toDay});
                  }}
                >
                  Last 4 weeks
                </Button>
              </div>
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
      {active && (
        <button
          type="button"
          onClick={() => push(null)}
          aria-label="Clear custom dates"
          className="-ml-7 grid size-5 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      )}
    </div>
  );
}
