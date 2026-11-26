'use client';

import {useMemo, useRef, useState} from 'react';
import {Combobox} from '@base-ui/react/combobox';
import {Popover} from '@base-ui/react/popover';
import {CalendarDays, Check, ChevronDown, Search, Store} from 'lucide-react';
import {cn} from '@/lib/utils';
import {titleName} from '@/src/goldline-ui';
import {ALL_STORES} from '@/src/goldline-audit';
import type {AuditMonth} from '@/src/goldline-audit-data';
import {monthLabel} from '@/components/analyst/audit-shared';

// The Reconcile pickers (Nov 25), in place of two native selects. Hick's law: fewer, clearer
// choices first.
// - Store: All stores is pinned on top (the default), then the stores with a form this month
//   (the ones that can be fully checked). Stores with sales only wait behind "Show more"
//   until you search, which looks across all of them.
// - Month: a year at a glance, one dot per month for what it has (sales, forms or both),
//   instead of a long list of "(no forms)". Months with nothing are shown but not pickable.

const TRIGGER =
  'group flex h-10 items-center gap-2.5 rounded-xl border border-border bg-card pr-3 pl-3 text-left text-sm outline-none transition-[border-color,box-shadow,transform] duration-150 ease-out select-none [@media(hover:hover)]:hover:border-foreground/25 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40 active:scale-[0.99] data-[popup-open]:border-foreground/30';

const POPUP =
  'origin-[var(--transform-origin)] overflow-hidden rounded-2xl border bg-popover text-popover-foreground shadow-xl outline-none transition-[opacity,transform] duration-150 ease-out data-[ending-style]:scale-[0.98] data-[ending-style]:opacity-0 data-[starting-style]:scale-[0.98] data-[starting-style]:opacity-0';

// ── Store ──────────────────────────────────────────────────────────────────────────────

type StoreOption = {code: string; name: string | null; counted: boolean};
type StoreGroup = {value: 'all' | 'counted' | 'sales'; items: StoreOption[]};

const GROUP_LABEL: Record<StoreGroup['value'], string> = {all: '', counted: 'With a form this month', sales: 'Sales only'};
const storeText = (s: StoreOption) => (s.code === ALL_STORES ? 'All stores' : s.name ? `${s.code} · ${titleName(s.name)}` : s.code);
const storeHay = (s: StoreOption) => `${s.code} ${s.name ?? ''} ${s.code === ALL_STORES ? 'all stores every' : ''}`.toLowerCase();

