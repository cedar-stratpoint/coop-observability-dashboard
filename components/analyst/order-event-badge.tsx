'use client';

import {useState, useTransition} from 'react';
import {useRouter} from 'next/navigation';
import {Popover} from '@base-ui/react/popover';
import {CalendarDays, Check, ChevronDown, Loader2} from 'lucide-react';
import type {PosEvent, PosOrder} from '@/src/pos-sales-types';
import {reassignOrderEventAction} from '@/src/pos-events-actions';
import {eventsCoveringOrder} from '@/src/pos-sales-compute';
import {cn} from '@/lib/utils';

function eventName(ev?: PosEvent | null): string {
  return ev ? ev.venue?.trim() || ev.name || 'Untitled event' : 'Untagged';
}

/**
 * Per-transaction event badge on the Coop Transactions tab. Shows which event a
 * sale is in (or Untagged). It doubles as the reassign control (reassign lives
 * only here now, not on the events page), but only when the sale's day has 2+
 * overlapping events, matching the "proper conditions" rule, offering exactly
 * those events plus Untagged. On an unambiguous day it's a static label; on a
 * normal non-event day with no event at all it renders nothing.
 */
export function OrderEventBadge({order, events}: {order: PosOrder; events: PosEvent[]}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  const current = events.find((e) => e.event_id === order.event_id) ?? null;
  const overlapping = eventsCoveringOrder(order, events);
  const canReassign = overlapping.length >= 2;

  const badgeCls = cn(
    'inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium',
    current ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground',
  );

  if (!canReassign) {
    // Nothing to show on a normal non-event sale; otherwise a static label.
    if (!current && overlapping.length === 0) return null;
    return (
      <span className={badgeCls}>
        <CalendarDays className="size-3" /> {eventName(current)}
      </span>
    );
  }

  function move(eventId: string | null) {
    if (eventId === (order.event_id ?? null)) {
      setOpen(false);
      return;
    }
    startTransition(async () => {
      const res = await reassignOrderEventAction(order.id, eventId);
      if (res.ok) router.refresh();
      setOpen(false);
    });
  }

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger className={cn(badgeCls, 'transition-opacity hover:opacity-80')} aria-label="Reassign event">
        <CalendarDays className="size-3" /> {eventName(current)}
        {pending ? <Loader2 className="size-3 animate-spin" /> : <ChevronDown className="size-3 opacity-60" />}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="start" sideOffset={6}>
          <Popover.Popup className="z-50 w-52 rounded-lg border bg-popover p-1 text-popover-foreground shadow-md outline-none">
            <p className="px-2 py-1 text-[11px] font-medium tracking-wider text-muted-foreground uppercase">Move to event</p>
            {overlapping.map((ev) => (
              <button
                key={ev.event_id}
                type="button"
                onClick={() => move(ev.event_id)}
                className="flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-xs transition-colors hover:bg-muted"
              >
                <span className="truncate">{eventName(ev)}</span>
                {ev.event_id === order.event_id && <Check className="size-3.5 shrink-0 text-primary" />}
              </button>
            ))}
            <button
              type="button"
              onClick={() => move(null)}
              className="flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-xs transition-colors hover:bg-muted"
            >
              <span className="text-muted-foreground">Untagged</span>
              {order.event_id == null && <Check className="size-3.5 shrink-0 text-primary" />}
            </button>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
