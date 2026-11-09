'use client';

import {createContext, useCallback, useContext, useEffect, useRef, useState} from 'react';
import Link from 'next/link';
import {usePathname} from 'next/navigation';
import {CheckCircle2, Loader2, X} from 'lucide-react';
import {activeScanProgressAction} from '@/app/uploads/actions';
import {useUploadQueue} from '@/components/analyst/upload-queue';
import {isScanActive, scanReadingPercent, scanReadingStage, type ScanReadingSummary} from '@/src/scan-reading';
import {cn} from '@/lib/utils';

// After the whole scan uploads and splits, the pages are read on the server (the pump), so
// the browser's in-memory upload queue is gone after a refresh / navigation — yet the read
// keeps going. This provider polls DB state (activeScanProgressAction) so a "still reading"
// indicator can reappear on any page and after a refresh. One poll feeds two surfaces: the
// floating dock (off the Uploads page) and the Uploads-page card. Flag-gated at the action,
// and parked while the flag is off or the tab is hidden, so it costs nothing elsewhere.

const IDLE_MS = 15_000; // no scan in flight: a slow heartbeat, enough to catch a fresh one
const ACTIVE_MS = 3_000; // reading now: keep the count + bar moving
const DONE_LINGER_MS = 6_000; // hold the "ready" state briefly after the last page settles
const STAGE_MS = 2_500; // rotate the labor-illusion label

type ScanReadingState = {summary: ScanReadingSummary | null; finished: ScanReadingSummary | null};
const ScanReadingContext = createContext<ScanReadingState>({summary: null, finished: null});

/** The reading scan now in flight (`summary`) and, briefly after it settles, the one that
 *  just finished (`finished`) for a short "Scan ready" state. Both null off the pilot. */
export function useScanReading(): ScanReadingState {
  return useContext(ScanReadingContext);
}

export function ScanReadingProvider({
  company,
  serverUpload,
  children,
}: {
  company: string | null;
  serverUpload: boolean;
  children: React.ReactNode;
}) {
  const [summary, setSummary] = useState<ScanReadingSummary | null>(null);
  const [finished, setFinished] = useState<ScanReadingSummary | null>(null);
  const lastActive = useRef<ScanReadingSummary | null>(null);

  useEffect(() => {
    if (!serverUpload || !company) {
      setSummary(null);
      setFinished(null);
      lastActive.current = null;
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let doneTimer: ReturnType<typeof setTimeout> | null = null;

    const schedule = (ms: number) => {
      if (cancelled) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(poll, ms);
    };

    async function poll() {
      // Don't poll a backgrounded tab; visibilitychange re-polls on return.
      if (typeof document !== 'undefined' && document.hidden) {
        schedule(IDLE_MS);
        return;
      }
      try {
        const res = await activeScanProgressAction({company});
        if (cancelled) return;
        if (res.ok && res.scan && isScanActive(res.scan)) {
          setSummary(res.scan);
          setFinished(null);
          lastActive.current = res.scan;
          if (doneTimer) {
            clearTimeout(doneTimer);
            doneTimer = null;
          }
          schedule(ACTIVE_MS);
        } else {
          setSummary(null);
          // A scan we were watching just reached the end → show a brief "ready" state.
          if (lastActive.current) {
            const done = res.ok && res.scan ? res.scan : lastActive.current;
            lastActive.current = null;
            setFinished(done);
            if (doneTimer) clearTimeout(doneTimer);
            doneTimer = setTimeout(() => {
              if (!cancelled) setFinished(null);
            }, DONE_LINGER_MS);
          }
          schedule(IDLE_MS);
        }
      } catch {
        if (!cancelled) schedule(IDLE_MS);
      }
    }

    const onVisible = () => {
      if (!document.hidden) poll();
    };
    poll();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      if (doneTimer) clearTimeout(doneTimer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [company, serverUpload]);

  return <ScanReadingContext.Provider value={{summary, finished}}>{children}</ScanReadingContext.Provider>;
}

/** A rotating labor-illusion label, advancing only while a scan is actively reading. */
function useStageLabel(active: boolean): string {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setTick((n) => n + 1), STAGE_MS);
    return () => clearInterval(t);
  }, [active]);
  return scanReadingStage(tick);
}

/** The count shown: the page currently being read (done + 1), clamped to the total. */
function readingCount(s: ScanReadingSummary): number {
  return Math.min(s.done + 1, s.total);
}

/**
 * Floating "still reading" pill — follows the user around the app (bottom-right on desktop,
 * a slim bar under the header on mobile). Not shown on the Uploads pages (the card is there),
 * and it stands aside for the in-session upload indicator so only one ever shows.
 */
