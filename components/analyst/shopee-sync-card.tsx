'use client';

import {useState, useTransition} from 'react';
import Link from 'next/link';
import {AlertTriangle, CalendarClock, Check, CheckCircle2, ClipboardCheck, Clock, Download, Hourglass, KeyRound, Laptop, RefreshCw, X} from 'lucide-react';
import {cancelSyncJob, confirmSyncReview, createSyncJob} from '@/src/shopee-sync-actions';
import {macOf, rangeText, statusMeta, stepsFor, syncButton, workerLine, type JobAction, type Tone} from '@/src/shopee-sync/card-model';
import type {JobStatus} from '@/src/shopee-sync/types';
import type {ShopeeSyncStatus, SyncJobView} from '@/src/shopee-sync/status';
import {Button} from '@/components/ui/button';
import {cn} from '@/lib/utils';

// The Shopee sync card on the Overview. A thin view: every word and every decision (what shows, which actions, the button label and its reason)
// comes from src/shopee-sync/card-model.ts; the rules are the server's (canSync). There is no day picker, no mode choice, and no field for a
// password or code anywhere: Shopee's password is typed in the Shopee browser on the person's own Mac.

const ICON: Record<JobStatus, React.ComponentType<{className?: string}>> = {
  queued: Clock,
  running: RefreshCw,
  awaiting_verification: KeyRound,
  importing: Download,
  done: CheckCircle2,
  failed: AlertTriangle,
  review: ClipboardCheck,
  expired: Hourglass,
};
// Semantic tokens only (style guide): amber for waiting-on-a-person, status-good, destructive. The amber text is mixed toward the foreground to hold contrast.
const TONE: Record<Tone, string> = {
  neutral: 'bg-muted text-muted-foreground',
  info: 'bg-accent text-accent-foreground',
  warn: 'bg-[var(--amber-bg)] text-[color-mix(in_oklab,var(--amber-fg)_55%,var(--foreground))]',
  good: 'bg-[color-mix(in_oklab,var(--status-good)_14%,transparent)] text-[var(--status-good)]',
  crit: 'bg-destructive/10 text-destructive',
};

function Pill({tone, icon: Icon, children, spin}: {tone: Tone; icon: React.ComponentType<{className?: string}>; children: React.ReactNode; spin?: boolean}) {
  return (
    <span className={cn('inline-flex w-fit items-center gap-1.5 rounded-full px-2.5 py-1 text-[12.5px] font-semibold transition-colors duration-200', TONE[tone])}>
      <Icon className={cn('size-3.5', spin && 'motion-safe:animate-spin')} aria-hidden />
      {children}
    </span>
  );
}

function Steps({job}: {job: SyncJobView}) {
  const steps = stepsFor(job);
  return (
    <ol className="flex flex-wrap gap-x-4 gap-y-1.5 text-[13px]" aria-label="Progress">
      {steps.map((s) => (
        <li key={s.label} className={cn('inline-flex items-center gap-1.5', s.state === 'todo' ? 'text-muted-foreground' : s.state === 'bad' ? 'font-medium text-destructive' : 'text-foreground', s.state === 'now' && 'font-medium')}>
          <span
            aria-hidden
            className={cn(
              'grid size-4 place-items-center rounded-full border text-[10px] transition-colors duration-200',
              s.state === 'done' && 'border-primary bg-primary text-primary-foreground',
              s.state === 'now' && 'border-primary bg-primary/25 ring-2 ring-primary/20',
              s.state === 'bad' && 'border-destructive bg-destructive text-background',
              s.state === 'todo' && 'border-border',
            )}
          >
            {s.state === 'done' && <Check className="size-2.5" strokeWidth={3} />}
            {s.state === 'bad' && <X className="size-2.5" strokeWidth={3} />}
          </span>
          {s.label}
          <span className="sr-only">{s.state === 'done' ? ', done' : s.state === 'now' ? ', in progress' : s.state === 'bad' ? ', failed here' : ', not started'}</span>
        </li>
      ))}
    </ol>
  );
}

