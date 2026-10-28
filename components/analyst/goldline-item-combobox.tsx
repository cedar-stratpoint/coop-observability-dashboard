'use client';

import {useMemo} from 'react';
import {Combobox} from '@base-ui/react/combobox';
import {Check, ChevronsUpDown, Search, X} from 'lucide-react';
import type {SkuLinkItem} from '@/src/goldline-sku-links-data';
import {itemDisplayName} from '@/src/goldline-item-name';
import {cn} from '@/lib/utils';

// The "Choose item" picker on SKU linking (Oct 28): a searchable dropdown in place of the
// long native select. Type any part of the item code, the name, the product line or the
// price; every word has to match (so "blush 299" narrows fast). Items stay grouped by
// product line, each with its price and the form page it's printed on, and a price within
// 15% of what Watsons sells it for is marked, since that's usually the right one.

type Group = {value: string; items: SkuLinkItem[]};

const text = (i: SkuLinkItem) => itemDisplayName(i.productLine, i.variant, i.itemCode);
const haystack = (i: SkuLinkItem) => `${i.itemCode} ${i.productLine ?? ''} ${text(i)} ${i.price ?? ''} page ${i.formSpot?.page ?? ''}`.toLowerCase();
const priceClose = (i: SkuLinkItem, watsons: number | null) => watsons != null && i.price != null && Math.abs(watsons - i.price) <= 0.15 * i.price;

export function ItemCombobox({
  items,
  value,
  onChange,
  watsonsPrice,
  label,
}: {
  items: SkuLinkItem[];
  value: string;
  onChange: (itemCode: string) => void;
  watsonsPrice: number | null;
  label: string;
}) {
  const groups = useMemo<Group[]>(() => {
    const g = new Map<string, SkuLinkItem[]>();
    for (const i of items) {
      const k = i.productLine?.trim() || 'Other';
      g.set(k, [...(g.get(k) ?? []), i]);
    }
    return [...g.entries()].map(([k, v]) => ({value: k, items: v}));
  }, [items]);
  const selected = useMemo(() => items.find((i) => i.itemCode === value) ?? null, [items, value]);

  return (
    <Combobox.Root<SkuLinkItem>
      items={groups}
      value={selected}
      onValueChange={(v) => onChange(v?.itemCode ?? '')}
      itemToStringLabel={(i) => `${i.itemCode} · ${text(i)}`}
      isItemEqualToValue={(a, b) => a.itemCode === b.itemCode}
      filter={(i, q) => {
        const h = haystack(i);
        return q
          .toLowerCase()
          .split(/\s+/)
          .filter(Boolean)
          .every((w) => h.includes(w.replace(/^₱/, '')));
      }}
      autoHighlight
    >
      <div className="relative w-full max-w-xl">
        <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
        <Combobox.Input
          aria-label={label}
          placeholder="Search name, code or price"
          className="h-10 w-full rounded-lg border border-border bg-background pr-16 pl-9 text-sm outline-none transition-[border-color,box-shadow] duration-150 placeholder:text-muted-foreground hover:border-foreground/25 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40"
        />
        <div className="absolute top-1/2 right-1.5 flex -translate-y-1/2 items-center">
          {selected && (
            <Combobox.Clear aria-label="Clear the item" className="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
              <X className="size-3.5" />
            </Combobox.Clear>
          )}
          <Combobox.Trigger aria-label="Show all items" className="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
            <ChevronsUpDown className="size-3.5" />
          </Combobox.Trigger>
        </div>
      </div>
      <Combobox.Portal>
        <Combobox.Positioner sideOffset={6} align="start" className="z-50 outline-none">
          <Combobox.Popup className="flex max-h-[min(24rem,var(--available-height))] w-[max(var(--anchor-width),22rem)] max-w-[calc(100vw-2rem)] origin-[var(--transform-origin)] flex-col overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-lg outline-none transition-[opacity,transform] duration-150 ease-out data-[ending-style]:scale-[0.98] data-[ending-style]:opacity-0 data-[starting-style]:scale-[0.98] data-[starting-style]:opacity-0">
            <Combobox.Empty className="px-4 py-6 text-center text-sm text-muted-foreground empty:hidden">No item matches. Try the code, a shorter word or the price.</Combobox.Empty>
            <Combobox.List className="flex flex-col overflow-y-auto overscroll-contain p-1.5 outline-none data-[empty]:p-0">
              {(group: Group) => (
                <Combobox.Group key={group.value} items={group.items} className="flex flex-col pb-1">
                  <Combobox.GroupLabel className="sticky top-0 z-10 bg-popover px-2.5 pt-2 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                    {group.value}
                  </Combobox.GroupLabel>
                  <Combobox.Collection>
                    {(i: SkuLinkItem) => (
                      <Combobox.Item
                        key={i.itemCode}
                        value={i}
                        className="grid cursor-default grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-x-2.5 rounded-lg px-2.5 py-2 text-sm outline-none select-none data-[highlighted]:bg-muted"
                      >
                        <Combobox.ItemIndicator className="col-start-1 text-primary">
                          <Check className="size-3.5" />
                        </Combobox.ItemIndicator>
                        <span className="col-start-2 flex min-w-0 flex-col">
                          <span className="truncate">{i.variant?.trim() || text(i)}</span>
                          <span className="truncate text-xs text-muted-foreground">
                            <span className="font-mono">{i.itemCode}</span>
                            {i.formSpot ? ` · form page ${i.formSpot.page}` : ''}
                          </span>
                        </span>
                        <span className={cn('col-start-3 flex flex-col items-end text-right text-sm tabular-nums', priceClose(i, watsonsPrice) ? 'text-[var(--status-good)]' : 'text-muted-foreground')}>
                          {i.price != null ? `₱${Math.round(i.price).toLocaleString('en-US')}` : '—'}
                          {priceClose(i, watsonsPrice) && <span className="text-[10.5px]">near Watsons</span>}
                        </span>
                      </Combobox.Item>
                    )}
                  </Combobox.Collection>
                </Combobox.Group>
              )}
            </Combobox.List>
            {watsonsPrice != null && (
              <p className="border-t px-4 py-2 text-xs text-muted-foreground">
                Watsons sells this at about ₱{Math.round(watsonsPrice).toLocaleString('en-US')}. Prices within 15% are marked.
              </p>
            )}
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  );
}
