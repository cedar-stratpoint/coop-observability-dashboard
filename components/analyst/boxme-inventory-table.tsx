'use client';

// The BoxMe (Online) products table: status chips that double as a filter, Line
// pills and search (same primitives as the Stratpoint table), sortable columns,
// 12-row pages, and a card list below md. Read-only: BoxMe owns these numbers,
// so there are no edit menus here. Rows open /inventory/[sku] when the SKU is
// also a POS product.

import {useMemo, useState, useEffect} from 'react';
import Link from 'next/link';
import {useRouter} from 'next/navigation';
import {Search, X} from 'lucide-react';
import {cn} from '@/lib/utils';
import {Card, CardContent} from '@/components/ui/card';
import {POS_CATEGORIES} from '@/src/pos-format';
import {filterBoxmeRows, MIN_HISTORY_DAYS, type BoxmeInventoryRow, type BoxmeStatus} from '@/src/boxme-inventory-compute';
import {fmtDate, fmtLasts} from '@/src/boxme-format';
import {STATUS} from '@/src/inventory-status';
import {PillRow, Sc, Th} from './inventory-table';
import {Pagination} from './pagination';

type SortKey = 'name' | 'status' | 'available' | 'awaiting' | 'reserved' | 'incoming' | 'damaged' | 'expiry' | 'offline' | 'lasts';
type StatusFilter = '' | BoxmeStatus | 'expiring';

const PAGE_SIZE = 12;
const STATUS_RANK: Record<BoxmeStatus, number> = {out: 0, low: 1, healthy: 2};
const n = (v: number) => v.toLocaleString('en-US');

