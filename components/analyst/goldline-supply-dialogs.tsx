'use client';

// Dialogs behind the Goldline Inventory board's controls: record a warehouse → store
// shipment, set warehouse stock, change a price, and the supply settings (lead times).
// Each calls a server action that re-checks company, role and store scope.

import {useMemo, useState, useTransition} from 'react';
import {useRouter} from 'next/navigation';
import {Dialog} from '@base-ui/react/dialog';
import {Loader2, Truck, X} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {SearchableSelect} from '@/components/analyst/searchable-select';
import {fmtDay} from '@/components/analyst/goldline-ops-shared';
import {recordShipmentAction, saveSupplySettingsAction, setPriceAction, setWarehouseStockAction} from '@/app/stock/actions';
import type {SupplyConfig} from '@/src/goldline-supply';
import {cn} from '@/lib/utils';

const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const FIELD =
  'h-9 w-full rounded-md border border-border bg-background px-2.5 text-sm tabular-nums outline-none transition-colors hover:border-foreground/25 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40 disabled:opacity-60';

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  wide,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: React.ReactNode;
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/45 transition-opacity duration-150 ease-out data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
        <Dialog.Popup
          className={cn(
            'fixed top-1/2 left-1/2 z-50 flex max-h-[min(44rem,calc(100dvh-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 overflow-hidden rounded-xl border border-border bg-popover p-5 text-popover-foreground shadow-xl outline-none transition-[opacity,transform] duration-150 ease-out data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0',
            wide ? 'w-[min(40rem,calc(100vw-2rem))]' : 'w-[min(26rem,calc(100vw-2rem))]',
          )}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 flex-col gap-1">
              <Dialog.Title className="font-heading text-base font-semibold">{title}</Dialog.Title>
              {description && <Dialog.Description className="text-sm text-muted-foreground">{description}</Dialog.Description>}
            </div>
            <Dialog.Close aria-label="Close" className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
              <X className="size-4" />
            </Dialog.Close>
          </div>
          {children}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Footer({error, pending, onCancel, submitLabel, disabled}: {error: string | null; pending: boolean; onCancel: () => void; submitLabel: string; disabled?: boolean}) {
  return (
    <div className="flex flex-col gap-2">
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
        <Button type="submit" disabled={pending || disabled}>
          {pending && <Loader2 className="size-4 animate-spin" />}
          {submitLabel}
        </Button>
      </div>
    </div>
  );
}

export type ShipTarget = {store: string | null; item: string | null; need?: number};

export function ShipmentDialog({
  company,
  open,
  onClose,
  initial,
  stores,
  items,
  warehouse,
  config,
  today,
}: {
  company: string | null;
  open: boolean;
  onClose: () => void;
  initial: ShipTarget;
  stores: Array<{code: string; name: string | null}>;
  items: Array<{code: string; label: string}>;
  warehouse: Record<string, number>;
  config: SupplyConfig;
  today: string;
}) {
  const router = useRouter();
  // From "All stores" the store must be picked — never silently the first one.
  const [store, setStore] = useState(initial.store ?? (stores.length === 1 ? stores[0].code : ''));
  const [item, setItem] = useState(initial.item ?? '');
  const [qty, setQty] = useState(initial.need ? String(initial.need) : '');
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const available = item ? (warehouse[item] ?? 0) : null;
  const days = store ? (config.storeTransitDays[store] ?? config.defaultTransitDays) : null;
  const n = Number(qty);
  const valid = store && item && Number.isInteger(n) && n > 0 && (available == null || n <= available);

  return (
    <Modal open={open} onClose={onClose} title="Record a shipment" description="Send units from the warehouse to a store. They show as on the way until the store's next count records the delivery.">
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!valid) return;
          setError(null);
          start(async () => {
            const res = await recordShipmentAction({company, store, item, qty: n});
            if (!res.ok) return setError(res.error);
            router.refresh();
            onClose();
          });
        }}
      >
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium">To store</span>
          <SearchableSelect
            ariaLabel="Store"
            placeholder="Choose a store…"
            value={store}
            onChange={setStore}
            options={stores.map((s) => ({value: s.code, label: s.name ? `${s.code} · ${s.name}` : `Store ${s.code}`}))}
            className="h-9"
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium">Product</span>
          <SearchableSelect ariaLabel="Product" value={item} onChange={setItem} placeholder="Search a product…" options={items.map((i) => ({value: i.code, label: i.label}))} className="h-9" />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium">Units</span>
            <input type="number" min={1} max={available ?? undefined} inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value)} className={FIELD} autoFocus={Boolean(initial.item)} />
          </label>
          <div className="flex flex-col justify-end gap-0.5 text-xs text-muted-foreground">
            <span>
              In the warehouse: <span className="font-mono font-semibold text-foreground tabular-nums">{available ?? '—'}</span>
            </span>
            {days != null && (
              <span className="inline-flex items-center gap-1">
                <Truck className="size-3.5" aria-hidden /> arrives ~{fmtDay(addDays(today, days))} ({days} {days === 1 ? 'day' : 'days'})
              </span>
            )}
          </div>
        </div>
        {available != null && n > available && <p className="text-xs text-destructive">Only {available} in the warehouse.</p>}
        <Footer error={error} pending={pending} onCancel={onClose} submitLabel="Record shipment" disabled={!valid} />
      </form>
    </Modal>
  );
}

