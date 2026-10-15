'use client';

import {useEffect, useState} from 'react';
import Link from 'next/link';
import {usePathname} from 'next/navigation';
import {AlertTriangle, CheckCircle2, Loader2, X} from 'lucide-react';
import {useUploadQueue} from '@/components/analyst/upload-queue';
import {eta, itemLabel, summarize} from '@/components/analyst/upload-queue-format';
import {cn} from '@/lib/utils';

// Follows the user around the app while a batch is uploading or waiting for review:
// a compact card bottom-right on desktop, a slim bar under the header on mobile. Not
// shown on the Uploads pages (the full panel is right there). Entry is a short
// ease-out rise; the bar moves on real milestones (see src/upload-progress.ts).

export function UploadQueueIndicator() {
  const q = useUploadQueue();
  const pathname = usePathname();
  const [now, setNow] = useState(() => Date.now());
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);

  const running = Boolean(q && q.items.some((i) => i.state === 'running'));
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [running]);

  if (!q || !q.items.length) return null;
  if (pathname.startsWith('/uploads')) return null;
  const s = summarize(q.items, now);
  const busy = s.running + s.waiting > 0;
  // A dismissed "done" card stays hidden until something new starts.
  const lastActivity = Math.max(0, ...q.items.map((i) => i.startedAt ?? 0));
  if (!busy && dismissedAt && dismissedAt >= lastActivity) return null;

  const current = q.items.find((i) => i.state === 'running');
  const startedAt = Math.min(...q.items.map((i) => i.startedAt ?? Infinity));
  const left = busy ? eta(Number.isFinite(startedAt) ? startedAt : null, s.percent, now) : null;
  const reviewHref = q.batch.id ? `/uploads/batch/${q.batch.id}` : '/uploads';

  const title = busy
    ? `Reading ${s.done + 1 > s.total ? s.total : s.done + 1} of ${s.total}`
    : s.failed && !s.done
      ? `${s.failed} upload${s.failed === 1 ? '' : 's'} failed`
      : s.readyForReview
        ? `${s.readyForReview} page${s.readyForReview === 1 ? '' : 's'} ready to review`
        : 'Upload finished';
  const Icon = busy ? Loader2 : s.failed && !s.done ? AlertTriangle : CheckCircle2;
  const tone = busy ? 'text-primary' : s.failed && !s.done ? 'text-destructive' : '';

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        'fixed z-40 transition-[opacity,transform] duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] starting:opacity-0 motion-reduce:transition-opacity',
        // Mobile: slim bar under the sticky header. Desktop: card bottom-right.
        'inset-x-3 top-[calc(3.5rem+env(safe-area-inset-top,0px)+0.5rem)] starting:-translate-y-2',
        'md:inset-x-auto md:top-auto md:right-6 md:bottom-6 md:w-80 md:starting:translate-y-2',
      )}
    >
      <div className="flex flex-col gap-2 rounded-xl border border-border bg-popover/95 px-3.5 py-3 text-popover-foreground shadow-lg backdrop-blur-sm">
        <div className="flex items-center gap-2.5">
          <Icon
            aria-hidden
            className={cn('size-4 shrink-0', busy && 'animate-spin motion-reduce:animate-none', tone)}
            style={!busy && !(s.failed && !s.done) ? {color: 'var(--status-good)'} : undefined}
          />
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-sm font-medium">{title}</span>
            <span className="truncate text-xs text-muted-foreground max-md:hidden">
              {busy && current ? `${current.name} · ${itemLabel(current)}` : left ?? (s.failed ? `${s.failed} need attention` : 'Open to review and commit')}
            </span>
          </div>
          {busy ? (
            <Link href="/uploads" className="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-primary hover:bg-muted">
              View
            </Link>
          ) : (
            <>
              <Link href={s.readyForReview ? reviewHref : '/uploads'} className="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-primary hover:bg-muted">
                {s.readyForReview ? 'Review' : 'Open'}
              </Link>
              <button
                type="button"
                aria-label="Dismiss"
                onClick={() => setDismissedAt(Date.now())}
                className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <X className="size-3.5" />
              </button>
            </>
          )}
        </div>
        {busy && (
          <div
            role="progressbar"
            aria-label="Upload progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(s.percent)}
            className="h-1 w-full overflow-hidden rounded-full bg-muted"
          >
            <div className="h-full rounded-full bg-primary transition-[width] duration-300 ease-out motion-reduce:transition-none" style={{width: `${s.percent}%`}} />
          </div>
        )}
        {busy && left && <span className="text-[11px] text-muted-foreground md:hidden">{left}</span>}
      </div>
    </div>
  );
}
