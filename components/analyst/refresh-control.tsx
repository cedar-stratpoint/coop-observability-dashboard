'use client';

import {useEffect, useState, useTransition} from 'react';
import {useRouter} from 'next/navigation';
import {RefreshCw} from 'lucide-react';
import {cn} from '@/lib/utils';

/** "just now" / "3 mins ago" / "at 2:45 PM" from a fetch timestamp. */
function relativeLabel(fetchedAtMs: number, now: number): string {
  const secs = Math.max(0, Math.round((now - fetchedAtMs) / 1000));
  if (secs < 10) return 'just now';
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} min${mins === 1 ? '' : 's'} ago`;
  return `at ${new Date(fetchedAtMs).toLocaleTimeString(undefined, {hour: 'numeric', minute: '2-digit'})}`;
}

/**
 * Re-fetch the page's server data in place (no full reload) and show when it was
 * last loaded. `fetchedAt` is stamped by the server on each render, so after a
 * refresh it resets to "just now"; between refreshes the label ticks up.
 *
 * `beforeRefresh` runs first, for pages whose readers sit behind a server cache
 * (the CRM's live proxy): without invalidating that cache, router.refresh()
 * would re-render the same figures and the label would still reset to "just
 * now" — a refresh that says it worked and did nothing.
 *
 * `fetchedAt` null means the source did not answer: the label says so instead
 * of "Updated just now", and the Refresh button stays to try again.
 */
export function RefreshControl({
  fetchedAt,
  beforeRefresh,
}: {
  fetchedAt: string | null;
  beforeRefresh?: () => Promise<void>;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const fetchedAtMs = fetchedAt ? new Date(fetchedAt).getTime() : 0;
  const [now, setNow] = useState(fetchedAtMs);

  // Tick the relative label. Re-syncs whenever a refresh lands a new fetchedAt.
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(id);
  }, [fetchedAtMs]);

  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-muted-foreground tabular-nums">
        {pending ? 'Updated now…' : fetchedAt ? `Updated ${relativeLabel(fetchedAtMs, now)}` : 'Not updated: no answer'}
      </span>
      <button
        type="button"
        onClick={() =>
          startTransition(async () => {
            await beforeRefresh?.();
            router.refresh();
          })
        }
        disabled={pending}
        aria-label="Refresh"
        className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:border-primary hover:text-primary disabled:opacity-60"
      >
        <RefreshCw className={cn('size-3.5', pending && 'animate-spin')} />
        Refresh
      </button>
    </div>
  );
}
