'use client';

import {useCallback, useEffect, useRef, useState, useTransition} from 'react';
import Link from 'next/link';
import {usePathname, useRouter, useSearchParams} from 'next/navigation';
import {ArrowLeft, Ban, Gift, Loader2, Minus, PawPrint, Pencil, Plus, Receipt, RotateCcw, TriangleAlert, X} from 'lucide-react';
import type {PosOrder, PosOrdersFilter, PriceBounds, PosCatalogItem, PosBundleDef, EditEntry} from '@/src/pos-sales-types';
import {isFilterActive, manilaDayKey, orderToEntries, type PageInfo} from '@/src/pos-sales-compute';
import {formatPeso, paymentMethodLabel, paymentMethodBadgeClass} from '@/src/pos-format';
import {voidOrderAction, unvoidOrderAction, editOrderAction} from '@/src/pos-sales-actions';
import {addPrizeAction, voidPrizeAction, getOrderPrizeContextAction} from '@/src/pos-prize-actions';
import type {OrderPrizeContext} from '@/src/pos-prize-data';
import {cn} from '@/lib/utils';
import {Badge} from '@/components/ui/badge';
import {Button} from '@/components/ui/button';
import {Eyebrow, MockNote} from './sections';
import {SearchableSelect} from './searchable-select';
import {TransactionFilters} from './transaction-filters';
import {RefreshControl} from './refresh-control';
import {Pagination} from './pagination';

// Methods offered in the edit form's payment-method picker.
const EDIT_METHODS = ['cash', 'qrph', 'gcash', 'maya', 'card'];

// Pet-type chips in the edit form. Colors match the Pet mix legend (dog blue,
// cat purple, both green). Clicking the active chip clears back to untagged.
const PET_OPTIONS: {key: 'dog' | 'cat' | 'both'; emoji: string; label: string; color: string}[] = [
  {key: 'dog', emoji: '🐶', label: 'Dog', color: '#3b82f6'},
  {key: 'cat', emoji: '🐱', label: 'Cat', color: '#a855f7'},
  {key: 'both', emoji: '🐶🐱', label: 'Both', color: '#22c55e'},
];

const timeLabel = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'});

