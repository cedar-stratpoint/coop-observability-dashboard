'use client';

import {useState} from 'react';
import {ChevronLeft, ChevronRight} from 'lucide-react';
import {cn} from '@/lib/utils';

export interface DateRange {
  start: string | null; // YYYY-MM-DD
  end: string | null; // YYYY-MM-DD
}

const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
export type WeekStart = 0 | 1; // 0 = Sunday first (default), 1 = Monday first
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (y: number, m: number, d: number) => `${y}-${pad(m + 1)}-${pad(d)}`;

/** The user's local "today" as a calendar date (matches what the list shows). */
function todayYmd(): string {
  const t = new Date();
  return ymd(t.getFullYear(), t.getMonth(), t.getDate());
}

/** Days in a month and the weekday its 1st falls on (0=Sun), computed in UTC. */
function monthGrid(year: number, month: number, weekStartsOn: WeekStart): {leading: number; days: number} {
  const leading = (new Date(Date.UTC(year, month, 1)).getUTCDay() - weekStartsOn + 7) % 7;
  const days = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return {leading, days};
}

/**
 * A single-month range calendar. Two picks define an inclusive [start, end]
 * range; a third pick starts over. Future days are disabled by default (a sale
 * can't be dated ahead; `allowFuture` lifts that for scheduling), as are days
 * outside the optional `min`/`max` (YYYY-MM-DD, inclusive). Fully themed from
 * the design tokens and keyboard-operable.
 */
export function Calendar({value, onChange, min, max, allowFuture = false, weekStartsOn = 0}: {value: DateRange; onChange: (next: DateRange) => void; min?: string; max?: string; allowFuture?: boolean; weekStartsOn?: WeekStart}) {
  const today = todayYmd();
  const anchor = value.end ?? value.start ?? min ?? today;
  const [ay, am] = anchor.split('-').map(Number);
  const [view, setView] = useState<{y: number; m: number}>({y: ay, m: am - 1});

  const {leading, days} = monthGrid(view.y, view.m, weekStartsOn);
  const weekdays = [...WEEKDAYS.slice(weekStartsOn), ...WEEKDAYS.slice(0, weekStartsOn)];
  const cells: (string | null)[] = [
    ...Array.from({length: leading}, () => null),
    ...Array.from({length: days}, (_, i) => ymd(view.y, view.m, i + 1)),
  ];

  function step(delta: number) {
    setView((v) => {
      const next = new Date(Date.UTC(v.y, v.m + delta, 1));
      return {y: next.getUTCFullYear(), m: next.getUTCMonth()};
    });
  }

  function pick(day: string) {
    if (!value.start || (value.start && value.end)) {
      onChange({start: day, end: null});
    } else if (day < value.start) {
      onChange({start: day, end: value.start});
    } else {
      onChange({start: value.start, end: day});
    }
  }

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <button
          type="button"
          onClick={() => step(-1)}
          aria-label="Previous month"
          className="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <ChevronLeft className="size-4" />
        </button>
        <span className="text-sm font-medium tabular-nums">{MONTHS[view.m]} {view.y}</span>
        <button
          type="button"
          onClick={() => step(1)}
          aria-label="Next month"
          className="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <ChevronRight className="size-4" />
        </button>
      </div>

      <div className="grid grid-cols-7 gap-y-1">
        {weekdays.map((w) => (
          <div key={w} className="grid h-7 place-items-center text-[11px] font-medium text-muted-foreground">
            {w}
          </div>
        ))}
        {cells.map((day, i) => {
          if (!day) return <div key={`e${i}`} />;
          const dayNum = Number(day.slice(8));
          const isStart = day === value.start;
          const isEnd = day === value.end;
          const inRange = value.start && value.end && day > value.start && day < value.end;
          const isToday = day === today;
          const disabled = (!allowFuture && day > today) || (min != null && day < min) || (max != null && day > max);
          const endpoint = isStart || isEnd;
          return (
            <div
              key={day}
              className={cn(
                'grid place-items-center',
                inRange && 'bg-primary/15',
                isStart && value.end && 'rounded-l-md bg-primary/15',
                isEnd && value.start && 'rounded-r-md bg-primary/15',
              )}
            >
              <button
                type="button"
                disabled={disabled}
                onClick={() => pick(day)}
                aria-label={`${MONTHS[view.m]} ${dayNum}, ${view.y}`}
                aria-pressed={endpoint || Boolean(inRange)}
                className={cn(
                  'grid size-8 place-items-center rounded-md text-sm tabular-nums outline-none transition-colors',
                  'focus-visible:ring-2 focus-visible:ring-ring/50',
                  disabled && 'cursor-not-allowed text-muted-foreground/30',
                  !disabled && !endpoint && 'hover:bg-muted',
                  !endpoint && !inRange && !disabled && 'text-foreground',
                  inRange && 'text-foreground',
                  endpoint && 'bg-primary font-medium text-primary-foreground hover:bg-primary',
                  isToday && !endpoint && 'ring-1 ring-inset ring-border',
                )}
              >
                {dayNum}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