export function NumberDialog({
  open,
  onClose,
  title,
  description,
  label,
  initial,
  min = 0,
  step = 1,
  prefix,
  submitLabel,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: React.ReactNode;
  label: string;
  initial: number | null;
  min?: number;
  step?: number;
  prefix?: string;
  submitLabel: string;
  onSubmit: (value: number) => Promise<{ok: true} | {ok: false; error: string}>;
}) {
  const router = useRouter();
  const [value, setValue] = useState(initial == null ? '' : String(initial));
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const n = Number(value);
  const valid = value.trim() !== '' && Number.isFinite(n) && n >= min && (step !== 1 || Number.isInteger(n));
  return (
    <Modal open={open} onClose={onClose} title={title} description={description}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!valid) return;
          setError(null);
          start(async () => {
            const res = await onSubmit(n);
            if (!res.ok) return setError(res.error);
            router.refresh();
            onClose();
          });
        }}
      >
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium">{label}</span>
          <span className="relative">
            {prefix && <span className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-sm text-muted-foreground">{prefix}</span>}
            <input type="number" min={min} step={step} inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} className={cn(FIELD, prefix && 'pl-6')} autoFocus />
          </span>
          {initial != null && valid && n !== initial && (
            <span className="font-mono text-xs text-muted-foreground">
              {prefix}
              {initial} → {prefix}
              {n}
            </span>
          )}
        </label>
        <Footer error={error} pending={pending} onCancel={onClose} submitLabel={submitLabel} disabled={!valid} />
      </form>
    </Modal>
  );
}

export const warehouseSubmit = (company: string | null, item: string) => (v: number) => setWarehouseStockAction({company, item, onHand: v});
export const priceSubmit = (company: string | null, item: string) => (v: number) => setPriceAction({company, item, price: v});

