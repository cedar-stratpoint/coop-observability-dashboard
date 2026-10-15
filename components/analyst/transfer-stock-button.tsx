'use client';

// Move stock: transfer a product's units between locations (Office <-> Event) via
// transferStockAction (→ transfer_stock RPC). Office is back-stock; Event is what
// the POS sells, and it draws from Office. One product per move (KISS); the qty is
// capped at the source location's on-hand so you can never move stock you lack —
// the RPC enforces this too, this is just the friendly guardrail. Mirrors the
// Add-stock modal's shell, steppers, and footer.

import {useEffect, useId, useState, useTransition} from 'react';
import {useRouter} from 'next/navigation';
import {ArrowLeftRight, ArrowRight, Repeat2, X} from 'lucide-react';
import {cn} from '@/lib/utils';
import {transferStockAction, type LocationCode} from '@/src/pos-transfer-actions';
import {SearchableSelect} from './searchable-select';
import {ModalShell, useModalExit} from './modal-shell';

export interface TransferProduct {
  product_id: string;
  name: string;
  office: number;
  event: number;
}

const DELTAS = [1, 5, 10, 20];
const LOCATIONS: Record<LocationCode, {label: string; sub: string}> = {
  office: {label: 'Office', sub: 'back-stock'},
  event: {label: 'Event', sub: 'sellable'},
};

export function TransferStockButton({products, className}: {products: TransferProduct[]; className?: string}) {
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
        <ArrowLeftRight className="size-3.5" /> Move stock
      </button>
      {open && <TransferModal products={products} onClose={() => setOpen(false)} />}
    </>
  );
}

