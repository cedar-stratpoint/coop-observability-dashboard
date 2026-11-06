'use client';

import {useEffect, useRef, useState, useTransition} from 'react';
import {Dialog} from '@base-ui/react/dialog';
import {Lock, X} from 'lucide-react';
import {cn} from '@/lib/utils';
import {HelpTip} from './help-tip';
import {LINE_PARTS, parsePartsInput, sumPesos} from '@/src/plan-parts';
import {parseThousands, toThousands} from '@/src/plan-compute';

// The breakdown form behind a consolidated cell (Fixed overhead, COGS, Content and other). Typed in thousands of pesos like the grid; the cell stores the sum.
// Rule for blanks: EVERY part needs a value (type 0 for none), a blank never counts as 0 by itself. "Total only" is the way out when the split is not known.
// base-ui Dialog gives the focus trap, Escape, scroll lock and aria-modal; focus returns to the grid cell that opened it.
export interface PartsModalProps {
  month: string; monthLabel: string; line: string; lineLabel: string;
  /** The saved total (pesos), null = the cell is empty. */
  total: number | null;
  /** The saved breakdown, only when it still adds up to the total. */
  parts: Record<string, number> | null;
  /** The workbook plan value per part, when it matches the line's target. */
  targets: Record<string, number> | null;
  lineTarget: number | null;
  /** Read-only: a closed month or a reader. */
  readOnly: boolean; closed: boolean; canUnlock: boolean;
  onClose: () => void;
  onUnlock: () => void;
  saveParts: (parts: Record<string, number>) => Promise<string | null>;
  saveTotal: (pesos: number) => Promise<string | null>;
}

const field = 'h-10 w-full rounded-lg border border-border bg-background px-2.5 text-right text-base tabular-nums outline-none transition-colors hover:border-foreground/25 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40 disabled:opacity-60 aria-[invalid=true]:border-[var(--status-crit)] max-md:h-11';

