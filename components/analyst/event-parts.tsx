// Pieces shared by the Events list (tiles) and the per-event detail page:
// date formatting, the time-derived status pill, and the cash reconciliation box.

import type {EventRollup} from '@/src/pos-sales-types';
import {formatPeso} from '@/src/pos-format';
import {cn} from '@/lib/utils';

/** "2026-09-14" → "Sep 14, 2026". */
function dayLabel(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso + 'T00:00:00Z');
  return Number.isNaN(d.getTime())
    ? null
    : d.toLocaleDateString(undefined, {month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC'});
}

/** A single day, or "Sep 14, 2026 to Sep 16, 2026" for a multi-day run. */
export function eventDates(startsOn: string | null, endsOn: string | null): string | null {
  const start = dayLabel(startsOn);
  if (!start) return dayLabel(endsOn);
  if (!endsOn || endsOn === startsOn) return start;
  const end = dayLabel(endsOn);
  return end ? `${start} to ${end}` : start;
}

/** Status badge, time-derived rather than the raw status field: a past bazaar
 *  reads "Done", never a misleading "Active". */
export function EventStatusPill({state, className}: {state: 'upcoming' | 'ongoing' | 'past'; className?: string}) {
  const base = 'inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide';
  if (state === 'ongoing') {
    return (
      <span
        className={cn(base, 'gap-1.5 text-emerald-700 dark:text-emerald-300', className)}
        style={{backgroundColor: 'color-mix(in oklab, var(--status-good) 14%, transparent)'}}
      >
        <span className="size-1.5 rounded-full bg-[var(--status-good)]" aria-hidden /> Happening now
      </span>
    );
  }
  if (state === 'upcoming') return <span className={cn(base, 'border text-muted-foreground', className)}>Upcoming</span>;
  return <span className={cn(base, 'bg-muted text-muted-foreground', className)}>Done</span>;
}

/** Opening cash + cash sales = expected in till, plus the counted variance once
 *  the event is closed. Renders nothing when there's no cash to reconcile. */
export function CashReconciliation({rollup}: {rollup: EventRollup}) {
  const {event, revenue, cashSales, expectedCash} = rollup;
  if (event.opening_cash == null && cashSales <= 0) return null;
  const closed = event.status === 'closed';
  // Over/short once the till is counted: counted closing_cash vs expected.
  const variance = closed && event.closing_cash != null && expectedCash != null ? event.closing_cash - expectedCash : null;

  return (
    <div className="rounded-lg border border-dashed bg-muted/30 px-4 py-4 text-xs">
      <div className="mb-2 font-semibold uppercase tracking-wider text-muted-foreground">Cash reconciliation</div>
      <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-1 tabular-nums text-foreground/80">
        <span>Opening {formatPeso(event.opening_cash ?? 0)}</span>
        <span className="text-muted-foreground">+</span>
        <span>cash sales {formatPeso(cashSales)}</span>
        <span className="text-muted-foreground">=</span>
        <span className="font-medium text-foreground">{formatPeso(expectedCash ?? cashSales)} expected in till</span>
      </div>
      {revenue > cashSales && (
        <p className="mt-2 leading-relaxed text-muted-foreground">
          Card &amp; e-wallet sales ({formatPeso(revenue - cashSales)}) settle to their wallets, so they&rsquo;re not
          in the till. Total revenue is {formatPeso(revenue)}.
        </p>
      )}
      {closed && event.closing_cash != null && (
        <div className="mt-1.5 flex flex-wrap items-baseline gap-x-1.5 tabular-nums text-foreground/80">
          <span>Counted {formatPeso(event.closing_cash)}</span>
          {variance != null && (
            <span
              className="font-medium"
              style={{color: Math.abs(variance) < 0.005 ? 'var(--status-good)' : 'var(--status-warn)'}}
            >
              ({variance === 0 ? 'balanced' : `${variance > 0 ? 'over' : 'short'} ${formatPeso(Math.abs(variance))}`})
            </span>
          )}
        </div>
      )}
      {event.cash_note && <p className="mt-1.5 text-muted-foreground">{event.cash_note}</p>}
    </div>
  );
}