export function ScanReadingDock() {
  const {summary, finished} = useScanReading();
  const q = useUploadQueue();
  const pathname = usePathname() || '/';
  const [dismissed, setDismissed] = useState<string | null>(null);
  const isActive = Boolean(summary);
  const stage = useStageLabel(isActive);
  const show = summary ?? finished;

  if (!show) return null;
  if (pathname.startsWith('/uploads')) return null; // the Uploads-page card covers this
  if (q && (q.items.length > 0 || q.serverMode)) return null; // in-session indicator wins
  if (!isActive && dismissed === show.batchId) return null; // dismissed "ready" stays hidden

  const pct = scanReadingPercent(show);
  const title = isActive ? `Reading ${readingCount(show)} of ${show.total}` : 'Scan ready';
  const sub = isActive
    ? stage
    : show.needsReview > 0
      ? `${show.needsReview} page${show.needsReview === 1 ? '' : 's'} to review`
      : 'Open to review and commit';
  const Icon = isActive ? Loader2 : CheckCircle2;

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        'fixed z-40 transition-[opacity,transform] duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] starting:opacity-0 motion-reduce:transition-opacity',
        'inset-x-3 top-[calc(3.5rem+env(safe-area-inset-top,0px)+0.5rem)] starting:-translate-y-2',
        'md:inset-x-auto md:top-auto md:right-6 md:bottom-6 md:w-80 md:starting:translate-y-2',
      )}
    >
      <div className="flex flex-col gap-2 rounded-xl border border-border bg-popover/95 px-3.5 py-3 text-popover-foreground shadow-lg backdrop-blur-sm">
        <div className="flex items-center gap-2.5">
          <Icon
            aria-hidden
            className={cn('size-4 shrink-0', isActive ? 'animate-spin text-primary motion-reduce:animate-none' : '')}
            style={!isActive ? {color: 'var(--status-good)'} : undefined}
          />
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-sm font-medium">{title}</span>
            <span className="truncate text-xs text-muted-foreground">{sub}</span>
          </div>
          <Link href="/uploads" className="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-primary hover:bg-muted">
            {isActive ? 'View' : 'Review'}
          </Link>
          {!isActive && (
            <button
              type="button"
              aria-label="Dismiss"
              onClick={() => setDismissed(show.batchId)}
              className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
        {isActive && (
          <div
            role="progressbar"
            aria-label="Reading progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct}
            className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
          >
            <div
              className="gl-progress-fill h-full min-w-[0.375rem] rounded-full transition-[width] duration-500 ease-out"
              style={{width: `${pct}%`}}
            />
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The Uploads-page card: the prominent "reading on the server" status that reappears after a
 * refresh while a scan is still being read. Mirrors the in-session ServerUploadStatus card so
 * the surface is continuous. Stands aside for the in-session uploader (which shows its own).
 */
export function ScanReadingCard({scan}: {scan?: string}) {
  const {summary, finished} = useScanReading();
  const q = useUploadQueue();
  const isActive = Boolean(summary);
  const stage = useStageLabel(isActive);
  const show = summary ?? finished;

  if (!show) return null;
  // On a scan-detail page, only this scan's own reading state (never a different scan that
  // happens to be reading). Omitted on the Uploads inbox, where any active scan is relevant.
  if (scan != null && show.source.trim() !== scan.trim()) return null;
  if (q && (q.items.length > 0 || q.serverMode)) return null; // the live uploader card is showing

  const pct = scanReadingPercent(show);
  const label = isActive ? 'Reading scan' : 'Scan ready';
  const sub = isActive
    ? 'Reads on the server, pages keep arriving. You can leave or refresh, it won’t stop.'
    : show.needsReview > 0
      ? `${show.needsReview} page${show.needsReview === 1 ? '' : 's'} ready to review below.`
      : 'Every page is read. Open the scan to review and commit.';

  return (
    <div className="mb-4 flex flex-col gap-3 rounded-xl border border-border bg-muted/20 px-4 py-5">
      <div className="flex items-center gap-2.5">
        <span
          className={cn(
            'flex size-9 shrink-0 items-center justify-center rounded-full',
            isActive ? 'bg-primary/15 text-primary' : '',
          )}
          style={!isActive ? {backgroundColor: 'color-mix(in oklab, var(--status-good) 15%, transparent)', color: 'var(--status-good)'} : undefined}
        >
          {isActive ? (
            <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden />
          ) : (
            <CheckCircle2 className="size-4" aria-hidden />
          )}
        </span>
        <div className="flex min-w-0 flex-col">
          <span className="text-sm font-medium">
            {label}
            {isActive && (
              <span className="ml-1.5 font-mono text-xs text-muted-foreground tabular-nums">
                {readingCount(show)} of {show.total}
              </span>
            )}
          </span>
          <span className="truncate text-xs text-muted-foreground">{sub}</span>
        </div>
        {isActive ? (
          <span aria-live="polite" className="ml-auto hidden shrink-0 text-xs text-muted-foreground sm:inline">
            {stage}
            <span aria-hidden>&#8230;</span>
          </span>
        ) : (
          <Link href="/uploads" className="ml-auto shrink-0 rounded-md px-2 py-1 text-xs font-medium text-primary hover:bg-muted">
            Review
          </Link>
        )}
      </div>
      {isActive && (
        <div
          role="progressbar"
          aria-label="Reading progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
          className="h-2 w-full overflow-hidden rounded-full bg-muted"
        >
          <div
            className="gl-progress-fill h-full min-w-[0.5rem] rounded-full transition-[width] duration-500 ease-out"
            style={{width: `${pct}%`}}
          />
        </div>
      )}
    </div>
  );
}