export function OfflineOrdersView({
  orders,
  pageInfo,
  filter,
  bounds,
  catalog,
  bundles,
  prizeOrderUuids,
  usingMock,
  fetchedAt,
}: {
  orders: PosOrder[];
  pageInfo: PageInfo;
  filter: PosOrdersFilter;
  bounds: PriceBounds;
  catalog: PosCatalogItem[];
  bundles: PosBundleDef[];
  prizeOrderUuids: string[]; // client_uuids of orders with a non-voided prize
  usingMock: boolean;
  fetchedAt: string;
}) {
  const {page, totalPages, pageSize} = pageInfo;
  const firstOnPage = (page - 1) * pageSize;
  const filtered = isFilterActive(filter);
  // Set for O(1) lookup when tagging each tile with the "Free item" badge.
  const prizeOrders = new Set(prizeOrderUuids);

  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const pageHref = (p: number) => {
    const params = new URLSearchParams(searchParams?.toString());
    params.set('page', String(p));
    return `${pathname}?${params.toString()}`;
  };

  // Voiding restocks the sale; unvoiding re-applies it. Both confirm first, then
  // re-fetch the server data so the row + totals update. actingId tracks whichever
  // order is mid-flight so only its button shows a spinner.
  const [actingId, setActingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const voidOrder = (o: PosOrder) => {
    if (o.status === 'voided') return;
    const ok = window.confirm(
      `Void this ₱${o.total.toLocaleString()} sale?\n\nIts items will be added back to stock. You can unvoid it later.`,
    );
    if (!ok) return;
    setActionError(null);
    setActingId(o.client_uuid);
    startTransition(async () => {
      const res = await voidOrderAction(o.client_uuid);
      setActingId(null);
      if (!res.ok) setActionError(res.error);
      else router.refresh();
    });
  };

  // Unvoid restores a voided sale (re-applies its inventory + revenue).
  const unvoidOrder = (o: PosOrder) => {
    if (o.status !== 'voided') return;
    const ok = window.confirm(
      `Unvoid this ₱${o.total.toLocaleString()} sale?\n\nIt will be restored and its items taken back out of stock.`,
    );
    if (!ok) return;
    setActionError(null);
    setActingId(o.client_uuid);
    startTransition(async () => {
      const res = await unvoidOrderAction(o.client_uuid);
      setActingId(null);
      if (!res.ok) setActionError(res.error);
      else router.refresh();
    });
  };

  // The order currently open in the edit modal (null = closed).
  const [editing, setEditing] = useState<PosOrder | null>(null);

  // Group this page's sales by Manila calendar day (newest first, as fetched) so
  // each row only needs its time; the day reads once in the group header.
  const todayKey = manilaDayKey(new Date().toISOString());
  const groups: {day: string; orders: PosOrder[]}[] = [];
  for (const o of orders) {
    const day = manilaDayKey(o.created_at);
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.orders.push(o);
    else groups.push({day, orders: [o]});
  }
  const shownFrom = pageInfo.total === 0 ? 0 : firstOnPage + 1;
  const shownTo = firstOnPage + orders.length;

  return (
    <div className="w-full px-6 py-8 md:px-10 max-md:px-4 max-md:py-6">
      <Link href="/offline-sales" className="mb-3 inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-3.5" /> Offline Sales
      </Link>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <Eyebrow icon={Receipt}>All transactions</Eyebrow>
          <p className="text-sm text-muted-foreground">Every offline sale synced from the POS, newest first.</p>
        </div>
        <RefreshControl fetchedAt={fetchedAt} />
      </div>

      {usingMock && (
        <MockNote>
          Mock sales. Set <code>SUPABASE_URL_ARCHIVE</code> / <code>SUPABASE_SERVICE_ROLE_KEY_ARCHIVE</code> to the
          Staging project to load real <code>pos_orders</code>.
        </MockNote>
      )}

      <TransactionFilters filter={filter} bounds={bounds} />

      <p className="mb-3 text-xs tabular-nums text-muted-foreground">
        {pageInfo.total} {pageInfo.total === 1 ? 'transaction' : 'transactions'}
        {filtered ? ' match these filters' : ''}
      </p>

      {actionError && (
        <div role="alert" className="mb-3 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          Couldn&rsquo;t update order: {actionError}
        </div>
      )}

      {orders.length === 0 ? (
        <div className="rounded-xl border bg-card py-12 text-center text-sm text-muted-foreground">
          {filtered ? 'No transactions match these filters.' : 'No transactions yet.'}
        </div>
      ) : (
        <div className="flex flex-col gap-5">
          {groups.map((g) => (
            <section key={g.day} aria-label={dayHeading(g.day, todayKey)}>
              <h3 className="mb-2 flex items-baseline gap-2 px-1 text-xs font-semibold text-foreground">
                {dayHeading(g.day, todayKey)}
                <span className="font-normal text-muted-foreground">
                  {g.orders.length} {g.orders.length === 1 ? 'sale' : 'sales'}
                </span>
              </h3>
              <ul className="divide-y overflow-hidden rounded-xl border bg-card">
                {g.orders.map((o) => (
                  <OrderRow
                    key={o.id}
                    order={o}
                    prize={prizeOrders.has(o.client_uuid)}
                    acting={pending && actingId === o.client_uuid}
                    onEdit={() => setEditing(o)}
                    onVoid={() => voidOrder(o)}
                    onUnvoid={() => unvoidOrder(o)}
                  />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      {editing && (
        <EditOrderModal
          order={editing}
          catalog={catalog}
          bundles={bundles}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            router.refresh();
          }}
        />
      )}

      {pageInfo.total > 0 && (
        <div className="mt-6 flex flex-col items-center gap-3 border-t pt-4 sm:flex-row sm:justify-between">
          <p className="text-xs tabular-nums text-muted-foreground">
            Showing {shownFrom} to {shownTo} of {pageInfo.total}
          </p>
          <Pagination page={page} pageCount={totalPages} hrefFor={pageHref} label="Transactions pagination" alwaysShow />
        </div>
      )}
    </div>
  );
}

/** "Today · Oct 10", "Yesterday · Oct 9", or "Wed, Oct 7, 2026". */
function dayHeading(day: string, todayKey: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  const short = d.toLocaleDateString('en-US', {month: 'short', day: 'numeric', timeZone: 'UTC'});
  if (day === todayKey) return `Today · ${short}`;
  const y = new Date(`${todayKey}T00:00:00Z`);
  y.setUTCDate(y.getUTCDate() - 1);
  if (day === y.toISOString().slice(0, 10)) return `Yesterday · ${short}`;
  return d.toLocaleDateString('en-US', {weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC'});
}

/** One sale: time, what was bought, its tags, the total, and row actions. */
function OrderRow({
  order: o,
  prize,
  acting,
  onEdit,
  onVoid,
  onUnvoid,
}: {
  order: PosOrder;
  prize: boolean;
  acting: boolean;
  onEdit: () => void;
  onVoid: () => void;
  onUnvoid: () => void;
}) {
  const voided = o.status === 'voided';
  const units = o.items.reduce((s, it) => s + it.qty, 0);
  const itemsText = o.items.map((it) => `${it.name} ×${it.qty}`).join(', ') || 'No items';
  const iconBtn =
    'inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-[color,background-color,transform] duration-150 ease-out hover:bg-muted active:scale-[0.95] disabled:opacity-50';

  return (
    <li className={cn('group grid grid-cols-[4.5rem_1fr_auto] items-start gap-x-4 sm:items-center px-4 py-3.5 transition-colors hover:bg-muted/30 sm:px-5', voided && 'bg-muted/20')}>
      <time dateTime={o.created_at} className="pt-px text-xs sm:self-start sm:pt-0.5 font-medium tabular-nums text-muted-foreground">
        {new Date(o.created_at).toLocaleTimeString(undefined, {hour: 'numeric', minute: '2-digit'})}
      </time>

      <div className="min-w-0">
        <p title={itemsText} className={cn('line-clamp-2 text-sm leading-snug', voided ? 'text-muted-foreground line-through' : 'text-foreground')}>
          {itemsText}
        </p>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <span className={cn('inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium', paymentMethodBadgeClass(o.payment_method))}>
            {paymentMethodLabel(o.payment_method)}
          </span>
          {prize && (
            <span className="inline-flex items-center gap-1 rounded-md bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-400">
              <Gift className="size-3" /> Free item
            </span>
          )}
          {o.customer_handle && (
            <span className="inline-flex items-center gap-1 rounded-md bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
              <PawPrint className="size-3" /> {o.customer_handle}
            </span>
          )}
          {voided && <Badge variant="destructive">Voided</Badge>}
          {o.edited_at && !voided && (
            <span className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
              <Pencil className="size-3" /> Edited
            </span>
          )}
          {o.oversold && (
            <Badge variant="destructive">
              <TriangleAlert /> Oversold
            </Badge>
          )}
          <span className="text-xs tabular-nums text-muted-foreground">
            {units} {units === 1 ? 'unit' : 'units'}
          </span>
        </div>
        {o.remarks && <p className="mt-1.5 text-xs italic text-muted-foreground/80">&ldquo;{o.remarks}&rdquo;</p>}
      </div>

      <div className="flex flex-col items-end gap-1 sm:flex-row-reverse sm:items-center sm:gap-3">
        <span className={cn('text-base font-semibold tabular-nums sm:min-w-[5.5rem] sm:text-right', voided && 'text-muted-foreground line-through')}>{formatPeso(o.total)}</span>
        <div className="flex items-center gap-0.5 transition-opacity duration-150 [@media(hover:hover)]:opacity-60 [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:group-focus-within:opacity-100">
          {!voided ? (
            <>
              {/* Every non-voided order is editable, bundles included: the editor
                  rebuilds bundle groups and the RPC re-derives the total. */}
              <button type="button" onClick={onEdit} aria-label="Edit sale" title="Edit" className={cn(iconBtn, 'hover:text-primary')}>
                <Pencil className="size-3.5" />
              </button>
              <button type="button" onClick={onVoid} disabled={acting} aria-label="Void sale" title="Void" className={cn(iconBtn, 'hover:text-destructive')}>
                {acting ? <Loader2 className="size-3.5 animate-spin" /> : <Ban className="size-3.5" />}
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={onUnvoid}
              disabled={acting}
              className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-xs font-medium text-muted-foreground transition-[color,background-color,transform] duration-150 ease-out hover:bg-muted hover:text-emerald-600 active:scale-[0.97] disabled:opacity-50 dark:hover:text-emerald-400"
            >
              {acting ? <Loader2 className="size-3.5 animate-spin" /> : <RotateCcw className="size-3.5" />} Unvoid
            </button>
          )}
        </div>
      </div>
    </li>
  );
}

type DraftItem = {kind: 'item'; product_id: string; qty: string; unit_price: string};
type DraftPick = {product_id: string; qty: string};
type DraftBundle = {kind: 'bundle'; bundle_id: string; price: string; picks: DraftPick[]};
type DraftEntry = DraftItem | DraftBundle;

/** Edit an order end-to-end: payment method, IG handle, individual items, and
 *  bundle groups. Bundles keep their rules, a "pick N" bundle enforces exactly N
 *  picks from its eligible categories; a fixed bundle shows its components; both
 *  let you edit the bundle price. You can freely add items or bundles to any
 *  order. Saving calls edit_pos_order, which re-derives stock + total and
 *  re-checks every bundle rule server-side. */
function EditOrderModal({
  order,
  catalog,
  bundles,
  onClose,
  onSaved,
}: {
  order: PosOrder;
  catalog: PosCatalogItem[];
  bundles: PosBundleDef[];
  onClose: () => void;
  onSaved: () => void;
}) {
  // Options = the catalog PLUS any SKU already on this order that's since been
  // unlisted, so an existing line always shows its product instead of blank.
  const catalogSkus = new Set(catalog.map((c) => c.product_id));
  const extraOptions: PosCatalogItem[] = order.items
    .filter((it) => it.product_id && !catalogSkus.has(it.product_id))
    .map((it) => ({product_id: it.product_id as string, name: `${it.name} (unlisted)`, price: it.unit_price, category: null}));
  const options: PosCatalogItem[] = [...extraOptions, ...catalog];
  const priceBySku = new Map(options.map((c) => [c.product_id, c.price ?? 0]));
  const bundleById = new Map(bundles.map((b) => [b.bundle_id, b]));

  const [method, setMethod] = useState(order.payment_method ?? 'cash');
  const [handle, setHandle] = useState(order.customer_handle ?? '');
  const [petType, setPetType] = useState<'dog' | 'cat' | 'both' | null>(
    (order.pet_type as 'dog' | 'cat' | 'both' | null) ?? null,
  );
  const [entries, setEntries] = useState<DraftEntry[]>(() =>
    orderToEntries(order, bundles.map((b) => ({bundle_id: b.bundle_id, bundle_type: b.bundle_type, pick_count: b.pick_count, price: b.price}))).map((e): DraftEntry =>
      e.kind === 'item'
        ? {kind: 'item', product_id: e.product_id, qty: String(e.qty), unit_price: String(e.unit_price)}
        : {kind: 'bundle', bundle_id: e.bundle_id, price: String(e.price), picks: e.picks.map((p) => ({product_id: p.product_id, qty: String(p.qty)}))},
    ),
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const eligibleOptions = (b: PosBundleDef | undefined) => {
    if (!b || !b.line_categories || b.line_categories.length === 0) return options;
    return options.filter((c) => c.category != null && b.line_categories!.includes(c.category));
  };
  const picksTotal = (picks: DraftPick[]) => picks.reduce((s, p) => s + (Number(p.qty) || 0), 0);

  const entryTotal = (e: DraftEntry) =>
    e.kind === 'item' ? (Number(e.qty) || 0) * (Number(e.unit_price) || 0) : Number(e.price) || 0;
  const total = entries.reduce((sum, e) => sum + entryTotal(e), 0);

  // A linked pick bundle must have exactly its pick_count picks. A custom
  // (unlinked) bundle is valid as-is — it just carries a price and its picks.
  const bundleProblem = (e: DraftBundle): string | null => {
    if (e.picks.some((p) => !p.product_id)) return 'choose a product for every pick';
    const def = e.bundle_id ? bundleById.get(e.bundle_id) : undefined;
    if (!def || def.bundle_type !== 'pick' || def.pick_count == null) return null;
    const n = picksTotal(e.picks);
    if (n !== def.pick_count) return `needs exactly ${def.pick_count} (has ${n})`;
    return null;
  };
  const canSave =
    entries.length > 0 &&
    entries.every((e) => (e.kind === 'item' ? !!e.product_id && Number(e.qty) > 0 : !bundleProblem(e)));

  const patchEntry = (i: number, next: DraftEntry) => setEntries((es) => es.map((e, idx) => (idx === i ? next : e)));
  const removeEntry = (i: number) => setEntries((es) => es.filter((_, idx) => idx !== i));
  const addItem = () => setEntries((es) => [...es, {kind: 'item', product_id: '', qty: '1', unit_price: '0'}]);
  const addBundle = (id: string) => {
    const def = bundleById.get(id);
    if (!def) return;
    const picks =
      def.bundle_type === 'pick' && def.pick_count
        ? Array.from({length: def.pick_count}, () => ({product_id: '', qty: '1'}))
        : [];
    setEntries((es) => [...es, {kind: 'bundle', bundle_id: id, price: String(def.price), picks}]);
  };

  function save() {
    setError(null);
    const payload: EditEntry[] = entries.map((e) =>
      e.kind === 'item'
        ? {kind: 'item', product_id: e.product_id, qty: Number(e.qty) || 0, unit_price: Number(e.unit_price) || 0}
        : {kind: 'bundle', bundle_id: e.bundle_id, price: Number(e.price) || 0, picks: e.picks.map((p) => ({product_id: p.product_id, qty: Number(p.qty) || 0}))},
    );
    startTransition(async () => {
      const res = await editOrderAction(order.client_uuid, {payment_method: method, customer_handle: handle.trim(), pet_type: petType}, payload);
      if (!res.ok) setError(res.error);
      else onSaved();
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <button type="button" aria-label="Cancel" onClick={onClose} className="absolute inset-0 cursor-default bg-foreground/40 backdrop-blur-[1px]" />
      <div className="relative flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-border bg-popover shadow-lg">
        <div className="flex items-center justify-between border-b px-5 py-3">
          <h2 className="text-sm font-semibold text-foreground">Edit sale · {timeLabel(order.created_at)}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="text-muted-foreground hover:text-foreground">
            <X className="size-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          <div className="mb-4 grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Method</span>
              <select
                value={method}
                onChange={(e) => setMethod(e.target.value)}
                className="h-8 rounded-md border bg-background px-2 text-sm outline-none focus-visible:border-ring"
              >
                {EDIT_METHODS.map((m) => (
                  <option key={m} value={m}>{paymentMethodLabel(m)}</option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Furbaby / IG handle</span>
              <input
                value={handle}
                onChange={(e) => setHandle(e.target.value)}
                placeholder="@username or name"
                className="h-8 rounded-md border bg-background px-2 text-sm outline-none focus-visible:border-ring"
              />
            </label>
          </div>

          <div className="mb-4 flex flex-col gap-1">
            <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Pet type</span>
            <div className="flex gap-1.5">
              {PET_OPTIONS.map((opt) => {
                const active = petType === opt.key;
                return (
                  <button
                    key={opt.key}
                    type="button"
                    // Click the active chip to clear back to untagged (matches the POS cart).
                    onClick={() => setPetType(active ? null : opt.key)}
                    aria-pressed={active}
                    className={cn(
                      'inline-flex flex-1 items-center justify-center gap-1.5 rounded-md border px-2 py-1.5 text-xs font-medium transition-colors',
                      active ? 'border-transparent text-primary-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                    )}
                    style={active ? {backgroundColor: opt.color} : undefined}
                  >
                    <span aria-hidden>{opt.emoji}</span> {opt.label}
                  </button>
                );
              })}
            </div>
          </div>

          <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Items &amp; bundles</span>
          <div className="mt-1.5 flex flex-col gap-2">
            {entries.map((e, i) =>
              e.kind === 'item' ? (
                <div key={i} className="flex items-center gap-2">
                  <select
                    value={e.product_id}
                    onChange={(ev) => patchEntry(i, {...e, product_id: ev.target.value, unit_price: String(priceBySku.get(ev.target.value) ?? e.unit_price)})}
                    className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2 text-sm outline-none focus-visible:border-ring"
                  >
                    <option value="">Select product…</option>
                    {options.map((c) => (
                      <option key={c.product_id} value={c.product_id}>{c.name}</option>
                    ))}
                  </select>
                  <input
                    type="number" inputMode="numeric" aria-label="Quantity" value={e.qty}
                    onChange={(ev) => patchEntry(i, {...e, qty: ev.target.value})}
                    className="h-8 w-12 rounded-md border bg-background px-2 text-right text-sm tabular-nums outline-none focus-visible:border-ring"
                  />
                  <div className="relative w-20">
                    <span className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-xs text-muted-foreground">₱</span>
                    <input
                      type="number" inputMode="decimal" aria-label="Unit price" value={e.unit_price}
                      onChange={(ev) => patchEntry(i, {...e, unit_price: ev.target.value})}
                      className="h-8 w-full rounded-md border bg-background pr-2 pl-5 text-right text-sm tabular-nums outline-none focus-visible:border-ring"
                    />
                  </div>
                  <span className="w-16 shrink-0 text-right text-sm font-medium tabular-nums text-muted-foreground" aria-label="Line subtotal">
                    {formatPeso(entryTotal(e))}
                  </span>
                  <button type="button" onClick={() => removeEntry(i)} aria-label="Remove item" className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:text-destructive">
                    <X className="size-4" />
                  </button>
                </div>
              ) : (
                <BundleEntryCard
                  key={i}
                  entry={e}
                  def={bundleById.get(e.bundle_id)}
                  bundles={bundles}
                  eligible={eligibleOptions(bundleById.get(e.bundle_id))}
                  problem={bundleProblem(e)}
                  onPatch={(next) => patchEntry(i, next)}
                  onRemove={() => removeEntry(i)}
                />
              ),
            )}
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button type="button" onClick={addItem} className="inline-flex items-center gap-1 text-xs font-medium text-primary transition-opacity hover:opacity-80">
              <Plus className="size-3.5" /> Add item
            </button>
            {bundles.length > 0 && (
              <label className="inline-flex items-center gap-1 text-xs font-medium text-primary">
                <Plus className="size-3.5" />
                <select
                  aria-label="Add bundle"
                  value=""
                  onChange={(ev) => {
                    if (ev.target.value) addBundle(ev.target.value);
                    ev.currentTarget.value = '';
                  }}
                  className="h-7 rounded-md border border-transparent bg-transparent px-1 text-xs font-medium text-primary outline-none hover:opacity-80 focus-visible:border-ring"
                >
                  <option value="">Add bundle…</option>
                  {bundles.map((b) => (
                    <option key={b.bundle_id} value={b.bundle_id}>{b.name}</option>
                  ))}
                </select>
              </label>
            )}
          </div>

          {error && (
            <div className="mt-3 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </div>
          )}

          <OrderPrizesSection order={order} />
        </div>

        <div className="flex items-center justify-between border-t px-5 py-3">
          <span className="text-sm font-semibold tabular-nums">Total {formatPeso(total)}</span>
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
            <Button size="sm" onClick={save} disabled={pending || !canSave}>
              {pending ? 'Saving…' : 'Save changes'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** One bundle group inside the edit modal: name + rule, an editable price, and
 *  either pick slots (Buy Any N, restricted to eligible categories, enforced to
 *  exactly N) or the fixed components (read-only). */
function BundleEntryCard({
  entry,
  def,
  bundles,
  eligible,
  problem,
  onPatch,
  onRemove,
}: {
  entry: DraftBundle;
  def: PosBundleDef | undefined;
  bundles: PosBundleDef[];
  eligible: PosCatalogItem[];
  problem: string | null;
  onPatch: (next: DraftBundle) => void;
  onRemove: () => void;
}) {
  // Show pick slots for a "pick" bundle AND for a custom/unlinked bundle (its
  // picks are arbitrary); only a known fixed bundle hides them behind components.
  const showPicks = def?.bundle_type !== 'fixed';
  // Link/relink this group to a bundle (keeps the current picks so a folded legacy
  // bundle doesn't lose them; the pick counter guides any adjustment). Fills an
  // empty price from the chosen bundle's default.
  const relink = (bundle_id: string) => {
    const nd = bundles.find((b) => b.bundle_id === bundle_id);
    onPatch({...entry, bundle_id, price: entry.price && entry.price !== '0' ? entry.price : String(nd?.price ?? 0)});
  };
  const setPick = (j: number, patch: Partial<DraftPick>) =>
    onPatch({...entry, picks: entry.picks.map((p, idx) => (idx === j ? {...p, ...patch} : p))});
  const addPick = () => onPatch({...entry, picks: [...entry.picks, {product_id: '', qty: '1'}]});
  const removePick = (j: number) => onPatch({...entry, picks: entry.picks.filter((_, idx) => idx !== j)});
  const picked = entry.picks.reduce((s, p) => s + (Number(p.qty) || 0), 0);

  return (
    <div className="rounded-lg border border-border bg-background/40 p-2.5">
      <div className="flex items-center gap-2">
        <span className="inline-flex items-center rounded-md bg-primary/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary">Bundle</span>
        <select
          aria-label="Bundle"
          value={entry.bundle_id}
          onChange={(e) => relink(e.target.value)}
          className={cn('h-8 min-w-0 flex-1 rounded-md border bg-background px-2 text-sm font-medium outline-none focus-visible:border-ring', !entry.bundle_id && 'text-muted-foreground')}
        >
          <option value="">Custom bundle (link…)</option>
          {bundles.map((b) => (
            <option key={b.bundle_id} value={b.bundle_id}>{b.name}</option>
          ))}
        </select>
        <div className="relative w-24">
          <span className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-xs text-muted-foreground">₱</span>
          <input
            type="number" inputMode="decimal" aria-label="Bundle price" value={entry.price}
            onChange={(e) => onPatch({...entry, price: e.target.value})}
            className="h-8 w-full rounded-md border bg-background pr-2 pl-5 text-right text-sm tabular-nums outline-none focus-visible:border-ring"
          />
        </div>
        <button type="button" onClick={onRemove} aria-label="Remove bundle" className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:text-destructive">
          <X className="size-4" />
        </button>
      </div>

      {showPicks ? (
        <div className="mt-2 flex flex-col gap-1.5">
          <div className="flex items-center justify-between text-[11px] text-muted-foreground">
            <span>Picks</span>
            <span className={cn('tabular-nums', problem ? 'text-destructive' : 'text-emerald-500')}>
              {picked}{def?.pick_count != null ? ` / ${def.pick_count}` : ''}
            </span>
          </div>
          {entry.picks.map((p, j) => (
            <div key={j} className="flex items-center gap-2">
              <select
                value={p.product_id}
                onChange={(e) => setPick(j, {product_id: e.target.value})}
                className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2 text-sm outline-none focus-visible:border-ring"
              >
                <option value="">Select pick…</option>
                {eligible.map((c) => (
                  <option key={c.product_id} value={c.product_id}>{c.name}</option>
                ))}
              </select>
              <input
                type="number" inputMode="numeric" aria-label="Pick quantity" value={p.qty}
                onChange={(e) => setPick(j, {qty: e.target.value})}
                className="h-8 w-12 rounded-md border bg-background px-2 text-right text-sm tabular-nums outline-none focus-visible:border-ring"
              />
              <button type="button" onClick={() => removePick(j)} aria-label="Remove pick" className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:text-destructive">
                <X className="size-3.5" />
              </button>
            </div>
          ))}
          <button type="button" onClick={addPick} className="mt-0.5 inline-flex items-center gap-1 self-start text-[11px] font-medium text-primary transition-opacity hover:opacity-80">
            <Plus className="size-3" /> Add pick
          </button>
        </div>
      ) : (
        <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
          {def && def.items.length > 0 ? def.items.map((it) => `${it.name} ×${it.qty}`).join(', ') : 'Fixed bundle'}
        </p>
      )}

      {problem && <p className="mt-1.5 text-[11px] text-destructive">This bundle {problem}.</p>}
    </div>
  );
}

/** "Free items won" section inside the edit modal: lists the spin-a-wheel prizes
 *  already on this order (each undoable) and backfills a new one. It is independent
 *  of the Save button — prizes apply immediately through add_order_prize /
 *  void_order_prize (like the standalone Prizes panel), then re-fetch + router.refresh
 *  so restored/deducted Event stock reflects. The picker only offers products with
 *  Event on-hand and caps qty at that on-hand, so a backfill never oversells. */
function OrderPrizesSection({order}: {order: PosOrder}) {
  const router = useRouter();
  const [ctx, setCtx] = useState<OrderPrizeContext | null>(null);
  const [loading, startLoad] = useTransition();
  const [busy, startBusy] = useTransition();
  const [voidingId, setVoidingId] = useState<string | null>(null);
  const [sku, setSku] = useState('');
  const [qty, setQty] = useState(1);
  const [note, setNote] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [okNote, setOkNote] = useState<string | null>(null);
  // Synchronous guard so a rapid double-click can't fire void_order_prize twice for
  // the same prize (React state lags a render); the disabled UI is a second layer.
  const voidingRef = useRef<Set<string>>(new Set());

  const refetch = useCallback(async () => {
    setCtx(await getOrderPrizeContextAction(order.client_uuid));
  }, [order.client_uuid]);

  useEffect(() => {
    startLoad(() => refetch());
  }, [refetch]);

  const products = ctx?.products ?? [];
  const prizes = ctx?.prizes ?? [];
  const picked = products.find((p) => p.product_id === sku);
  const cap = picked?.event ?? 1;
  const clampedQty = Math.max(1, Math.min(cap, qty));

  const pickProduct = (v: string) => {
    setSku(v);
    setQty(1);
    setErr(null);
    setOkNote(null);
  };

  const add = () => {
    if (!sku || busy) return;
    setErr(null);
    setOkNote(null);
    startBusy(async () => {
      const res = await addPrizeAction({orderClientUuid: order.client_uuid, sku, qty: clampedQty, note: note.trim() || undefined});
      if (!res.ok) {
        setErr(res.error);
        return;
      }
      // The qty cap is against a cached on-hand snapshot; a stale snapshot can still
      // oversell, in which case the RPC flags it. Surface that so Coop can restock.
      if (res.oversold) setOkNote('Added, but that went past the Event on-hand (restock in Coop).');
      setSku('');
      setQty(1);
      setNote('');
      await refetch();
      router.refresh();
    });
  };

  const undo = (clientUuid: string) => {
    // Synchronous ref guard: blocks a rapid double-click before React state catches up.
    if (voidingRef.current.has(clientUuid)) return;
    voidingRef.current.add(clientUuid);
    setErr(null);
    setOkNote(null);
    setVoidingId(clientUuid);
    startBusy(async () => {
      try {
        const res = await voidPrizeAction(clientUuid);
        if (!res.ok) {
          setErr(res.error);
          return;
        }
        await refetch();
        router.refresh();
      } finally {
        voidingRef.current.delete(clientUuid);
        setVoidingId(null);
      }
    });
  };

  return (
    <div className="mt-5 border-t pt-4">
      <span className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        <Gift className="size-3.5" /> Free items won
      </span>

      {loading && !ctx ? (
        <p className="mt-2 text-xs text-muted-foreground">Loading prizes…</p>
      ) : (
        <>
          {prizes.length > 0 && (
            <ul className="mt-2 flex flex-col gap-1.5">
              {prizes.map((p) => (
                <li key={p.client_uuid} className="flex items-center justify-between gap-2 rounded-md border border-border bg-background/40 px-2.5 py-1.5">
                  <span className="min-w-0 truncate text-sm">
                    <span className="font-medium tabular-nums">{p.qty}×</span> {p.product_name}
                  </span>
                  <button
                    type="button"
                    onClick={() => undo(p.client_uuid)}
                    disabled={busy || voidingId === p.client_uuid}
                    aria-label={`Remove prize ${p.product_name}`}
                    title="Undo this prize (restores Event stock)"
                    className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:text-destructive disabled:opacity-50"
                  >
                    <X className="size-4" />
                  </button>
                </li>
              ))}
            </ul>
          )}

          {products.length === 0 ? (
            <p className="mt-2 text-xs text-muted-foreground">No products have Event stock to give as a prize.</p>
          ) : (
            <div className="mt-3 flex flex-col gap-2">
              <SearchableSelect
                value={sku}
                onChange={pickProduct}
                options={products.map((p) => ({value: p.product_id, label: p.name, hint: `${p.event} at Event`}))}
                placeholder="Select a prize product…"
                ariaLabel="Select prize product"
              />
              <div className="flex items-center gap-2">
                <div className="inline-flex items-center rounded-md border bg-background">
                  <button
                    type="button"
                    onClick={() => setQty((q) => Math.max(1, Math.min(cap, q) - 1))}
                    disabled={!sku || clampedQty <= 1}
                    aria-label="Decrease quantity"
                    className="flex size-8 items-center justify-center text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
                  >
                    <Minus className="size-3.5" />
                  </button>
                  <span className="w-8 text-center text-sm font-medium tabular-nums" aria-label="Prize quantity">{clampedQty}</span>
                  <button
                    type="button"
                    onClick={() => setQty((q) => Math.min(cap, Math.max(1, q) + 1))}
                    disabled={!sku || clampedQty >= cap}
                    aria-label="Increase quantity"
                    className="flex size-8 items-center justify-center text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
                  >
                    <Plus className="size-3.5" />
                  </button>
                </div>
                <input
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Note (optional)"
                  aria-label="Prize note"
                  className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2 text-sm outline-none focus-visible:border-ring"
                />
              </div>
              {picked && <span className="text-[11px] text-muted-foreground">{picked.event} on hand at Event.</span>}
              <Button size="sm" variant="outline" onClick={add} disabled={busy || !sku} className="self-start">
                <Gift className="size-3.5" /> {busy ? 'Adding…' : 'Add free item won'}
              </Button>
            </div>
          )}

          {okNote && <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">{okNote}</p>}
          {err && <p className="mt-2 text-xs text-destructive">{err}</p>}
        </>
      )}
    </div>
  );
}

