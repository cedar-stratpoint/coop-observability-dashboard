'use client';

import {useEffect, useState, useTransition} from 'react';
import {AlertDialog} from '@base-ui/react/alert-dialog';
import {AlertTriangle, Loader2, RotateCcw, Trash2} from 'lucide-react';
import type {DeleteImpact, UploadRow} from '@/src/goldline-data';
import {deleteImpactAction, deleteUploadAction} from '@/app/uploads/actions';
import {FileTypeBadge} from '@/components/analyst/file-type-badge';
import {Button} from '@/components/ui/button';

// Confirmation for deleting an upload. Deleting can't be undone, and a COMMITTED file
// takes its data with it (the inventory counts or sales rows it's the source of), so
// this is a real dialog — not an inline "are you sure" — and it says exactly what
// will go before the user confirms. The impact is read from the server when the
// dialog opens; while that loads, Delete stays disabled.

function fmtPeriod(start: string, end: string): string {
  const md = (s: string) => new Date(`${s}T00:00:00Z`).toLocaleDateString('en-US', {month: 'short', day: 'numeric', timeZone: 'UTC'});
  return `${md(start)} to ${md(end)}, ${end.slice(0, 4)}`;
}

export function DeleteUploadDialog({
  company,
  upload,
  onClose,
  onDeleted,
}: {
  company: string;
  upload: UploadRow | null;
  onClose: () => void;
  onDeleted: (text: string) => void;
}) {
  // 'loading' → checking; {error} → the check failed (Delete stays disabled — we never
  // claim "nothing changes" without knowing); DeleteImpact → known.
  const [impact, setImpact] = useState<DeleteImpact | {error: string} | 'loading'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (!upload) {
      setImpact('loading'); // reset so the next file never flashes this one's impact
      setError(null);
      return;
    }
    let live = true;
    setImpact('loading');
    setError(null);
    deleteImpactAction({company, uploadId: upload.id})
      .then((r) => {
        if (live) setImpact(r.ok ? r.impact : {error: r.error});
      })
      .catch(() => {
        if (live) setImpact({error: 'Couldn’t check what this file feeds. Please try again.'});
      });
    return () => {
      live = false;
    };
  }, [company, upload, attempt]);

  const failed = impact !== 'loading' && 'error' in impact ? impact.error : null;
  const loaded = impact !== 'loading' && !('error' in impact) ? impact : null;
  const inv = loaded?.inventoryRows ?? 0;
  const sales = loaded?.salesRows ?? 0;
  const affects = inv > 0 || sales > 0;
  const where = loaded?.snapshots
    .map((s) => `${s.store_name ? `${s.store_code} · ${s.store_name}` : `store ${s.store_code}`}, ${fmtPeriod(s.period_start, s.period_end)}`)
    .join('; ');

  function confirm() {
    if (!upload) return;
    setError(null);
    startTransition(async () => {
      const res = await deleteUploadAction({company, uploadId: upload.id});
      if (!res.ok) {
        setError(res.error);
        return;
      }
      const extra =
        inv > 0 ? ` and its ${inv} inventory ${inv === 1 ? 'count' : 'counts'}` : sales > 0 ? ` and its ${sales} sales rows` : '';
      onDeleted(`Deleted ${upload.filename}${extra}.`);
    });
  }

  return (
    <AlertDialog.Root open={Boolean(upload)} onOpenChange={(open) => !open && !pending && onClose()}>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="fixed inset-0 z-50 bg-black/45 transition-opacity duration-150 ease-out data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
        <AlertDialog.Popup className="fixed top-1/2 left-1/2 z-50 flex w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 rounded-xl border border-border bg-popover p-5 text-popover-foreground shadow-xl outline-none transition-[opacity,transform] duration-150 ease-out data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0">
          <div className="flex items-start gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-destructive/10 text-destructive">
              <Trash2 className="size-4" aria-hidden />
            </span>
            <div className="flex min-w-0 flex-col gap-1">
              <AlertDialog.Title className="font-heading text-base font-semibold">Delete this file?</AlertDialog.Title>
              {upload && (
                <span className="flex min-w-0 items-center gap-2 text-sm">
                  <FileTypeBadge filename={upload.filename} />
                  <span className="truncate font-medium" title={upload.filename}>
                    {upload.filename}
                  </span>
                </span>
              )}
            </div>
          </div>

          <AlertDialog.Description render={<div />} className="flex flex-col gap-3 text-sm text-muted-foreground">
            {impact === 'loading' ? (
              <span className="inline-flex items-center gap-2">
                <Loader2 className="size-4 animate-spin" aria-hidden /> Checking what this file feeds…
              </span>
            ) : failed ? (
              <span role="alert" className="flex flex-wrap items-center justify-between gap-2 text-destructive">
                {failed}
                <Button variant="outline" size="sm" onClick={() => setAttempt((a) => a + 1)}>
                  <RotateCcw className="size-3.5" /> Retry
                </Button>
              </span>
            ) : affects ? (
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
                    {inv > 0 ? (
                      <>
                        This scan is committed. Deleting it also removes its <strong>{inv} inventory {inv === 1 ? 'count' : 'counts'}</strong>
                        {where ? ` for ${where}` : ''} from Inventory.
                      </>
                    ) : (
                      <>
                        This sales file is committed. Deleting it also removes its <strong>{sales} sales rows</strong> from Overview and
                        Stores.
                      </>
                    )}
                  </span>
                </span>
                <span>
                  The file and its reading are deleted too. To bring the numbers back, upload and commit it again. If an earlier scan
                  covered the same items, its counts were replaced by this one and won&apos;t return on their own. Re-commit that scan.
                </span>
              </>
            ) : (
              <span>
                The file and its reading are deleted. Nothing in Inventory or sales comes from it, so no numbers change. This can&apos;t be
                undone.
              </span>
            )}
            {error && (
              <span role="alert" className="text-destructive">
                {error}
              </span>
            )}
          </AlertDialog.Description>

          <div className="flex flex-wrap justify-end gap-2">
            <AlertDialog.Close render={<Button variant="ghost" disabled={pending} />}>Cancel</AlertDialog.Close>
            <Button variant="destructive" onClick={confirm} disabled={pending || !loaded}>
              {pending && <Loader2 className="size-4 animate-spin" />}
              {affects ? (inv > 0 ? 'Delete and remove counts' : 'Delete and remove sales') : 'Delete file'}
            </Button>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
