'use client';

import {useEffect, useState, useTransition} from 'react';
import {AlertDialog} from '@base-ui/react/alert-dialog';
import {AlertTriangle, Loader2, RotateCcw, Undo2} from 'lucide-react';
import {reopenImpactAction, reopenUploadAction} from '@/app/uploads/actions';
import type {ReopenImpact} from '@/src/goldline-reopen-data';
import {Button} from '@/components/ui/button';

// Confirmation for "Reopen for review" (Nov 27). Reopening takes the page's counts out of
// Inventory until it is committed again, so it is a real dialog that says exactly what changes,
// read from the server when it opens (Reopen stays disabled until it is known). Same shape as the
// delete dialog. Plan: knowledge/tasks/2026-11-27-reopen-flare-band-wording.md (W3).

function fmtPeriod(start: string, end: string): string {
  const md = (s: string) => new Date(`${s}T00:00:00Z`).toLocaleDateString('en-US', {month: 'short', day: 'numeric', timeZone: 'UTC'});
  return `${md(start)} to ${md(end)}, ${end.slice(0, 4)}`;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function ReopenPageDialog({
  company,
  uploadId,
  pageLabel,
  open,
  onClose,
  onReopened,
}: {
  company: string;
  uploadId: string;
  /** "Page 21", for the title. */
  pageLabel: string;
  open: boolean;
  onClose: () => void;
  onReopened: () => void;
}) {
  const [impact, setImpact] = useState<ReopenImpact | {error: string} | 'loading'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (!open) {
      setImpact('loading');
      setError(null);
      return;
    }
    let live = true;
    setImpact('loading');
    setError(null);
    reopenImpactAction({company, uploadId})
      .then((r) => {
        if (live) setImpact(r.ok ? r.impact : {error: r.error});
      })
      .catch(() => {
        if (live) setImpact({error: 'Couldn’t check what this page feeds. Please try again.'});
      });
    return () => {
      live = false;
    };
  }, [company, uploadId, open, attempt]);

  const failed = impact !== 'loading' && 'error' in impact ? impact.error : null;
  const loaded = impact !== 'loading' && !('error' in impact) ? impact : null;

  function confirm() {
    setError(null);
    startTransition(async () => {
      const res = await reopenUploadAction({company, uploadId});
      if (!res.ok) {
        setError(res.error);
        return;
      }
      onReopened();
    });
  }

  const where = loaded?.store && loaded.periodStart && loaded.periodEnd ? `Store ${loaded.store}, ${fmtPeriod(loaded.periodStart, loaded.periodEnd)}` : null;

  return (
    <AlertDialog.Root open={open} onOpenChange={(o) => !o && !pending && onClose()}>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="fixed inset-0 z-50 bg-black/45 transition-opacity duration-150 ease-out data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
        <AlertDialog.Popup className="fixed top-1/2 left-1/2 z-50 flex w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 rounded-xl border border-border bg-popover p-5 text-popover-foreground shadow-xl outline-none transition-[opacity,transform] duration-150 ease-out data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0 motion-reduce:transition-none">
          <div className="flex items-start gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-foreground">
              <Undo2 className="size-4" aria-hidden />
            </span>
            <div className="flex min-w-0 flex-col gap-1">
              <AlertDialog.Title className="font-heading text-base font-semibold">Reopen {pageLabel} for review?</AlertDialog.Title>
              {where && <span className="text-sm text-muted-foreground">{where}</span>}
            </div>
          </div>

          <AlertDialog.Description render={<div />} className="flex flex-col gap-3 text-sm text-muted-foreground">
            {impact === 'loading' ? (
              <span className="inline-flex items-center gap-2">
                <Loader2 className="size-4 animate-spin" aria-hidden /> Checking what this page feeds…
              </span>
            ) : failed ? (
              <span role="alert" className="flex flex-wrap items-center justify-between gap-2 text-destructive">
                {failed}
                <Button variant="outline" size="sm" onClick={() => setAttempt((a) => a + 1)}>
                  <RotateCcw className="size-3.5" /> Retry
                </Button>
              </span>
            ) : loaded ? (
              <>
                <span
                  className="flex gap-2 rounded-lg border px-3 py-2.5 text-foreground"
                  style={{
                    borderColor: 'color-mix(in oklab, var(--status-warn) 45%, transparent)',
                    background: 'color-mix(in oklab, var(--status-warn) 10%, transparent)',
                  }}
                >
                  <AlertTriangle className="mt-0.5 size-4 shrink-0" style={{color: 'var(--status-warn)'}} aria-hidden />
                  <span>
                    Its <strong>{plural(loaded.counts, 'count', 'counts')}</strong> come out of Inventory until you commit it again.
                  </span>
                </span>
                <span>The page goes back to review with the counts, store, period, BA and prices you committed. Nothing is read again.</span>
                {loaded.checks > 0 && (
                  <span>
                    Coop&apos;s {plural(loaded.checks, 'check', 'checks')} from this page close and stop counting against the BA. Committing
                    again runs the checks again.
                  </span>
                )}
                {loaded.keptElsewhere.length > 0 && (
                  <span>
                    {plural(loaded.keptElsewhere.length, 'count now comes', 'counts now come')} from another page and{' '}
                    {loaded.keptElsewhere.length === 1 ? 'stays' : 'stay'} in Inventory.
                  </span>
                )}
              </>
            ) : null}
            {error && (
              <span role="alert" className="text-destructive">
                {error}
              </span>
            )}
          </AlertDialog.Description>

          <div className="flex flex-wrap justify-end gap-2">
            <AlertDialog.Close render={<Button variant="ghost" disabled={pending} />}>Cancel</AlertDialog.Close>
            <Button onClick={confirm} disabled={pending || !loaded}>
              {pending && <Loader2 className="size-4 animate-spin" />}
              Reopen page
            </Button>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