export function TransferModal({products, initialSku, onClose: onClosed}: {products: TransferProduct[]; initialSku?: string; onClose: () => void}) {
  const {closing, close: onClose} = useModalExit(onClosed);
  const titleId = useId();
  const router = useRouter();
  const [from, setFrom] = useState<LocationCode>('office');
  const [to, setTo] = useState<LocationCode>('event');
  const [sku, setSku] = useState(initialSku ?? '');
  const [qty, setQty] = useState(0);
  const [draft, setDraft] = useState<string | null>(null);
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
  const fromStock = picked ? picked[from] : 0;
  const toStock = picked ? picked[to] : 0;
  const overMax = qty > fromStock;
  const canSubmit = Boolean(sku) && qty > 0 && !overMax && from !== to;

  function swap() {
    setMsg(null);
    setFrom(to);
    setTo(from);
    setQty(0);
    setDraft(null);
  }

  function submit() {
    if (!canSubmit) return;
    setMsg(null);
    startTransition(async () => {
      const res = await transferStockAction({sku, qty, from, to});
      if (res.ok) {
        setMsg({ok: true, text: `Moved ${res.moved} ${picked?.name ?? ''} · ${LOCATIONS[from].label} → ${LOCATIONS[to].label}.`});
        setQty(0);
        setDraft(null);
        router.refresh(); // re-read server on-hand so the pickers show new counts
      } else {
        setMsg({ok: false, text: res.error});
      }
    });
  }

  if (typeof document === 'undefined') return null;
  const qtyValue = draft ?? (qty === 0 ? '' : String(qty));

  return (
    <ModalShell closing={closing} onBackdropClick={onClose} labelledBy={titleId} panelClassName="flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-border bg-popover shadow-lg">
      <div className="flex items-center justify-between border-b px-5 py-4">
        <h2 id={titleId} className="flex items-center gap-2 text-base font-semibold">
          <ArrowLeftRight className="size-4" /> Move stock
        </h2>
        <button type="button" onClick={onClose} aria-label="Close" className="text-muted-foreground hover:text-foreground">
          <X className="size-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-4">
        <p className="mb-4 text-xs text-muted-foreground">
          Event stock draws from Office. Moving units writes a matched transfer out of the source and into the destination.
        </p>

        {/* Direction */}
        <div className="flex items-center gap-2">
          <LocationCell role="From" loc={from} stock={picked ? fromStock : null} />
          <button
            type="button"
            onClick={swap}
            aria-label="Swap direction"
            className="shrink-0 rounded-full border p-1.5 text-muted-foreground transition-colors hover:border-primary hover:text-primary"
          >
            <Repeat2 className="size-4" />
          </button>
          <LocationCell role="To" loc={to} stock={picked ? toStock : null} />
        </div>

        {/* Product */}
        <div className="mt-4">
          <span className="mb-1.5 block font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Product</span>
          <SearchableSelect
            value={sku}
            onChange={(v) => {
              setSku(v);
              setQty(0);
              setDraft(null);
              setMsg(null);
            }}
            options={products.map((p) => ({value: p.product_id, label: p.name}))}
            placeholder="Select product…"
            ariaLabel="Select product"
          />
        </div>

        {/* Quantity */}
        <div className={cn('mt-4', !sku && 'pointer-events-none opacity-40')}>
          <div className="mb-1.5 flex items-baseline justify-between">
            <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Quantity</span>
            {picked && (
              <span className="font-mono text-[10px] text-muted-foreground">
                {fromStock} at {LOCATIONS[from].label}
              </span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <input
              type="text"
              inputMode="numeric"
              value={qtyValue}
              aria-label="Quantity to move"
              placeholder="0"
              onChange={(e) => {
                const v = e.target.value.replace(/[^0-9]/g, '');
                setDraft(v);
                setQty(v === '' ? 0 : parseInt(v, 10));
              }}
              onBlur={() => setDraft(null)}
              className={cn(
                'w-20 rounded-lg border-2 bg-background px-2 py-1.5 text-center font-mono text-[15px] font-bold tabular-nums outline-none',
                overMax ? 'border-destructive text-destructive' : 'border-primary text-primary',
              )}
            />
            {DELTAS.map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => setQty((q) => Math.min(fromStock, q + d))}
                className="min-w-[38px] rounded-md border px-2 py-1.5 font-mono text-[11.5px] font-semibold text-muted-foreground transition-colors hover:border-primary hover:text-primary"
              >
                +{d}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setQty(fromStock)}
              disabled={fromStock <= 0}
              className="rounded-md border px-2 py-1.5 font-mono text-[11.5px] font-semibold text-muted-foreground transition-colors hover:border-primary hover:text-primary disabled:opacity-40"
            >
              All
            </button>
          </div>
          {picked && qty > 0 && !overMax && (
            <p className="mt-2 font-mono text-[11px] text-muted-foreground">
              {LOCATIONS[from].label} {fromStock} → {fromStock - qty} &nbsp;·&nbsp; {LOCATIONS[to].label} {toStock} → {toStock + qty}
            </p>
          )}
          {overMax && (
            <p className="mt-2 text-[11px] text-destructive">Only {fromStock} available at {LOCATIONS[from].label}.</p>
          )}
          {picked && fromStock <= 0 && (
            <p className="mt-2 text-[11px] text-muted-foreground">No stock at {LOCATIONS[from].label} to move — swap the direction or receive stock first.</p>
          )}
        </div>

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
            {pending ? 'Moving…' : qty > 0 && !overMax ? `Move · ${qty}` : 'Move'}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

function LocationCell({role, loc, stock}: {role: string; loc: LocationCode; stock: number | null}) {
  return (
    <div className="flex-1 rounded-xl border bg-card p-3">
      <div className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground">{role}</div>
      <div className="mt-0.5 flex items-baseline gap-1.5">
        <span className="text-sm font-semibold">{LOCATIONS[loc].label}</span>
        <span className="font-mono text-[10px] text-muted-foreground">{LOCATIONS[loc].sub}</span>
      </div>
      <div className="mt-1 font-mono text-[11px] tabular-nums text-muted-foreground">
        {stock === null ? '—' : `${stock} on hand`}
      </div>
    </div>
  );
}
