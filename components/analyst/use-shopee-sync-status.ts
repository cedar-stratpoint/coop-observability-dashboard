'use client';

import {useCallback, useEffect, useRef, useState} from 'react';
import {useRouter} from 'next/navigation';
import {pollInterval} from '@/src/shopee-sync/card-model';
import type {ShopeeSyncStatus} from '@/src/shopee-sync/status';

// Live status for the Shopee sync card. The server renders the first status; after that this polls GET /api/shopee/sync/status every few seconds,
// but only while a sync is current (queued or in flight) and the tab is visible. An idle page never polls. When a sync turns to done the page's own
// data is refreshed once so the Overview figures pick up the new days.
export function useShopeeSyncStatus(initial: ShopeeSyncStatus | null, initialAt: string) {
  const router = useRouter();
  const [status, setStatus] = useState<ShopeeSyncStatus | null>(initial);
  const [now, setNow] = useState<Date>(() => new Date(initialAt));
  const prevJob = useRef(initial?.currentJob?.id ?? null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch('/api/shopee/sync/status', {cache: 'no-store'});
      if (!res.ok) return;
      const next = (await res.json()) as ShopeeSyncStatus;
      setStatus(next);
      setNow(new Date());
      const was = prevJob.current;
      prevJob.current = next.currentJob?.id ?? null;
      if (was && !next.currentJob && next.lastJob?.id === was && next.lastJob.status === 'done') router.refresh();
    } catch {
      // a missed poll is fine; the next one tries again
    }
  }, [router]);

  const interval = pollInterval(status);
  useEffect(() => {
    if (!interval) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const schedule = () => {
      if (!stopped && document.visibilityState === 'visible') timer = setTimeout(tick, interval);
    };
    const tick = async () => {
      await refresh();
      schedule();
    };
    const onVisible = () => {
      clearTimeout(timer);
      if (document.visibilityState === 'visible') void tick(); // catch up at once on returning to the tab
    };
    schedule();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [interval, refresh]);

  // "last seen 12 seconds ago" keeps moving between polls, with no network: just a clock for the wording.
  useEffect(() => {
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 15_000);
    return () => clearInterval(t);
  }, []);

  return {status, now, refresh};
}