export function BoxmeInventoryTable({rows, summary}: {
  rows: BoxmeInventoryRow[];
  summary: {healthy: number; low: number; out: number; expiring: number; total: number};
}) {
  const [line, setLine] = useState('');
  const [status, setStatus] = useState<StatusFilter>('');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<{key: SortKey; dir: 1 | -1}>({key: 'status', dir: 1});
  const [page, setPage] = useState(1);

  const filtered = useMemo(() => filterBoxmeRows(rows, {line, status, search}), [rows, line, status, search]);
  const sorted = useMemo(() => {
    const val = (r: BoxmeInventoryRow): number | string => {
      switch (sort.key) {
        case 'name': return r.name.toLowerCase();
        case 'status': return STATUS_RANK[r.status];
        case 'available': return r.available;
        case 'awaiting': return r.awaiting;
        case 'reserved': return r.reserved;
        case 'incoming': return r.incoming;
        case 'damaged': return r.damaged;
        case 'expiry': return r.nextExpiry?.date ?? '9999-12-31';
        case 'offline': return r.offline ?? -1;
        case 'lasts': return r.lastsDays ?? Number.POSITIVE_INFINITY;
      }
    };
    return [...filtered].sort((a, b) => {
      const av = val(a), bv = val(b);
      if (av < bv) return -1 * sort.dir;
      if (av > bv) return 1 * sort.dir;
      return a.available - b.available || a.name.localeCompare(b.name);
    });
  }, [filtered, sort]);

  useEffect(() => setPage(1), [line, status, search, sort]);
  const pageCount = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const from = (safePage - 1) * PAGE_SIZE;
  const paged = sorted.slice(from, from + PAGE_SIZE);

  // Name, status and expiry read naturally low-to-high; quantities high-to-low.
  function toggleSort(key: SortKey) {
    setSort((s) => (s.key !== key ? {key, dir: key === 'name' || key === 'status' || key === 'expiry' || key === 'lasts' ? 1 : -1} : {key, dir: (s.dir * -1) as 1 | -1}));
  }
  const caret = (key: SortKey) => (sort.key !== key ? '↕' : sort.dir === 1 ? '↑' : '↓');

  const chips: {v: StatusFilter; label: string; count: number; dot: string}[] = [
    {v: 'healthy', label: 'Healthy', count: summary.healthy, dot: 'bg-emerald-500'},
    {v: 'low', label: 'Low', count: summary.low, dot: 'bg-amber-500'},
    {v: 'out', label: 'Out', count: summary.out, dot: 'bg-red-500'},
    {v: 'expiring', label: 'Expiring soon', count: summary.expiring, dot: 'bg-amber-700 dark:bg-amber-300'},
  ];

  return (
    <div>
      <div className="mb-4 flex flex-col gap-2.5">
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filter by status">
          {chips.map((c) => {
            const on = status === c.v;
            return (
              <button key={c.v} type="button" aria-pressed={on} onClick={() => setStatus(on ? '' : c.v)}
                className={cn('inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium transition-[color,background-color,border-color,transform] duration-150 active:scale-[0.97] motion-reduce:transition-none',
                  on ? 'border-foreground bg-foreground text-background' : 'bg-card text-foreground hover:bg-muted')}>
                <span aria-hidden className={cn('size-1.5 rounded-full', c.dot)} />
                {c.label}
                <span className="font-heading text-[15px] leading-none tabular-nums">{c.count}</span>
              </button>
            );
          })}
        </div>
        <PillRow label="Line" items={[{v: '', l: 'All'}, ...POS_CATEGORIES.map((c) => ({v: c as string, l: c}))]} active={line} onSelect={setLine} />
        <div className="relative min-w-[200px] max-w-md">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name or SKU…" aria-label="Search BoxMe products"
            className="w-full rounded-md border bg-background py-2 pl-9 pr-8 text-sm outline-none transition-colors focus-visible:border-ring" />
          {search && (
            <button type="button" onClick={() => setSearch('')} aria-label="Clear search"
              className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground transition-colors hover:text-foreground">
              <X className="size-3.5" />
            </button>
          )}
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          {sorted.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">No BoxMe products match this filter.</p>
          ) : (
            <>
              <div className="overflow-x-auto max-md:hidden">
                <table className="w-full min-w-[920px] text-sm">
                  <thead>
                    <tr className="border-b text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">
                      <Th onClick={() => toggleSort('name')} active={sort.key === 'name'}>Product <Sc>{caret('name')}</Sc></Th>
                      <Th onClick={() => toggleSort('status')} active={sort.key === 'status'}>Status <Sc>{caret('status')}</Sc></Th>
                      <Th className="text-right" onClick={() => toggleSort('available')} active={sort.key === 'available'}>Available <Sc>{caret('available')}</Sc></Th>
                      <Th className="text-right" onClick={() => toggleSort('awaiting')} active={sort.key === 'awaiting'}>Awaiting <Sc>{caret('awaiting')}</Sc></Th>
                      <Th className="text-right" onClick={() => toggleSort('reserved')} active={sort.key === 'reserved'}>Reserved <Sc>{caret('reserved')}</Sc></Th>
                      <Th className="text-right" onClick={() => toggleSort('incoming')} active={sort.key === 'incoming'}>Incoming <Sc>{caret('incoming')}</Sc></Th>
                      <Th className="text-right" onClick={() => toggleSort('damaged')} active={sort.key === 'damaged'}>Damaged <Sc>{caret('damaged')}</Sc></Th>
                      <Th onClick={() => toggleSort('expiry')} active={sort.key === 'expiry'}>Next expiry <Sc>{caret('expiry')}</Sc></Th>
                      <Th className="text-right" onClick={() => toggleSort('offline')} active={sort.key === 'offline'}>Offline <Sc>{caret('offline')}</Sc></Th>
                      <Th onClick={() => toggleSort('lasts')} active={sort.key === 'lasts'}>Lasts <Sc>{caret('lasts')}</Sc></Th>
                    </tr>
                  </thead>
                  <tbody>
                    {paged.map((r) => <Row key={r.sku} r={r} />)}
                  </tbody>
                </table>
              </div>
              <ul className="divide-y divide-border md:hidden">
                {paged.map((r) => <RowCard key={r.sku} r={r} />)}
              </ul>
            </>
          )}
        </CardContent>
      </Card>

      {sorted.length > 0 && (
        <div className="mt-4 flex flex-col-reverse items-center justify-between gap-3 sm:flex-row">
          <p className="text-xs tabular-nums text-muted-foreground">
            Showing {from + 1}–{Math.min(from + PAGE_SIZE, sorted.length)} of {sorted.length} · Offline is Stratpoint Office + Event
          </p>
          <Pagination page={safePage} pageCount={pageCount} onPage={setPage} label="BoxMe products pagination" />
        </div>
      )}
    </div>
  );
}

function StatusBadge({status}: {status: BoxmeStatus}) {
  const s = STATUS[status];
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold', s.bg, s.text)}>
      <span className={cn('size-1.5 rounded-full', s.dot)} />{s.label}
    </span>
  );
}

