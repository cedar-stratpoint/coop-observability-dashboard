'use client';

import {useState, useTransition} from 'react';
import {useRouter} from 'next/navigation';
import {ArrowLeftRight} from 'lucide-react';
import {cn} from '@/lib/utils';
import {Button} from '@/components/ui/button';
import {Calendar, type DateRange} from '@/components/ui/calendar';
import {dayKeysBetween, rangeLabel} from '../../src/chat/range';
import type {SalesRangeView} from '../../src/sales-range';

const href = (from: string, to: string) => `/sales-range?from=${from}&to=${to}`;

/**
 * Pick any dates across weeks (Monday first, so a calendar row is one stored week), or "All time".
 * The URL carries the range, so a reload or a shared link shows the same view.
 */
export function SalesRangePicker({view}: {view: Pick<SalesRangeView, 'fromDay' | 'toDay' | 'all' | 'bounds' | 'snap' | 'label' | 'dayCount'>}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [range, setRange] = useState<DateRange>({start: view.fromDay, end: view.toDay});
  const go = (to: string) => start(() => router.push(to, {scroll: false}));

  const picked = range.start ? dayKeysBetween(range.start, range.end ?? range.start) : [];
  const summary = !range.start ? 'Pick a start date' : !range.end ? 'Pick an end date, or Apply for one day' : `${rangeLabel(range.start, range.end)} · ${picked.length} ${picked.length === 1 ? 'day' : 'days'}`;

  return (
    <div className="flex flex-col gap-4" aria-busy={pending}>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => go('/sales-range?span=all')}
          aria-pressed={view.all}
          disabled={pending}
          className={cn(
            'rounded-full border px-3 py-1 text-xs font-medium transition-colors duration-150 ease-out active:scale-[0.97]',
            view.all ? 'border-primary bg-primary/10 text-foreground' : 'border-border bg-card text-muted-foreground hover:text-foreground',
          )}
        >
          All time
        </button>
        {view.snap && !view.all && (
          <button
            type="button"
            onClick={() => go(href(view.snap!.fromDay, view.snap!.toDay))}
            disabled={pending}
            className="inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors duration-150 ease-out active:scale-[0.97]"
            style={{background: 'var(--amber-bg)', color: 'var(--amber-fg)', borderColor: 'color-mix(in oklab, var(--amber-fg) 35%, transparent)'}}
          >
            <ArrowLeftRight className="size-3" />
            Snap to whole weeks: {view.snap.label}
          </button>
        )}
      </div>

      <Calendar value={range} onChange={setRange} min={view.bounds.min} max={view.bounds.max} weekStartsOn={1} />

      <p className="text-sm tabular-nums text-foreground" aria-live="polite">{summary}</p>
      <p className="text-xs leading-relaxed text-muted-foreground">
        Sales, orders, units and AOV are exact for the days you pick. Ad spend, ROAS and top products only exist per whole export window, so they use the windows that sit entirely inside your dates.
      </p>
      <div className="flex gap-2">
        <Button size="sm" disabled={!range.start || pending} onClick={() => range.start && go(href(range.start, range.end ?? range.start))}>
          {pending ? 'Loading' : 'Apply'}
        </Button>
        <Button size="sm" variant="outline" disabled={pending} onClick={() => go('/sales-range')}>
          Last 4 weeks
        </Button>
      </div>
    </div>
  );
}