export function ShopeeSyncCard({status, now, refresh}: {status: ShopeeSyncStatus & {outsideWindow?: number}; now: Date; refresh: () => Promise<void>}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const job = status.currentJob ?? status.lastJob;
  const meta = job ? statusMeta(job, {isAdmin: status.isAdmin}) : null;
  const btn = syncButton(status);
  const worker = workerLine(status, now);
  const retryJob = !status.currentJob && meta && (meta.status === 'failed' || meta.status === 'expired');
  const showMainButton = !status.currentJob && status.missingDays.length > 0 && !retryJob && meta?.status !== 'review';

  const run = (fn: () => Promise<{ok: boolean; error?: string}>) =>
    start(async () => {
      setError(null);
      const r = await fn();
      if (!r.ok) setError(r.error ?? 'Something went wrong. Try again.');
      await refresh();
    });
  const act = (a: JobAction) => {
    if (a === 'cancel' && job) run(() => cancelSyncJob(job.id));
    else if (a === 'confirm' && job) run(() => confirmSyncReview(job.id));
    else if (a === 'retry') run(() => createSyncJob());
  };
  const ACTION_LABEL: Record<JobAction, string> = {cancel: 'Cancel sync', retry: 'Retry', confirm: 'Confirm and apply'};

  return (
    <section aria-label="Shopee data freshness" aria-live="polite" className="mb-6 rounded-[var(--radius)] border border-border bg-card p-5 max-md:p-4 md:p-6">
      <div className="grid gap-x-8 gap-y-5 md:grid-cols-[minmax(0,1fr)_minmax(0,19rem)]">
        <div className="flex min-w-0 flex-col gap-3">
          {meta && job ? (
            <>
              <Pill tone={meta.tone} icon={ICON[meta.status]} spin={meta.status === 'running'}>
                {meta.label}
              </Pill>
              <h2 className="font-serif text-[1.5rem] font-normal leading-tight text-foreground max-md:text-[1.35rem]">{meta.title}</h2>
              <p className="max-w-[60ch] text-sm text-foreground/75">{meta.body}</p>
              {meta.status !== 'expired' && <Steps job={job} />}
              {meta.status === 'awaiting_verification' && (
                <p className="max-w-[60ch] rounded-lg bg-muted/60 px-3 py-2 text-[13px] text-muted-foreground">
                  One verification covers every day in this sync. If nobody verifies by the end of today (Manila time) the sync stops cleanly and the Monday import still fills the gap.
                </p>
              )}
              {(meta.actions.length > 0 || retryJob) && (
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  {meta.actions.map((a) => (
                    <Button
                      key={a}
                      type="button"
                      variant={a === 'cancel' ? 'outline' : 'default'}
                      disabled={pending || (a === 'retry' && btn.disabled)}
                      onClick={() => act(a)}
                      className="h-9 px-3.5 active:scale-[0.97]"
                    >
                      {ACTION_LABEL[a]}
                    </Button>
                  ))}
                  {retryJob && btn.disabled && btn.reason && <span className="text-[13px] text-muted-foreground">{btn.reason}</span>}
                </div>
              )}
            </>
          ) : (
            <>
              <Pill tone="warn" icon={CalendarClock}>
                Behind by {status.missingDays.length}
                {status.moreMissing > 0 ? '+' : ''} {status.missingDays.length === 1 ? 'day' : 'days'}
              </Pill>
              <h2 className="font-serif text-[1.5rem] font-normal leading-tight text-foreground max-md:text-[1.35rem]">Shopee is missing finished days</h2>
              <p className="max-w-[60ch] text-sm text-muted-foreground">
                The weekly import covers Monday to Sunday, so the days since then have no figures. Sync loads them. Today is never loaded, so the newest day is yesterday.
              </p>
            </>
          )}
          {error && (
            <p role="alert" className="text-[13px] font-medium text-destructive">
              {error}
            </p>
          )}
        </div>

        <div className="flex min-w-0 flex-col gap-3 md:border-l md:border-border md:pl-8">
          {status.missingDays.length > 0 && (
            <div>
              <div className="text-xs font-medium text-muted-foreground">Detected missing days</div>
              <div className="text-sm font-medium tabular-nums text-foreground">
                {rangeText(status.missingDays)}
                {status.moreMissing > 0 ? `, ${status.moreMissing} more after this sync` : ''}
              </div>
              {status.outsideWindow ? <div className="text-[13px] text-muted-foreground">Sync also loads {status.outsideWindow} missing {status.outsideWindow === 1 ? 'day' : 'days'} from other weeks.</div> : null}
            </div>
          )}
          {showMainButton && (
            <>
              <Button type="button" size="lg" disabled={btn.disabled || pending} onClick={() => run(() => createSyncJob())} aria-describedby={btn.reason ? 'shopee-sync-reason' : undefined} className="h-10 w-full justify-center px-4 text-sm active:scale-[0.97]">
                <RefreshCw className={cn('size-4', pending && 'motion-safe:animate-spin')} aria-hidden />
                {btn.label}
              </Button>
              {btn.reason && (
                <p id="shopee-sync-reason" className="text-[13px] text-muted-foreground">
                  {btn.reason}
                </p>
              )}
            </>
          )}
          {status.currentJob && !status.currentJob.mine && (
            <p className="text-[13px] text-muted-foreground">Waiting for {macOf(status.currentJob)} to finish its sync. Yours can start after it.</p>
          )}
          <p className={cn('flex items-start gap-2 text-[13px]', worker.kind === 'online' ? 'text-foreground' : 'text-muted-foreground')}>
            <Laptop className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <span>
              {worker.text}
              {worker.kind !== 'online' && (
                <>
                  {' '}
                  <Link href="/settings/shopee-sync" className="font-medium text-primary underline-offset-4 hover:underline">
                    My sync Macs
                  </Link>
                </>
              )}
            </span>
          </p>
        </div>
      </div>
    </section>
  );
}