export function StorePicker({stores, value, onChange}: {stores: StoreOption[]; value: string; onChange: (code: string) => void}) {
  const [query, setQuery] = useState('');
  const [more, setMore] = useState(false);
  const all: StoreOption = useMemo(() => ({code: ALL_STORES, name: null, counted: false}), []);
  const counted = useMemo(() => stores.filter((s) => s.counted), [stores]);
  const salesOnly = useMemo(() => stores.filter((s) => !s.counted), [stores]);
  const selected = value === ALL_STORES ? all : (stores.find((s) => s.code === value) ?? all);
  // The picked store is always reachable, even when it sits in the folded group.
  const open = more || Boolean(query.trim()) || salesOnly.length <= 6 || (!selected.counted && selected.code !== ALL_STORES);
  const groups = useMemo<StoreGroup[]>(
    () =>
      [
        {value: 'all' as const, items: [all]},
        {value: 'counted' as const, items: counted},
        {value: 'sales' as const, items: open ? salesOnly : []},
      ].filter((g) => g.items.length),
    [all, counted, salesOnly, open],
  );

  return (
    <Combobox.Root<StoreOption>
      items={groups}
      value={selected}
      onValueChange={(v) => v && v.code !== value && onChange(v.code)}
      inputValue={query}
      onInputValueChange={setQuery}
      onOpenChange={(o) => {
        if (!o) setQuery('');
      }}
      itemToStringLabel={storeText}
      isItemEqualToValue={(a, b) => a.code === b.code}
      filter={(s, q) => {
        const h = storeHay(s);
        return q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => h.includes(w));
      }}
      autoHighlight
    >
      <Combobox.Trigger aria-label="Store" className={cn(TRIGGER, 'w-[min(17rem,calc(100vw-2rem))]')}>
        <Store aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-medium">{storeText(selected)}</span>
        {selected.code === ALL_STORES && <span className="rounded-md bg-muted px-1.5 py-0.5 text-xs text-muted-foreground tabular-nums">{stores.length}</span>}
        <ChevronDown aria-hidden className="size-4 shrink-0 text-muted-foreground transition-transform duration-200 ease-out group-data-[popup-open]:rotate-180" />
      </Combobox.Trigger>
      <Combobox.Portal>
        <Combobox.Positioner sideOffset={8} align="start" className="z-50 outline-none">
          <Combobox.Popup aria-label="Pick a store" className={cn(POPUP, 'flex max-h-[min(26rem,var(--available-height))] w-[max(var(--anchor-width),20rem)] max-w-[calc(100vw-2rem)] flex-col')}>
            <div className="relative border-b">
              <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <Combobox.Input placeholder={`Search ${stores.length} stores by name or code`} className="h-11 w-full bg-transparent pr-3 pl-10 text-sm outline-none placeholder:text-muted-foreground any-pointer-coarse:text-base" />
            </div>
            <Combobox.Empty className="px-4 py-8 text-center text-sm text-muted-foreground empty:hidden">No store matches. Try the store code.</Combobox.Empty>
            <Combobox.List className="flex flex-col overflow-y-auto overscroll-contain p-1.5 outline-none scroll-py-1.5 data-[empty]:p-0">
              {(group: StoreGroup) => (
                <Combobox.Group key={group.value} items={group.items} className="flex flex-col">
                  {GROUP_LABEL[group.value] && (
                    <Combobox.GroupLabel className="sticky top-0 z-10 flex items-baseline justify-between bg-popover px-2.5 pt-3 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                      {GROUP_LABEL[group.value]}
                      {!query.trim() && <span className="tabular-nums normal-case">{(group.value === 'counted' ? counted : salesOnly).length}</span>}
                    </Combobox.GroupLabel>
                  )}
                  <Combobox.Collection>
                    {(s: StoreOption) => (
                      <Combobox.Item
                        key={s.code}
                        value={s}
                        className="grid cursor-default grid-cols-[2.75rem_minmax(0,1fr)_1rem] items-center gap-x-2 rounded-lg px-2 py-2 text-sm outline-none select-none data-[highlighted]:bg-muted"
                      >
                        {s.code === ALL_STORES ? (
                          <>
                            <span className="grid size-7 place-items-center rounded-md bg-muted text-muted-foreground">
                              <Store className="size-3.5" />
                            </span>
                            <span className="flex min-w-0 flex-col">
                              <span className="font-medium">All stores</span>
                              <span className="text-xs text-muted-foreground">
                                {stores.length} stores · {counted.length} with a form
                              </span>
                            </span>
                          </>
                        ) : (
                          <>
                            <span className="truncate font-mono text-xs text-muted-foreground tabular-nums">{s.code}</span>
                            <span className="truncate">{s.name ? titleName(s.name) : `Store ${s.code}`}</span>
                          </>
                        )}
                        <Combobox.ItemIndicator className="text-primary">
                          <Check className="size-3.5" />
                        </Combobox.ItemIndicator>
                      </Combobox.Item>
                    )}
                  </Combobox.Collection>
                </Combobox.Group>
              )}
            </Combobox.List>
            {!open && (
              <button
                type="button"
                onClick={() => setMore(true)}
                className="border-t px-4 py-2.5 text-left text-sm text-muted-foreground outline-none transition-colors duration-150 [@media(hover:hover)]:hover:bg-muted [@media(hover:hover)]:hover:text-foreground focus-visible:bg-muted focus-visible:text-foreground"
              >
                Show {salesOnly.length} stores with sales only
              </button>
            )}
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  );
}

// ── Month ──────────────────────────────────────────────────────────────────────────────

type Has = 'both' | 'forms' | 'sales';
const hasOf = (m: AuditMonth): Has => (m.loaded && m.counted ? 'both' : m.counted ? 'forms' : 'sales');
const HAS: Record<Has, {label: string; dot: string}> = {
  both: {label: 'Sales and forms', dot: 'bg-[var(--status-good)]'},
  forms: {label: 'Forms, no sales yet', dot: 'bg-[var(--status-warn)]'},
  sales: {label: 'Sales, no forms', dot: 'bg-muted-foreground/45'},
};
const SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function Dot({has}: {has: Has}) {
  return <span aria-hidden className={cn('size-1.5 shrink-0 rounded-full', HAS[has].dot)} />;
}

