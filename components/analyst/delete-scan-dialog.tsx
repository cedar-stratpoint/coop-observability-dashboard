'use client';

import type {ReactElement} from 'react';
import {useEffect, useRef, useState} from 'react';
import {useRouter} from 'next/navigation';
import {AlertDialog} from '@base-ui/react/alert-dialog';
import {AlertTriangle, Check, Loader2, Trash2} from 'lucide-react';
import type {ScanGroupSummary} from '@/src/goldline-data';
import {deleteScanGroupAction, scanGroupSummaryAction} from '@/app/uploads/actions';
import {Button} from '@/components/ui/button';

// Delete a whole scan drop (every page that came from one PDF). Irreversible and a
// committed page takes its counts with it, so it confirms first and spells out exactly
// what goes. On confirm it shows a brief, honest "removing" sequence (the delete is one
// bulk pass, but a 109-page drop vanishing in a blink reads as a glitch — the progress
// makes the scale of what happened legible) before leaving for Uploads.

const STEPS = ['Checking the scan', 'Removing the pages', 'Clearing their readings', 'Finishing up'];

export function DeleteScanDialog({
  company,
  source,
  trigger,
  onDeleted,
}: {
  company: string;
  source: string;
  /** Custom trigger element (e.g. an icon button on a tile). Defaults to a "Delete scan" button. */
  trigger?: ReactElement;
  /** Called once the scan is gone. When set, the dialog stays on the page (toast + refresh is
   *  the caller's job) instead of redirecting to the Uploads landing. */
  onDeleted?: (info: {files: number; source: string}) => void;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [summary, setSummary] = useState<ScanGroupSummary | null | 'loading' | 'error'>('loading');
  const [phase, setPhase] = useState<'confirm' | 'deleting' | 'done' | 'error'>('confirm');
  const [progress, setProgress] = useState(0);
  const [step, setStep] = useState(STEPS[0]);
  const [error, setError] = useState<string | null>(null);
  const timers = useRef<ReturnType<typeof setInterval>[]>([]);

  useEffect(() => {
    if (!open) return;
    setPhase('confirm');
    setSummary('loading');
    setError(null);
    let live = true;
    scanGroupSummaryAction({company, source})
      .then((r) => live && setSummary(r.ok ? r.summary : 'error'))
      .catch(() => live && setSummary('error'));
    return () => {
      live = false;
    };
  }, [open, company, source]);

  useEffect(() => () => timers.current.forEach(clearInterval), []);

  const close = () => {
    if (phase === 'deleting') return; // don't abandon a delete in flight
    setOpen(false);
  };

  async function confirm() {
    setPhase('deleting');
    setProgress(0);
    setError(null);
    const start = Date.now();
    const MIN = 1800;
    const iv = setInterval(() => {
      const elapsed = Date.now() - start;
      setProgress(Math.min(92, (elapsed / MIN) * 92));
      setStep(STEPS[Math.min(STEPS.length - 1, Math.floor(elapsed / (MIN / STEPS.length)))]);
    }, 70);
    timers.current.push(iv);
    const res = await deleteScanGroupAction({company, source});
    clearInterval(iv);
    if (!res.ok) {
      setPhase('error');
      setError(res.error);
      return;
    }
    const remain = Math.max(0, MIN - (Date.now() - start));
    setStep('Done');
    setProgress(100);
    setPhase('done');
    await new Promise((r) => setTimeout(r, remain + 400));
    setOpen(false);
    if (onDeleted) {
      onDeleted({files: s?.files ?? 0, source});
    } else {
      router.push('/uploads');
      router.refresh();
    }
  }

  const s = typeof summary === 'object' && summary ? summary : null;

  return (
    <AlertDialog.Root open={open} onOpenChange={(o) => (o ? setOpen(true) : close())}>
      <AlertDialog.Trigger
        render={
          trigger ?? (
            <Button variant="ghost" size="sm" className="shrink-0 text-muted-foreground hover:text-destructive">
              <Trash2 className="size-3.5" /> Delete scan
            </Button>
          )
        }
      />
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="fixed inset-0 z-50 bg-black/45 transition-opacity duration-150 ease-out data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
        <AlertDialog.Popup className="fixed top-1/2 left-1/2 z-50 flex w-[min(30rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 rounded-xl border border-border bg-popover p-5 text-popover-foreground shadow-xl outline-none transition-[opacity,transform] duration-150 ease-out data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0">
          {phase === 'deleting' || phase === 'done' ? (
            <div className="flex flex-col gap-4 py-2">
              <div className="flex items-center gap-3">
                <span className="grid size-9 shrink-0 place-items-center rounded-full bg-destructive/10 text-destructive">
                  {phase === 'done' ? <Check className="size-4" aria-hidden /> : <Loader2 className="size-4 animate-spin" aria-hidden />}
                </span>
                <div>
                  <AlertDialog.Title className="font-heading text-base font-semibold">{phase === 'done' ? 'Scan deleted' : 'Deleting the scan'}</AlertDialog.Title>
                  <p className="text-sm text-muted-foreground tabular-nums">
                    {step}
                    {s ? ` · ${s.files} ${s.files === 1 ? 'page' : 'pages'}` : ''}
                  </p>
                </div>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-muted">
                <div className="h-full rounded-full bg-destructive transition-[width] duration-200 ease-out" style={{width: `${progress}%`}} />
              </div>
            </div>
          ) : (
            <>
              <div className="flex items-start gap-3">
                <span className="grid size-9 shrink-0 place-items-center rounded-full bg-destructive/10 text-destructive">
                  <Trash2 className="size-4" aria-hidden />
                </span>
                <div className="flex min-w-0 flex-col gap-1">
                  <AlertDialog.Title className="font-heading text-base font-semibold">Delete this scan?</AlertDialog.Title>
                  <span className="truncate font-mono text-xs text-muted-foreground" title={source}>{source}</span>
                </div>
              </div>

              <AlertDialog.Description render={<div />} className="flex flex-col gap-3 text-sm text-muted-foreground">
                {summary === 'loading' ? (
                  <span className="inline-flex items-center gap-2">
                    <Loader2 className="size-4 animate-spin" aria-hidden /> Reading what this scan holds…
                  </span>
                ) : summary === 'error' || !s ? (
                  <span role="alert" className="text-destructive">Couldn’t read this scan. Try again.</span>
                ) : (
                  <>
                    <span className="text-foreground">
                      This removes all <strong className="tabular-nums">{s.files}</strong> {s.files === 1 ? 'page' : 'pages'} in this scan
                      {s.stores.length > 0 ? (
                        <>
                          {' '}across <strong className="tabular-nums">{s.stores.length}</strong> {s.stores.length === 1 ? 'store' : 'stores'}
                        </>
                      ) : null}
                      , and their readings. This can’t be undone.
                    </span>
                    {s.committed > 0 && (
                      <span
                        className="flex gap-2 rounded-lg border px-3 py-2.5 text-foreground"
                        style={{borderColor: 'color-mix(in oklab, var(--status-warn) 45%, transparent)', background: 'color-mix(in oklab, var(--status-warn) 10%, transparent)'}}
                      >
                        <AlertTriangle className="mt-0.5 size-4 shrink-0" style={{color: 'var(--status-warn)'}} aria-hidden />
                        <span>
                          <strong className="tabular-nums">{s.committed}</strong> {s.committed === 1 ? 'page is' : 'pages are'} committed. Deleting
                          also removes their counts from Inventory.
                        </span>
                      </span>
                    )}
                    <div className="flex flex-wrap gap-1.5 text-xs">
                      {s.needsReview > 0 && <Chip tone="warn" n={s.needsReview} label="to review" />}
                      {s.committed > 0 && <Chip tone="good" n={s.committed} label="committed" />}
                      {s.issues > 0 && <Chip tone="crit" n={s.issues} label={s.issues === 1 ? 'issue' : 'issues'} />}
                    </div>
                    {s.bas.length > 0 && (
                      <span className="text-xs">
                        Affected BAs: <span className="text-foreground">{s.bas.slice(0, 4).join(', ')}{s.bas.length > 4 ? `, +${s.bas.length - 4} more` : ''}</span>
                      </span>
                    )}
                  </>
                )}
                {error && <span role="alert" className="text-destructive">{error}</span>}
              </AlertDialog.Description>

              <div className="flex flex-wrap justify-end gap-2">
                <AlertDialog.Close render={<Button variant="ghost" />}>Cancel</AlertDialog.Close>
                <Button variant="destructive" onClick={confirm} disabled={!s || s.files === 0}>
                  <Trash2 className="size-4" /> Delete {s ? `${s.files} ${s.files === 1 ? 'page' : 'pages'}` : 'scan'}
                </Button>
              </div>
            </>
          )}
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

const TONE = {good: 'var(--status-good)', warn: 'var(--status-warn)', crit: 'var(--status-crit)'} as const;
function Chip({tone, n, label}: {tone: keyof typeof TONE; n: number; label: string}) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-medium tabular-nums"
      style={{color: `color-mix(in oklab, ${TONE[tone]} 70%, var(--foreground))`, background: `color-mix(in oklab, ${TONE[tone]} 14%, transparent)`}}
    >
      <span className="font-semibold">{n}</span> {label}
    </span>
  );
}