export function PartsModal(p: PartsModalProps) {
  const defs = LINE_PARTS[p.line] ?? [];
  const [texts, setTexts] = useState<Record<string, string>>(() => Object.fromEntries(defs.map((d) => [d.id, p.parts && typeof p.parts[d.id] === 'number' ? toThousands(p.parts[d.id]) : ''])));
  const [totalText, setTotalText] = useState(p.total === null ? '' : toThousands(p.total));
  const [mode, setMode] = useState<'parts' | 'total'>('parts');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [serverErr, setServerErr] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(true);
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => { setOpen(true); }, []);

  const parsed = parsePartsInput(p.line, texts);
  const live = defs.every((d) => (texts[d.id] ?? '').trim() !== '') ? parsed : null; // live total only once every part has a number
  const typedSum = sumPesos(defs.flatMap((d) => { const v = parseThousands(texts[d.id] ?? ''); return v.ok && v.pesos !== null && v.pesos >= 0 ? [v.pesos] : []; }));
  const anyTyped = defs.some((d) => (texts[d.id] ?? '').trim() !== '');
  const savedWithoutParts = p.total !== null && !p.parts;

  const tp = parseThousands(totalText);
  const totalPesos = tp.ok ? tp.pesos : null;

  const submit = () => {
    setServerErr(null);
    if (mode === 'total') {
      const t = parseThousands(totalText);
      if (!t.ok || t.pesos === null) { setErrors({total: t.ok ? 'Enter the total.' : 'Enter a number.'}); return; }
      if (t.pesos < 0) { setErrors({total: 'Cannot be negative.'}); return; }
      setErrors({});
      start(async () => { const e = await p.saveTotal(t.pesos as number); if (e) setServerErr(e); else setOpen(false); });
      return;
    }
    const r = parsePartsInput(p.line, texts);
    if (!r.ok) { setErrors(r.errors); (document.querySelector(`[data-part="${Object.keys(r.errors)[0]}"]`) as HTMLElement | null)?.focus(); return; }
    setErrors({});
    start(async () => { const e = await p.saveParts(r.parts); if (e) setServerErr(e); else setOpen(false); });
  };

  const titleId = 'parts-modal-title';
  const targetTotal = p.lineTarget;
  return (
    <Dialog.Root open={open} onOpenChange={(o) => { if (!o && !pending) setOpen(false); }} onOpenChangeComplete={(o) => { if (!o) p.onClose(); }}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/45 transition-opacity duration-150 ease-out data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
        <Dialog.Popup initialFocus={p.readOnly ? true : first} finalFocus={() => document.querySelector<HTMLElement>(`#all-months [data-month="${p.month}"][data-line="${p.line}"]`)}
          data-testid="parts-modal" aria-labelledby={titleId}
          className="fixed z-50 flex flex-col gap-4 overflow-y-auto border border-border bg-popover p-5 text-popover-foreground outline-none transition-[opacity,transform] duration-180 ease-[cubic-bezier(0.23,1,0.32,1)] data-[ending-style]:opacity-0 data-[starting-style]:opacity-0 max-md:inset-0 md:top-1/2 md:left-1/2 md:max-h-[calc(100dvh-2rem)] md:w-[min(30rem,calc(100vw-2rem))] md:-translate-x-1/2 md:-translate-y-1/2 md:rounded-lg md:data-[ending-style]:scale-[0.98] md:data-[starting-style]:scale-[0.98]">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <Dialog.Title id={titleId} className="font-heading text-base font-semibold">{p.lineLabel} · {p.monthLabel}</Dialog.Title>
              <Dialog.Description className="mt-0.5 flex items-center gap-1 text-[12.5px] text-muted-foreground">
                {p.readOnly ? (p.closed ? <><Lock className="size-3" aria-hidden /> Closed month, read only</> : 'Read only') : 'Breakdown, in thousands of pesos'}
                <HelpTip label="About the breakdown" text="Type each part in thousands of pesos, like the grid. The cell in the grid stores the total of the parts. Type 0 for a part with no cost; a blank part is not saved as 0. If you do not know the split, use Total only." />
              </Dialog.Description>
            </div>
            <Dialog.Close aria-label="Close" className="-m-1.5 flex size-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent"><X className="size-4" aria-hidden /></Dialog.Close>
          </div>

          <form className="flex flex-col gap-3" noValidate onSubmit={(e) => { e.preventDefault(); if (!p.readOnly) submit(); }}>
            {mode === 'parts' ? (
              <ul className="flex flex-col gap-2.5">
                {defs.map((d, k) => {
                  const err = errors[d.id];
                  const tgt = p.targets?.[d.id];
                  return (
                    <li key={d.id} className="grid grid-cols-[1fr_7.5rem] items-center gap-x-3 gap-y-0.5 max-md:grid-cols-[1fr_6.5rem]">
                      <label htmlFor={`part-${d.id}`} className="min-w-0 text-[13.5px]">
                        {d.label}
                        {typeof tgt === 'number' && <span className="ml-1.5 whitespace-nowrap text-[11.5px] text-muted-foreground" data-testid="part-target">target {toThousands(tgt)}</span>}
                      </label>
                      {p.readOnly ? (
                        <output id={`part-${d.id}`} className="block px-2.5 text-right text-base tabular-nums">{texts[d.id] === '' ? <span className="text-muted-foreground">not broken down</span> : texts[d.id]}</output>
                      ) : (
                        <input id={`part-${d.id}`} data-part={d.id} ref={k === 0 ? first : undefined} inputMode="decimal" autoComplete="off" value={texts[d.id] ?? ''} disabled={pending} aria-invalid={err ? true : undefined} aria-describedby={err ? `part-${d.id}-err` : undefined}
                          onChange={(e) => { setTexts((t) => ({...t, [d.id]: e.target.value})); if (err) setErrors((x) => { const {[d.id]: _drop, ...rest} = x; return rest; }); }}
                          onFocus={(e) => e.currentTarget.select()}
                          onKeyDown={(e) => { if (e.key === 'Enter' && k < defs.length - 1) { e.preventDefault(); document.getElementById(`part-${defs[k + 1].id}`)?.focus(); } }}
                          className={field} />
                      )}
                      {err && <span id={`part-${d.id}-err`} role="alert" className="col-span-2 text-right text-[11.5px] leading-tight text-[var(--status-crit)]">{err}</span>}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <div className="grid grid-cols-[1fr_7.5rem] items-center gap-x-3 max-md:grid-cols-[1fr_6.5rem]">
                <label htmlFor="part-total" className="text-[13.5px]">Total</label>
                <input id="part-total" ref={first} inputMode="decimal" autoComplete="off" value={totalText} disabled={pending} aria-invalid={errors.total ? true : undefined} onChange={(e) => { setTotalText(e.target.value); setErrors({}); }} onFocus={(e) => e.currentTarget.select()} className={field} />
                {errors.total && <span role="alert" className="col-span-2 mt-0.5 text-right text-[11.5px] text-[var(--status-crit)]">{errors.total}</span>}
              </div>
            )}

            <div className="flex items-baseline justify-between gap-3 border-t border-border pt-3 text-[13.5px]" data-testid="parts-total">
              <span className="font-medium">Total{mode === 'parts' && !p.readOnly && !live && anyTyped && <span className="ml-1.5 text-[11.5px] font-normal text-muted-foreground">so far</span>}</span>
              <span className="tabular-nums">
                <span className="font-semibold">{p.readOnly ? (p.total === null ? 'not typed' : toThousands(p.total)) : mode === 'total' ? (totalPesos === null ? '' : toThousands(totalPesos)) : (anyTyped ? toThousands(live && live.ok ? live.total : typedSum) : '—')}</span>
                {targetTotal !== null && <span className="ml-2 text-[11.5px] text-muted-foreground">target {toThousands(targetTotal)}</span>}
              </span>
            </div>
            {p.readOnly && p.total !== null && !p.parts && <p className="text-[12px] text-muted-foreground">Only the total was saved for this month, there is no breakdown.</p>}
            {!p.readOnly && savedWithoutParts && mode === 'parts' && <p className="text-[12px] text-muted-foreground">The saved total ({toThousands(p.total as number)}) has no breakdown yet. Saving a breakdown replaces it with the sum of the parts.</p>}
            {serverErr && <p role="alert" className="text-[12.5px] text-[var(--status-crit)]">{serverErr}</p>}

            <div className="flex flex-wrap items-center justify-between gap-2">
              {p.readOnly ? <span /> : (
                <button type="button" onClick={() => { setMode((m) => (m === 'parts' ? 'total' : 'parts')); setErrors({}); setServerErr(null); }} disabled={pending}
                  className="text-[12.5px] text-muted-foreground underline decoration-dotted underline-offset-4 hover:text-foreground max-md:min-h-11">{mode === 'parts' ? 'Total only' : 'Enter the breakdown'}</button>
              )}
              <div className="flex items-center gap-2 max-md:ml-auto">
                {p.readOnly && p.closed && p.canUnlock && <button type="button" onClick={() => { p.onUnlock(); setOpen(false); }} className="rounded-lg border border-border bg-card px-3 py-2 text-sm font-medium hover:bg-accent max-md:min-h-11">Unlock {p.monthLabel}</button>}
                <Dialog.Close className="rounded-lg border border-border bg-card px-3 py-2 text-sm font-medium hover:bg-accent max-md:min-h-11">{p.readOnly ? 'Close' : 'Cancel'}</Dialog.Close>
                {!p.readOnly && <button type="submit" disabled={pending} className={cn('rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-transform active:scale-[0.97] disabled:opacity-60 max-md:min-h-11')}>{pending ? 'Saving' : 'Save'}</button>}
              </div>
            </div>
          </form>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
