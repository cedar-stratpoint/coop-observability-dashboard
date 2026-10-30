'use client';

import {useEffect} from 'react';
import {RotateCcw} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {ModalShell, useModalExit} from './modal-shell';
import type {DecisionInfo} from '@/src/goldline-sku-undo';

// Confirm before undoing a decision on SKU linking (Oct 29). Says what was decided, by
// whom and when, then lists every change the undo makes in plain words (from the log's
// before and after, so a reject's re-matching elsewhere is listed too). Cancel has the
// focus, so Enter never undoes by accident.

const day = (iso: string) => new Date(iso).toLocaleDateString('en-US', {month: 'short', day: 'numeric', year: 'numeric', timeZone: 'Asia/Manila'});

/** "Approved PEP092", "Linked to ELDF03", "Note"… for a logged decision. */
export function decisionLabel(d: Pick<DecisionInfo, 'action' | 'summary'>): string {
  switch (d.action) {
    case 'approved':
      return `Approved ${d.summary ?? 'Coop’s match'}`;
    case 'rejected':
      return `Rejected ${d.summary ?? 'Coop’s match'}`;
    case 'linked':
      return d.summary ? `Linked to ${d.summary}` : 'Linked';
    case 'unlinked':
      return 'Unlinked';
    case 'remark':
      return 'Remark saved';
    case 'decommissioned':
      return 'Marked as decommissioned';
    case 'restored':
      return 'Brought back';
    case 'note':
      return 'Note saved';
  }
}

export function UndoDialog({decision, subject, onConfirm, onClosed}: {decision: DecisionInfo; subject: string; onConfirm: () => void; onClosed: () => void}) {
  const {closing, close} = useModalExit(onClosed);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);

  return (
    <ModalShell closing={closing} onBackdropClick={close} labelledBy="undo-title" panelClassName="w-full max-w-lg rounded-xl border bg-popover p-6 shadow-lg">
      <div className="flex flex-col gap-5">
        <div className="flex items-start gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-full bg-muted text-foreground">
            <RotateCcw className="size-4" aria-hidden />
          </span>
          <div className="flex min-w-0 flex-col gap-1">
            <h2 id="undo-title" className="font-heading text-lg font-semibold tracking-tight">
              Undo “{decisionLabel(decision)}”?
            </h2>
            <p className="text-sm text-muted-foreground">
              {subject} · {[decision.by, day(decision.at)].filter(Boolean).join(', ')}
            </p>
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">What will happen</p>
          {decision.effects.length ? (
            <ul className="flex max-h-64 flex-col gap-2 overflow-y-auto rounded-lg bg-muted/40 px-4 py-3 text-sm">
              {decision.effects.map((e) => (
                <li key={e} className="flex gap-2.5 leading-relaxed">
                  <span className="mt-2 size-1.5 shrink-0 rounded-full bg-foreground/50" aria-hidden />
                  <span>{e}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="rounded-lg bg-muted/40 px-4 py-3 text-sm">It goes back to how it was before.</p>
          )}
          {decision.elsewhere.length > 0 && (
            <>
              <p className="mt-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">Also put back elsewhere (Coop’s re-matching)</p>
              <ul className="flex max-h-48 flex-col gap-2 overflow-y-auto rounded-lg border border-dashed px-4 py-3 text-sm text-muted-foreground">
                {decision.elsewhere.map((e) => (
                  <li key={e} className="flex gap-2.5 leading-relaxed">
                    <span className="mt-2 size-1.5 shrink-0 rounded-full bg-foreground/30" aria-hidden />
                    <span>{e}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
          <p className="text-xs text-muted-foreground">Coop keeps a record that this was decided and then undone.</p>
        </div>

        <div className="flex flex-wrap justify-end gap-2">
          <Button autoFocus variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              onConfirm();
              close();
            }}
          >
            <RotateCcw className="size-3.5" /> Undo it
          </Button>
        </div>
      </div>
    </ModalShell>
  );
}