function Expiry({r}: {r: BoxmeInventoryRow}) {
  if (!r.nextExpiry) return <span className="text-muted-foreground">{r.available > 0 ? 'No date' : 'None in stock'}</span>;
  const e = r.nextExpiry;
  return (
    <span className={cn('whitespace-nowrap', e.soon && 'font-medium text-amber-700 dark:text-amber-300')} title={`${n(e.quantity)} units expire ${fmtDate(e.date)}`}>
      {fmtDate(e.date)}{e.soon && <span className="ml-1 text-[11px]">· {e.daysLeft < 0 ? 'expired' : `${e.daysLeft} d`}</span>}
    </span>
  );
}

function Lasts({r}: {r: BoxmeInventoryRow}) {
  if (r.available <= 0) return <span className="font-medium text-red-600 dark:text-red-400">Out</span>;
  if (r.soldPerDay == null) {
    return <span className="text-muted-foreground" title={`Needs ${MIN_HISTORY_DAYS} days of daily snapshots; ${r.historyDays} so far.`}>Building history</span>;
  }
  if (r.soldPerDay === 0) return <span className="text-muted-foreground">No recent sales</span>;
  return <span className="tabular-nums">{fmtLasts(r.lastsDays)}</span>;
}

function Offline({r}: {r: BoxmeInventoryRow}) {
  if (r.offline == null) return <span className="text-[11px] text-muted-foreground">Not in POS</span>;
  return <span className="tabular-nums text-muted-foreground">{n(r.offline)}</span>;
}

function Row({r}: {r: BoxmeInventoryRow}) {
  const router = useRouter();
  const href = r.inPos ? `/inventory/${r.sku}?channel=online` : null;
  const qty = (v: number, strong = false) => (
    <td className={cn('px-3 py-3 text-right tabular-nums', v === 0 ? 'text-muted-foreground/60' : strong ? 'font-heading text-[17px] leading-none' : '')}>{n(v)}</td>
  );
  return (
    <tr onClick={href ? () => router.push(href) : undefined}
      className={cn('border-b transition-colors last:border-0', href && 'cursor-pointer hover:bg-muted/50')}>
      <td className="px-3 py-3">
        {href ? (
          <Link href={href} onClick={(e) => e.stopPropagation()} className="font-medium transition-colors hover:text-primary">{r.name}</Link>
        ) : (
          <span className="font-medium">{r.name}</span>
        )}
        <div className="font-mono text-[10px] text-muted-foreground">{r.sku}</div>
      </td>
      <td className="px-3 py-3"><StatusBadge status={r.status} /></td>
      {qty(r.available, true)}
      {qty(r.awaiting)}
      {qty(r.reserved)}
      {qty(r.incoming)}
      {qty(r.damaged)}
      <td className="px-3 py-3"><Expiry r={r} /></td>
      <td className="px-3 py-3 text-right"><Offline r={r} /></td>
      <td className="whitespace-nowrap px-3 py-3"><Lasts r={r} /></td>
    </tr>
  );
}

function RowCard({r}: {r: BoxmeInventoryRow}) {
  const href = r.inPos ? `/inventory/${r.sku}?channel=online` : null;
  const cells: {label: string; node: React.ReactNode}[] = [
    {label: 'Available', node: <span className="font-heading text-lg leading-none tabular-nums">{n(r.available)}</span>},
    {label: r.incoming > 0 ? 'Incoming' : 'Awaiting', node: <span className="tabular-nums">{n(r.incoming > 0 ? r.incoming : r.awaiting)}</span>},
    {label: 'Lasts', node: <Lasts r={r} />},
  ];
  return (
    <li className="flex flex-col gap-2.5 px-4 py-3.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          {href ? <Link href={href} className="font-medium transition-colors hover:text-primary">{r.name}</Link> : <span className="font-medium">{r.name}</span>}
          <div className="font-mono text-[10px] text-muted-foreground">{r.sku}</div>
        </div>
        <StatusBadge status={r.status} />
      </div>
      <div className="grid grid-cols-3 gap-2">
        {cells.map((c) => (
          <div key={c.label} className="rounded-md bg-muted/50 px-2.5 py-2">
            <div className="text-[10px] font-semibold uppercase tracking-[0.09em] text-muted-foreground">{c.label}</div>
            <div className="mt-1 text-sm">{c.node}</div>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap justify-between gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span>{r.nextExpiry ? <>Expires <Expiry r={r} /></> : <Expiry r={r} />}</span>
        <span>Offline <Offline r={r} /></span>
      </div>
    </li>
  );
}
