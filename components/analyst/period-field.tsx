'use client';

import {useState} from 'react';
import {Popover} from '@base-ui/react/popover';
import {CalendarDays, ChevronDown} from 'lucide-react';
import {cn} from '@/lib/utils';
import {Calendar, type DateRange} from '@/components/ui/calendar';
import {halfMonths, periodLabel} from '@/src/period-date';

// The page review's Period (QA Nov 27): one field for the form's cut-off instead of two browser date
// boxes, whose popup can't be styled. It opens the app's own range calendar with the two half-month
// cut-offs of the month on screen one tap away (a Nichido form always covers 1 to 15 or 16 to the
// end). A finished pick sets both dates and closes.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function PeriodField({
  start,
  end,
  onChange,
  disabled,
  labelId,
}: {
  start: string | null;
  end: string | null;
  onChange: (start: string, end: string) => void;
  disabled?: boolean;
  /** The visible label's id, so the button is announced as the Period field. */
  labelId?: string;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<DateRange>({start, end});
  const anchor = start ?? end ?? new Date().toISOString().slice(0, 10);
  const [month, setMonth] = useState<{y: number; m: number}>({y: Number(anchor.slice(0, 4)), m: Number(anchor.slice(5, 7)) - 1});

  function openChange(next: boolean) {
    if (next) {
      // Start each visit from the field's dates, on their month.
      setDraft({start, end});
      setMonth({y: Number(anchor.slice(0, 4)), m: Number(anchor.slice(5, 7)) - 1});
    }
    setOpen(next);
  }
  function commit(s: string, e: string) {
    onChange(s, e);
    setOpen(false);
  }

  const label = start && end ? periodLabel(start, end) : start ? `${periodLabel(start, start)} to …` : null;
  const halves = halfMonths(month.y, month.m);
  const chip = 'rounded-full border px-3 py-1 text-xs font-medium tabular-nums transition-[background-color,color,border-color,transform] duration-150 ease-out active:scale-[0.97] focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/40';

  return (
    <Popover.Root open={open} onOpenChange={openChange}>
      <Popover.Trigger
        disabled={disabled}
        aria-labelledby={labelId}
        aria-describedby={labelId ? `${labelId}-value` : undefined}
        className={cn(
          'group flex h-10 w-full min-w-0 items-center gap-2.5 rounded-lg border border-border bg-background px-3 text-left text-sm outline-none transition-colors',
          'hover:border-foreground/25 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40',
          'disabled:cursor-default disabled:opacity-60 disabled:hover:border-border',
          open && 'border-ring',
        )}
      >
        <CalendarDays className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span id={labelId ? `${labelId}-value` : undefined} className={cn('min-w-0 flex-1 truncate tabular-nums', !label && 'text-muted-foreground')}>
          {label ?? 'Pick the period'}
        </span>
        {!disabled && <ChevronDown className={cn('size-4 shrink-0 text-muted-foreground transition-transform duration-150 ease-out motion-reduce:transition-none', open && 'rotate-180')} aria-hidden />}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="start" sideOffset={8} collisionPadding={16}>
          <Popover.Popup className="z-50 w-[19.5rem] origin-[var(--transform-origin)] rounded-xl border border-border bg-popover p-4 text-popover-foreground shadow-[0_12px_32px_-12px_rgb(0_0_0/0.45)] outline-none transition-[opacity,transform] duration-150 ease-out data-[ending-style]:scale-[0.98] data-[ending-style]:opacity-0 data-[starting-style]:scale-[0.98] data-[starting-style]:opacity-0 motion-reduce:transition-none">
            <div className="mb-4 flex flex-wrap gap-2" role="group" aria-label="Half-month cut-offs">
              {halves.map((h) => {
                const on = draft.start === h.start && draft.end === h.end;
                return (
                  <button
                    key={h.start}
                    type="button"
                    onClick={() => commit(h.start, h.end)}
                    aria-pressed={on}
                    className={cn(chip, on ? 'border-primary bg-primary/10 text-foreground' : 'border-border bg-card text-muted-foreground hover:text-foreground')}
                  >
                    {MONTHS[month.m]} {h.label}
                  </button>
                );
              })}
            </div>
            <Calendar
              value={draft}
              onChange={(next) => {
                setDraft(next);
                if (next.start && next.end) commit(next.start, next.end);
              }}
              onMonthChange={(y, m) => setMonth({y, m})}
            />
            <p className="mt-3 text-xs text-muted-foreground" aria-live="polite">
              {draft.start && !draft.end ? 'Now pick the last day.' : 'Pick the first and last day, or a cut-off above.'}
            </p>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
