'use client';

// Chrome for the merged Inventory page (Stratpoint / Offline channel): the shared
// InventoryHeader (title, channel switch, Office/Event totals, actions), the
// All products / Bundles / Summary underline tabs, and the venue trigger handed to
// the table's filter bar. Hick's law: Add stock is the one primary action, Move
// stock the secondary, and Free taste / New product sit in a More menu. Tab / channel / venue are URL params
// so the server refetches (monthly sales are venue-scoped); Line/status/search/sort
// stay client-side on the loaded rows.

import {useState, useTransition} from 'react';
import Link from 'next/link';
import {useRouter} from 'next/navigation';
import {Menu} from '@base-ui/react/menu';
import {Dog, MoreHorizontal, Plus, X} from 'lucide-react';
import {cn} from '@/lib/utils';
import {POS_CATEGORIES} from '@/src/pos-format';
import {createProductAction} from '@/src/pos-actions';
import {AddStockButton} from './add-stock-button';
import {TransferStockButton} from './transfer-stock-button';
import {FreeTasteModal} from './free-taste-button';
import {InventoryHeader, HeaderMeta} from './inventory-header';
import {SamplingPanel} from './sampling-panel';
import {InventoryTable} from './inventory-table';
import {InventorySummary} from './inventory-summary';
import {BundleControls} from './bundle-controls';
import type {InventoryPageData} from '@/src/pos-inventory-data';
import type {LocationStockRow} from '@/src/pos-location-data';
import type {FreeTasteSummary} from '@/src/pos-free-taste-data';
import type {PosBundleRow} from '@/src/pos-types';
import {ModalShell, useModalExit} from './modal-shell';

type Tab = 'all' | 'bundles' | 'summary';

export function InventoryView({data, bundles, tab, channel, venue, locations, sampling}: {
  data: InventoryPageData; bundles: PosBundleRow[]; tab: Tab; channel: string; venue: string;
  locations: LocationStockRow[]; sampling: FreeTasteSummary;
}) {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [tasting, setTasting] = useState(false);

  // Build an /inventory href preserving the other params (omitting defaults).
  const href = (next: {tab?: Tab; channel?: string; venue?: string}) => {
    const t = next.tab ?? tab, c = next.channel ?? channel, v = next.venue ?? venue;
    const p = new URLSearchParams();
    if (c && c !== 'offline') p.set('channel', c);
    if (t && t !== 'all') p.set('tab', t);
    if (v && v !== 'all') p.set('venue', v);
    const qs = p.toString();
    return qs ? `/inventory?${qs}` : '/inventory';
  };

  const intake = data.rows.map((r) => ({product_id: r.product_id, name: r.name, stock: r.stock}));

  // Per-location on-hand for the transfer modal + the toolbar Office/Event totals.
  const locById = new Map(locations.map((l) => [l.product_id, l]));
  const transferProducts = data.rows.map((r) => {
    const l = locById.get(r.product_id);
    return {product_id: r.product_id, name: r.name, office: l?.office ?? 0, event: l?.event ?? 0};
  });
  const officeTotal = locations.reduce((s, l) => s + l.office, 0);
  const eventTotal = locations.reduce((s, l) => s + l.event, 0);

  return (
    <div className="mx-auto max-w-6xl px-6 py-8 md:px-10 max-md:px-4 max-md:py-6">
      <InventoryHeader
        channel="offline"
        offlineHref={href({channel: 'offline'})}
        onlineHref={href({channel: 'online'})}
        meta={
          <HeaderMeta demo={data.usingMock}>
            <span><span className="font-medium tabular-nums text-foreground">{officeTotal.toLocaleString()}</span> in Office</span>
            <span aria-hidden className="opacity-50">·</span>
            <span><span className="font-medium tabular-nums text-foreground">{eventTotal.toLocaleString()}</span> at Events</span>
          </HeaderMeta>
        }
        actions={
          <>
            <MoreActions onFreeTaste={() => setTasting(true)} onNewProduct={() => setCreating(true)} />
            <TransferStockButton products={transferProducts} className="h-8 rounded-lg" />
            <AddStockButton products={intake} className="h-8 rounded-lg" />
          </>
        }
      />

      {/* View tabs: an underline nav, so it never reads as a second segmented
          control competing with the channel switch above. */}
      <nav aria-label="Inventory views" className="mb-6 flex gap-6 border-b border-border">
        <TabLink href={href({tab: 'all'})} active={tab === 'all'}>All products</TabLink>
        <TabLink href={href({tab: 'bundles'})} active={tab === 'bundles'}>Bundles</TabLink>
        <TabLink href={href({tab: 'summary'})} active={tab === 'summary'}>Summary</TabLink>
      </nav>

      {tab === 'all' && <SamplingPanel sampling={sampling} />}

      {tab === 'all' ? (
        <InventoryTable
          rows={data.rows}
          usingMock={data.usingMock}
          venue={{value: venue, options: data.venues.map((v) => ({key: v.key, label: v.label})), onChange: (v) => router.push(href({venue: v}), {scroll: false})}}
        />
      ) : tab === 'bundles' ? (
        <BundleControls bundles={bundles} />
      ) : (
        <InventorySummary summary={data.summary} forecastRows={data.forecastRows} config={data.config} plan={data.plan} usingMock={data.usingMock} />
      )}

      {creating && <NewProductDialog usingMock={data.usingMock} onClose={() => setCreating(false)} onCreated={() => {setCreating(false); router.refresh();}} />}
      {tasting && <FreeTasteModal products={transferProducts} onClose={() => setTasting(false)} />}
    </div>
  );
}