export function MonthPicker({months, value, onChange}: {months: AuditMonth[]; value: string; onChange: (month: string) => void}) {
  const [isOpen, setOpen] = useState(false);
  const byKey = useMemo(() => new Map(months.map((m) => [m.month, m])), [months]);
  const years = useMemo(() => [...new Set(months.map((m) => m.month.slice(0, 4)))].sort().reverse(), [months]);
  const current = byKey.get(value);
  const ready = months.filter((m) => hasOf(m) === 'both');
  const selectedRef = useRef<HTMLButtonElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  const pick = (m: string) => {
    setOpen(false);
    if (m !== value) onChange(m);
  };
  // Arrow keys move across the enabled months (four to a row), like a date picker.
  const onKeyDown = (e: React.KeyboardEvent) => {
    const step = {ArrowRight: 1, ArrowLeft: -1, ArrowDown: 4, ArrowUp: -4}[e.key];
    if (!step || !gridRef.current) return;
    const cells = [...gridRef.current.querySelectorAll<HTMLButtonElement>('button[data-month]')];
    const at = cells.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    e.preventDefault();
    for (let i = at + step; i >= 0 && i < cells.length; i += step) {
      if (!cells[i].disabled) return cells[i].focus();
    }
  };

  return (
    <Popover.Root open={isOpen} onOpenChange={setOpen}>
      <Popover.Trigger aria-label="Month" className={cn(TRIGGER, 'w-52')}>
        <CalendarDays aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <span className="flex-1 font-medium tabular-nums">{monthLabel(value)}</span>
        {current && <Dot has={hasOf(current)} />}
        <ChevronDown aria-hidden className="size-4 shrink-0 text-muted-foreground transition-transform duration-200 ease-out group-data-[popup-open]:rotate-180" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner sideOffset={8} align="start" className="z-50 outline-none">
          <Popover.Popup initialFocus={selectedRef} aria-label="Pick a month" className={cn(POPUP, 'w-[min(20rem,calc(100vw-2rem))]')}>
            <div ref={gridRef} onKeyDown={onKeyDown} className="flex max-h-[min(24rem,calc(var(--available-height)-6rem))] flex-col gap-4 overflow-y-auto overscroll-contain p-4">
              {years.map((y) => (
                <section key={y} className="flex flex-col gap-2">
                  <h3 className="px-1 font-mono text-[11px] tracking-[0.14em] text-muted-foreground">{y}</h3>
                  <div className="grid grid-cols-4 gap-1.5">
                    {SHORT.map((label, i) => {
                      const key = `${y}-${String(i + 1).padStart(2, '0')}`;
                      const m = byKey.get(key);
                      const on = key === value;
                      return (
                        <button
                          key={key}
                          ref={on ? selectedRef : undefined}
                          type="button"
                          data-month={key}
                          disabled={!m}
                          aria-pressed={on}
                          aria-label={m ? `${monthLabel(key)}: ${HAS[hasOf(m)].label}` : `${monthLabel(key)}: no data`}
                          onClick={() => m && pick(key)}
                          className={cn(
                            'flex h-11 flex-col items-center justify-center gap-1 rounded-lg text-sm outline-none transition-[background-color,color,transform] duration-150 ease-out',
                            'focus-visible:ring-3 focus-visible:ring-ring/40 enabled:active:scale-[0.96]',
                            'disabled:text-muted-foreground/35',
                            on ? 'bg-foreground font-medium text-background' : 'enabled:[@media(hover:hover)]:hover:bg-muted',
                          )}
                        >
                          {label}
                          {m ? <Dot has={hasOf(m)} /> : <span aria-hidden className="size-1.5" />}
                        </button>
                      );
                    })}
                  </div>
                </section>
              ))}
            </div>
            <div className="flex flex-col gap-2 border-t px-4 py-3 text-xs text-muted-foreground">
              <div className="flex flex-wrap gap-x-3.5 gap-y-1">
                {(Object.keys(HAS) as Has[]).map((h) => (
                  <span key={h} className="inline-flex items-center gap-1.5">
                    <Dot has={h} />
                    {HAS[h].label}
                  </span>
                ))}
              </div>
              {ready.length === 0 && <p>No month has both yet. A month is checked fully once its Watsons sales and its forms are both in.</p>}
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