export function SupplySettingsDialog({
  company,
  open,
  onClose,
  config,
  stores,
  productLines,
  storeScoped,
}: {
  company: string | null;
  open: boolean;
  onClose: () => void;
  config: SupplyConfig;
  stores: Array<{code: string; name: string | null}>;
  productLines: string[];
  storeScoped: boolean;
}) {
  const router = useRouter();
  const [prod, setProd] = useState(String(config.defaultProductionDays));
  const [transit, setTransit] = useState(String(config.defaultTransitDays));
  const [storeDays, setStoreDays] = useState<Record<string, string>>(() =>
    Object.fromEntries(stores.map((s) => [s.code, config.storeTransitDays[s.code] == null ? '' : String(config.storeTransitDays[s.code])])),
  );
  const [lineDays, setLineDays] = useState<Record<string, string>>(() =>
    Object.fromEntries(productLines.map((l) => [l, config.lineProductionDays[l] == null ? '' : String(config.lineProductionDays[l])])),
  );
  const [lineQuery, setLineQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const shownLines = useMemo(() => productLines.filter((l) => l.toLowerCase().includes(lineQuery.trim().toLowerCase())), [productLines, lineQuery]);
  const int = (s: string) => (s.trim() === '' ? null : Number(s));

  const defaultsValid = storeScoped || (prod.trim() !== '' && transit.trim() !== '' && Number.isInteger(Number(prod)) && Number.isInteger(Number(transit)));

  function save() {
    if (!defaultsValid) return setError('Fill in both default lead times (whole days).');
    const defaults = storeScoped ? null : {productionDays: Number(prod), transitDays: Number(transit)};
    // Only rows that changed (so untouched sample values stay marked as samples).
    const stChanged = stores
      .filter((s) => int(storeDays[s.code]) != null && int(storeDays[s.code]) !== (config.storeTransitDays[s.code] ?? null))
      .map((s) => ({store: s.code, days: int(storeDays[s.code]) as number}));
    const lnChanged = storeScoped
      ? []
      : productLines
          .filter((l) => int(lineDays[l]) != null && int(lineDays[l]) !== (config.lineProductionDays[l] ?? null))
          .map((l) => ({line: l, days: int(lineDays[l]) as number}));
    const defaultsChanged = defaults && (defaults.productionDays !== config.defaultProductionDays || defaults.transitDays !== config.defaultTransitDays);
    setError(null);
    start(async () => {
      const res = await saveSupplySettingsAction({company, defaults: defaultsChanged ? defaults : null, lines: lnChanged, stores: stChanged});
      if (!res.ok) return setError(res.error);
      router.refresh();
      onClose();
    });
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      wide
      title="Supply settings"
      description={
        config.isSample ? (
          <span>
            These start as <span className="font-medium text-foreground">sample values</span> until the real lead times are gathered. Anything you edit is saved as real.
          </span>
        ) : (
          'Lead times used for "ship by" and "produce by".'
        )
      }
    >
      <form
        className="flex min-h-0 flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <div className="flex min-h-0 flex-col gap-5 overflow-y-auto pr-1">
          {!storeScoped && (
            <fieldset className="grid grid-cols-2 gap-3">
              <legend className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Defaults</legend>
              <label className="flex flex-col gap-1.5">
                <span className="text-xs font-medium">Production time (days)</span>
                <input type="number" min={0} max={365} value={prod} onChange={(e) => setProd(e.target.value)} className={FIELD} />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-xs font-medium">Delivery time (days)</span>
                <input type="number" min={0} max={60} value={transit} onChange={(e) => setTransit(e.target.value)} className={FIELD} />
              </label>
            </fieldset>
          )}

          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Warehouse → store delivery time</legend>
            <div className="grid gap-x-4 gap-y-2 sm:grid-cols-2">
              {stores.map((s) => (
                <label key={s.code} className="flex items-center justify-between gap-3 text-sm">
                  <span className="truncate">{s.name ? `${s.code} · ${s.name}` : `Store ${s.code}`}</span>
                  <span className="flex items-center gap-1.5">
                    <input
                      type="number"
                      min={0}
                      max={60}
                      aria-label={`Delivery days for ${s.name ?? s.code}`}
                      placeholder={String(config.defaultTransitDays)}
                      value={storeDays[s.code] ?? ''}
                      onChange={(e) => setStoreDays((d) => ({...d, [s.code]: e.target.value}))}
                      className={cn(FIELD, 'h-8 w-16 text-right')}
                    />
                    <span className="text-xs text-muted-foreground">days</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          {!storeScoped && (
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Production time by product line</legend>
              <input value={lineQuery} onChange={(e) => setLineQuery(e.target.value)} placeholder="Filter product lines…" aria-label="Filter product lines" className={cn(FIELD, 'h-8')} />
              <div className="grid gap-x-4 gap-y-2 sm:grid-cols-2">
                {shownLines.map((l) => (
                  <label key={l} className="flex items-center justify-between gap-3 text-sm">
                    <span className="truncate" title={l}>
                      {l}
                    </span>
                    <span className="flex items-center gap-1.5">
                      <input
                        type="number"
                        min={0}
                        max={365}
                        aria-label={`Production days for ${l}`}
                        placeholder={String(config.defaultProductionDays)}
                        value={lineDays[l] ?? ''}
                        onChange={(e) => setLineDays((d) => ({...d, [l]: e.target.value}))}
                        className={cn(FIELD, 'h-8 w-16 text-right')}
                      />
                      <span className="text-xs text-muted-foreground">days</span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
          )}
        </div>
        <Footer error={error} pending={pending} onCancel={onClose} submitLabel="Save settings" />
      </form>
    </Modal>
  );
}
