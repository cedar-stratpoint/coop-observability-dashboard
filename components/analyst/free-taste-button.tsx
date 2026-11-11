'use client';

// Log a free taste from Coop: pick a product, how many packs were opened, an
// optional note; recordFreeTasteAction deducts the Event pool and logs it as
// sampling (separate from sales). Mostly the POS logs these live at events; this
// is the online/backfill path. Mirrors the Add-stock / Move-stock modal shell.

import {useEffect, useId, useState, useTransition} from 'react';
import {createPortal} from 'react-dom';
import {useRouter} from 'next/navigation';
import {Dog, X} from 'lucide-react';
import {cn} from '@/lib/utils';
import {recordFreeTasteAction} from '@/src/pos-free-taste-actions';
import {SearchableSelect} from './searchable-select';

export interface TasteProduct {
  product_id: string;
  name: string;
  event: number; // event on-hand, for context
}

const DELTAS = [1, 2, 5];

export function FreeTasteButton({products, className}: {products: TasteProduct[]; className?: string}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(
          'inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground',
          className,
        )}
      >
        <Dog className="size-3.5" /> Free taste
      </button>
      {open && <FreeTasteModal products={products} onClose={() => setOpen(false)} />}
    </>
  );
}

export function FreeTasteModal({products, onClose}: {products: TasteProduct[]; onClose: () => void}) {
  const titleId = useId();
  const router = useRouter();
  const [sku, setSku] = useState('');
  const [qty, setQty] = useState(1);
  const [draft, setDraft] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ok: boolean; text: string} | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const picked = products.find((p) => p.product_id === sku);
  const canSubmit = Boolean(sku) && qty > 0;

  function submit() {
    if (!canSubmit) return;
    setMsg(null);
    startTransition(async () => {
      const res = await recordFreeTasteAction({sku, qty, note});
      if (res.ok) {
        setMsg({
          ok: true,
          text: `Logged ${qty} ${picked?.name ?? ''} as a free taste${res.oversold ? ' (opened against 0 on-hand).' : '.'}`,
        });
        setSku('');
        setQty(1);
        setDraft(null);
        setNote('');
        router.refresh();
      } else {
        setMsg({ok: false, text: res.error});
      }
    });
  }

  if (typeof document === 'undefined') return null;
  const qtyValue = draft ?? (qty === 0 ? '' : String(qty));

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <button type="button" aria-label="Close" onClick={onClose} className="absolute inset-0 cursor-default bg-foreground/40 backdrop-blur-[1px]" />
      <div className="relative flex max-h-[85vh] w-full max-w-md flex-col overflow-hidden rounded-2xl border border-border bg-popover shadow-lg">
        <div className="flex items-center justify-between border-b px-5 py-4">
          <h2 id={titleId} className="flex items-center gap-2 text-base font-semibold">
            <Dog className="size-4" /> Log a free taste
          </h2>
          <button type="button" onClick={onClose} aria-label="Close" className="text-muted-foreground hover:text-foreground">
            <X className="size-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          <p className="mb-4 text-xs text-muted-foreground">
            Opened stock given to pets to sample. Deducts the Event pool and is logged as sampling, kept separate from sales.
          </p>

          <div>
            <span className="mb-1.5 block font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Product</span>
            <SearchableSelect
              value={sku}
              onChange={(v) => {
                setSku(v);
                setMsg(null);
              }}
              options={products.map((p) => ({value: p.product_id, label: p.name, hint: `${p.event}`}))}
              placeholder="Select product…"
              ariaLabel="Select product"
            />
            {picked && (
              <span className="mt-1.5 block font-mono text-[10px] text-muted-foreground">{picked.event} on hand at Event</span>
            )}
          </div>

          <div className={cn('mt-4', !sku && 'pointer-events-none opacity-40')}>
            <span className="mb-1.5 block font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Packs opened</span>
            <div className="flex flex-wrap items-center gap-1.5">
              <input
                type="text"
                inputMode="numeric"
                value={qtyValue}
                aria-label="Packs opened"
                placeholder="1"
                onChange={(e) => {
                  const v = e.target.value.replace(/[^0-9]/g, '');
                  setDraft(v);
                  setQty(v === '' ? 0 : parseInt(v, 10));
                }}
                onBlur={() => setDraft(null)}
                className="w-20 rounded-lg border-2 border-primary bg-background px-2 py-1.5 text-center font-mono text-[15px] font-bold tabular-nums text-primary outline-none"
              />
              {DELTAS.map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => setQty((q) => q + d)}
                  className="min-w-[38px] rounded-md border px-2 py-1.5 font-mono text-[11.5px] font-semibold text-muted-foreground transition-colors hover:border-primary hover:text-primary"
                >
                  +{d}
                </button>
              ))}
            </div>
            {picked && qty > picked.event && (
              <p className="mt-2 text-[11px] text-amber-600 dark:text-amber-400">More than the {picked.event} on hand. It will still log and flag as opened against low stock.</p>
            )}
          </div>

          <label className="mt-4 block">
            <span className="mb-1.5 block font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Note <span className="opacity-60">(optional)</span></span>
            <input
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. opened at the Ayala booth"
              className="w-full rounded-md border bg-background px-2.5 py-2 text-sm outline-none focus-visible:border-ring"
            />
          </label>

          {msg && <p className={cn('mt-3 text-xs', msg.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive')}>{msg.text}</p>}
        </div>

        <div className="flex items-center justify-between gap-3 border-t bg-muted/40 px-5 py-3">
          <span className="font-mono text-[11px] text-muted-foreground">🔒 recorded with your account · now</span>
          <div className="flex gap-2">
            <button type="button" onClick={onClose} className="rounded-md border px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground">
              Cancel
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={pending || !canSubmit}
              className="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
            >
              {pending ? 'Logging…' : qty > 0 ? `Log · ${qty}` : 'Log'}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
