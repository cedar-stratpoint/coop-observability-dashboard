'use client';

// Sampling panel (free tastes). Shows the 30-day summary (units + logged count, with
// an oversold flag) then the per-product pills. Each pill carries an X that undoes the
// product's MOST RECENT sample (void_free_taste restores the Event stock) behind a
// confirmation modal, so a misclick can be reverted without a long flat list. Freebies
// are logged only, never counted in sales / units / revenue.

import {useEffect, useId, useRef, useState, useTransition} from 'react';
import {useRouter} from 'next/navigation';
import {Dog, Undo2, X} from 'lucide-react';
import {voidFreeTasteAction} from '@/src/pos-free-taste-actions';
import type {FreeTasteSummary} from '@/src/pos-free-taste-data';
import {ModalShell, useModalExit} from './modal-shell';

type PendingUndo = {productName: string; clientUuid: string; qty: number};

export function SamplingPanel({sampling}: {sampling: FreeTasteSummary}) {
  const [confirming, setConfirming] = useState<PendingUndo | null>(null);

  if (sampling.totalCount === 0) return null;

  return (
    <div className="mb-4 rounded-xl border bg-card p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          <Dog className="size-3.5" /> Sampling · last {sampling.windowDays} days
        </span>
        <span className="font-mono text-[11px] text-muted-foreground">
          <span className="tabular-nums text-foreground">{sampling.totalUnits}</span> units ·{' '}
          <span className="tabular-nums">{sampling.totalCount}</span> logged
          {sampling.oversoldCount > 0 && (
            <> · <span className="tabular-nums text-amber-600 dark:text-amber-400">{sampling.oversoldCount}</span> vs low stock</>
          )}
        </span>
      </div>

      {sampling.byProduct.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {sampling.byProduct.map((p) => (
            <span
              key={p.product_id}
              className="inline-flex items-center gap-1.5 rounded-md border bg-background py-1 pl-2.5 pr-1 text-xs"
            >
              <span className="text-foreground">{p.name}</span>
              <span className="font-mono text-[10px] tabular-nums text-muted-foreground">{p.units}</span>
              {p.lastClientUuid ? (
                <button
                  type="button"
                  onClick={() => setConfirming({productName: p.name, clientUuid: p.lastClientUuid as string, qty: p.lastQty})}
                  aria-label={`Undo the most recent ${p.name} free taste`}
                  title="Undo the most recent sample of this product"
                  className="ml-0.5 rounded p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  <X className="size-3.5" />
                </button>
              ) : (
                <span className="ml-0.5 p-0.5 text-muted-foreground/40" title="Cannot undo (no reference)" aria-hidden>
                  <X className="size-3.5" />
                </span>
              )}
            </span>
          ))}
        </div>
      )}

      {confirming && <UndoConfirmModal undo={confirming} onClose={() => setConfirming(null)} />}
    </div>
  );
}

// Confirm before voiding a product's most recent free taste. Portalled modal in the
// incumbent style; the firedRef guard keeps a double-click from voiding twice.
function UndoConfirmModal({undo, onClose: onClosed}: {undo: PendingUndo; onClose: () => void}) {
  const {closing, close: onClose} = useModalExit(onClosed);
  const titleId = useId();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const firedRef = useRef(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  function confirm() {
    if (firedRef.current) return;
    firedRef.current = true;
    startTransition(async () => {
      await voidFreeTasteAction(undo.clientUuid);
      router.refresh();
      onClose();
    });
  }

  return (
    <ModalShell closing={closing} onBackdropClick={onClose} backdropLabel="Cancel" labelledBy={titleId} panelClassName="flex w-full max-w-sm flex-col overflow-hidden rounded-2xl border border-border bg-popover shadow-lg">
      <div className="flex items-center justify-between border-b px-5 py-4">
        <h2 id={titleId} className="flex items-center gap-2 text-base font-semibold">
          <Undo2 className="size-4" /> Undo free taste
        </h2>
        <button type="button" onClick={onClose} aria-label="Close" className="text-muted-foreground hover:text-foreground">
          <X className="size-4" />
        </button>
      </div>

      <div className="px-5 py-4">
        <p className="text-sm text-muted-foreground">
          Undo the most recent free taste of this product? This restores {undo.qty} to Event stock.
        </p>
        <p className="mt-2 text-sm font-medium">{undo.qty}× {undo.productName}</p>
      </div>

      <div className="flex items-center justify-between gap-3 border-t bg-muted/40 px-5 py-3">
        <span className="font-mono text-[11px] text-muted-foreground">🔒 recorded with your account · now</span>
        <div className="flex gap-2">
          <button type="button" onClick={onClose} className="rounded-md border px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground">
            Cancel
          </button>
          <button
            type="button"
            onClick={confirm}
            disabled={pending}
            className="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
          >
            {pending ? 'Undoing…' : 'Undo'}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}
