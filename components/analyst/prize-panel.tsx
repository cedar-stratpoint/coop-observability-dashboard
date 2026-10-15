'use client';

// Prizes panel (spin-a-wheel free items). Lists which transactions / customers won
// a free item, with an undo, and an "Add prize" modal to backfill a past order.
// A prize deducts the Event pool (reason='free_item'), separate from sales. The POS
// tags prizes live in the cart; this is the online / backfill path.

import {useEffect, useId, useState, useTransition} from 'react';
import {createPortal} from 'react-dom';
import {useRouter} from 'next/navigation';
import Link from 'next/link';
import {CalendarDays, ChevronDown, Gift, Plus, Undo2, X} from 'lucide-react';
import {cn} from '@/lib/utils';
import {addPrizeAction, voidPrizeAction} from '@/src/pos-prize-actions';
import {SearchableSelect} from './searchable-select';
import type {PrizeRow, RecentOrder, PrizeProduct} from '@/src/pos-prize-data';

const DELTAS = [1, 2, 5];
// Prizes shown before "Show all"; two full rows of the 3-across grid.
const PREVIEW = 6;

/** A prize plus the event it was given at (resolved server-side; null = none). */
export type PrizeWithEvent = PrizeRow & {event: {id: string; name: string} | null};

export function PrizePanel({prizes, recentOrders, products}: {prizes: PrizeWithEvent[]; recentOrders: RecentOrder[]; products: PrizeProduct[]}) {
  const router = useRouter();
  const [adding, setAdding] = useState(false);
  const [pendingVoid, startVoid] = useTransition();
  const [voidId, setVoidId] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const active = prizes.filter((p) => !p.voided_at);

  function undo(clientUuid: string | null) {
    if (!clientUuid) return;
    setVoidId(clientUuid);
    startVoid(async () => {
      await voidPrizeAction(clientUuid);
      setVoidId(null);
      router.refresh();
    });
  }

  const shown = showAll ? active : active.slice(0, PREVIEW);

  return (
    <section className="rounded-xl border bg-card p-5 lg:p-6" aria-labelledby="prizes-title">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground" aria-hidden>
            <Gift className="size-4" />
          </span>
          <div>
            <h3 id="prizes-title" className="text-sm font-semibold">
              Free items won
            </h3>
            <p className="text-xs text-muted-foreground">
              Spin-the-wheel prizes given with a sale · {active.length} logged
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="inline-flex h-8 items-center gap-1.5 rounded-lg border bg-background px-3 text-xs font-medium transition-[background-color,transform] duration-150 ease-out hover:bg-muted active:scale-[0.97]"
        >
          <Plus className="size-3.5" /> Add prize
        </button>
      </div>

      {active.length === 0 ? (
        <p className="rounded-lg border border-dashed bg-muted/30 px-4 py-6 text-center text-sm text-muted-foreground">
          No free items logged yet. Use Add prize to record a spin-the-wheel win on a past order.
        </p>
      ) : (
        <>
          <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {shown.map((p) => {
              const undoing = pendingVoid && voidId === p.client_uuid;
              const who = p.customer_handle?.trim() || 'Walk-in';
              const when = new Date(p.won_at).toLocaleDateString('en-PH', {month: 'short', day: 'numeric'});
              return (
                <li
                  key={p.id}
                  className={cn('flex items-center gap-3 rounded-lg border bg-muted/20 px-3.5 py-3 transition-opacity', undoing && 'opacity-50')}
                >
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium" title={p.product_name}>
                        {p.product_name}
                      </span>
                      {p.qty > 1 && <span className="shrink-0 text-xs tabular-nums text-muted-foreground">×{p.qty}</span>}
                    </span>
                    {p.event ? (
                      <Link
                        href={`/offline-sales/events/${p.event.id}`}
                        className="mt-1 flex w-fit max-w-full items-center gap-1 text-xs font-medium text-primary hover:underline"
                        title={`Given at ${p.event.name}`}
                      >
                        <CalendarDays className="size-3.5 shrink-0" aria-hidden />
                        <span className="truncate">{p.event.name}</span>
                      </Link>
                    ) : (
                      <span className="mt-1 flex items-center gap-1 text-xs text-muted-foreground/70">
                        <CalendarDays className="size-3.5 shrink-0" aria-hidden />
                        No event
                      </span>
                    )}
                    <span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
                      <span className="truncate">{who}</span>
                      <span aria-hidden>·</span>
                      {when}
                      {p.note && (
                        <>
                          <span aria-hidden>·</span>
                          <span className="truncate">{p.note}</span>
                        </>
                      )}
                      {p.oversold && (
                        <span
                          className="rounded-full px-2 py-0.5 text-[11px] font-medium"
                          style={{color: 'var(--status-warn)', backgroundColor: 'color-mix(in oklab, var(--status-warn) 14%, transparent)'}}
                        >
                          Low stock
                        </span>
                      )}
                    </span>
                  </span>
                  <button
                    type="button"
                    onClick={() => undo(p.client_uuid)}
                    disabled={!p.client_uuid || undoing}
                    aria-label={`Undo prize: ${p.product_name} for ${who}`}
                    title={p.client_uuid ? 'Undo this prize (restores stock)' : 'Cannot undo (no reference)'}
                    className="grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground transition-[color,background-color,transform] duration-150 ease-out hover:bg-muted hover:text-foreground active:scale-95 disabled:opacity-40"
                  >
                    <Undo2 className="size-4" />
                  </button>
                </li>
              );
            })}
          </ul>
          {active.length > PREVIEW && (
            <div className="mt-4 text-center">
              <button
                type="button"
                onClick={() => setShowAll((v) => !v)}
                aria-expanded={showAll}
                className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
              >
                {showAll ? 'Show fewer' : `Show all ${active.length}`}
                <ChevronDown className={cn('size-3.5 transition-transform duration-200 ease-out', showAll && 'rotate-180')} />
              </button>
            </div>
          )}
        </>
      )}

      {adding && <AddPrizeModal recentOrders={recentOrders} products={products} onClose={() => setAdding(false)} />}
    </section>
  );
}