function TabLink({href, active, children}: {href: string; active: boolean; children: React.ReactNode}) {
  return (
    <Link href={href} scroll={false} aria-current={active ? 'page' : undefined}
      className={cn(
        'relative -mb-px border-b-2 pb-2.5 text-sm font-medium transition-colors duration-150 focus-visible:text-foreground focus-visible:outline-none',
        active ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:border-border hover:text-foreground',
      )}>
      {children}
    </Link>
  );
}

const MENU_ITEM =
  'flex w-full cursor-default items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-xs font-medium text-foreground outline-none select-none data-[highlighted]:bg-muted';

// Hick's law: Add stock is the one primary action and Move stock the frequent
// secondary; the rarer ones (log a free taste, create a product) live here.
function MoreActions({onFreeTaste, onNewProduct}: {onFreeTaste: () => void; onNewProduct: () => void}) {
  return (
    <Menu.Root>
      <Menu.Trigger
        aria-label="More actions"
        title="More actions"
        className="inline-flex size-8 items-center justify-center rounded-lg border text-muted-foreground outline-none transition-[color,background-color,transform] duration-150 ease-out hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 active:scale-[0.97] data-[popup-open]:bg-muted data-[popup-open]:text-foreground"
      >
        <MoreHorizontal className="size-4" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="bottom" align="end" sideOffset={6} className="z-50">
          <Menu.Popup className="w-48 origin-[var(--transform-origin)] rounded-lg border bg-popover p-1 text-popover-foreground shadow-md outline-none transition-[opacity,transform] duration-150 ease-out data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0">
            <Menu.Item onClick={onFreeTaste} className={MENU_ITEM}>
              <Dog className="size-3.5 text-muted-foreground" aria-hidden /> Log a free taste
            </Menu.Item>
            <Menu.Item onClick={onNewProduct} className={MENU_ITEM}>
              <Plus className="size-3.5 text-muted-foreground" aria-hidden /> New product
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

function NewProductDialog({usingMock, onClose: onClosed, onCreated}: {usingMock: boolean; onClose: () => void; onCreated: () => void}) {
  const {closing, close: onClose} = useModalExit(onClosed);
  const [sku, setSku] = useState('');
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [category, setCategory] = useState('');
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function save() {
    setError(null);
    startTransition(async () => {
      const res = await createProductAction({product_id: sku.trim(), name: name.trim(), price: price.trim() || undefined, category: category || null});
      if (res.ok) onCreated();
      else setError(res.error);
    });
  }
  return (
    <ModalShell closing={closing} onBackdropClick={onClose} backdropLabel="Cancel" panelClassName="w-full max-w-md rounded-xl border bg-popover p-5 shadow-lg">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold">New product</h2>
        <button onClick={onClose} aria-label="Close" className="text-muted-foreground hover:text-foreground"><X className="size-4" /></button>
      </div>
      <div className="flex flex-col gap-3">
        <Field label="SKU Code"><input value={sku} onChange={(e) => setSku(e.target.value)} placeholder="ZMY…" className="w-full rounded-md border bg-background px-2 py-1.5 text-sm outline-none focus-visible:border-ring" /></Field>
        <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} className="w-full rounded-md border bg-background px-2 py-1.5 text-sm outline-none focus-visible:border-ring" /></Field>
        <div className="flex gap-3">
          <Field label="Price"><div className="flex items-center gap-1"><span className="text-sm text-muted-foreground">₱</span><input value={price} inputMode="decimal" onChange={(e) => setPrice(e.target.value.replace(/[^0-9.]/g, ''))} className="w-24 rounded-md border bg-background px-2 py-1.5 text-sm tabular-nums outline-none focus-visible:border-ring" /></div></Field>
          <Field label="Line"><select value={category} onChange={(e) => setCategory(e.target.value)} className="rounded-md border bg-background px-2 py-1.5 text-sm outline-none focus-visible:border-ring"><option value="">—</option>{POS_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}</select></Field>
        </div>
      </div>
      {usingMock && <p className="mt-3 text-xs text-muted-foreground">Demo mode — set the Supabase pos_* env to create.</p>}
      {error && <p className="mt-3 text-xs text-destructive">{error}</p>}
      <div className="mt-4 flex justify-end gap-2">
        <button onClick={onClose} className="rounded-md border px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground">Cancel</button>
        <button onClick={save} disabled={pending || usingMock || !sku.trim() || !name.trim()} className="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50">{pending ? 'Creating…' : 'Create'}</button>
      </div>
    </ModalShell>
  );
}
function Field({label, children}: {label: string; children: React.ReactNode}) {
  return <label className="flex flex-col gap-1"><span className="text-xs font-medium">{label}</span>{children}</label>;
}