function AddPrizeModal({recentOrders, products, onClose}: {recentOrders: RecentOrder[]; products: PrizeProduct[]; onClose: () => void}) {
  const titleId = useId();
  const router = useRouter();
  const [orderUuid, setOrderUuid] = useState('');
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
  const canSubmit = Boolean(orderUuid) && Boolean(sku) && qty > 0;

  function submit() {
    if (!canSubmit) return;
    setMsg(null);
    startTransition(async () => {
      const res = await addPrizeAction({orderClientUuid: orderUuid, sku, qty, note});
      if (res.ok) {
        setMsg({ok: true, text: `Prize logged${res.oversold ? ' (opened against 0 on-hand).' : '.'}`});
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
            <Gift className="size-4" /> Add a free item
          </h2>
          <button type="button" onClick={onClose} aria-label="Close" className="text-muted-foreground hover:text-foreground">
            <X className="size-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          <p className="mb-4 text-xs text-muted-foreground">
            Attach a spin-a-wheel prize to a past sale. It deducts the Event pool and is logged as a giveaway, separate from sales.
          </p>

          <div>
            <span className="mb-1.5 block font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Order that won</span>
            <SearchableSelect
              value={orderUuid}
              onChange={(v) => {
                setOrderUuid(v);
                setMsg(null);
              }}
              options={recentOrders.map((o) => ({value: o.client_uuid, label: o.label}))}
              placeholder="Select order…"
              ariaLabel="Select order"
            />
          </div>

          <div className="mt-4">
            <span className="mb-1.5 block font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Prize product</span>
            <SearchableSelect
              value={sku}
              onChange={(v) => setSku(v)}
              options={products.map((p) => ({value: p.product_id, label: p.name, hint: `${p.event}`}))}
              placeholder="Select product…"
              ariaLabel="Select product"
            />
            {picked && <span className="mt-1.5 block font-mono text-[10px] text-muted-foreground">{picked.event} on hand at Event</span>}
          </div>

          <div className={cn('mt-4', !sku && 'pointer-events-none opacity-40')}>
            <span className="mb-1.5 block font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Quantity</span>
            <div className="flex flex-wrap items-center gap-1.5">
              <input
                type="text"
                inputMode="numeric"
                value={qtyValue}
                aria-label="Quantity"
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
                <button key={d} type="button" onClick={() => setQty((q) => q + d)} className="min-w-[38px] rounded-md border px-2 py-1.5 font-mono text-[11.5px] font-semibold text-muted-foreground transition-colors hover:border-primary hover:text-primary">
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
            <input type="text" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. grand-prize spin" className="w-full rounded-md border bg-background px-2.5 py-2 text-sm outline-none focus-visible:border-ring" />
          </label>

          {msg && <p className={cn('mt-3 text-xs', msg.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive')}>{msg.text}</p>}
        </div>

        <div className="flex items-center justify-between gap-3 border-t bg-muted/40 px-5 py-3">
          <span className="font-mono text-[11px] text-muted-foreground">🔒 recorded with your account · now</span>
          <div className="flex gap-2">
            <button type="button" onClick={onClose} className="rounded-md border px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground">Cancel</button>
            <button
              type="button"
              onClick={submit}
              disabled={pending || !canSubmit}
              className="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
            >
              {pending ? 'Logging…' : 'Log prize'}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
