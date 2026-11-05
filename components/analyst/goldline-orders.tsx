'use client';

// Goldline · Orders (F12), two pages. /stock/orders lists the days POs were made, a month
// at a time (?month=YYYY-MM, picker and older / newer), one row per date with its stores,
// approved total and how much has arrived (added up in the database, po_dates). A row opens
// /stock/orders/date/YYYY-MM-DD: that day's POs, one per store, filtered by status and a
// store search. Only the opened day's POs are loaded. Rows there open the PO.

import {useMemo, useState} from 'react';
import Link from 'next/link';
import {usePathname, useRouter} from 'next/navigation';
import {ChevronLeft, ChevronRight, ClipboardList, Info, Search} from 'lucide-react';
import type {PoDate, PoListRow} from '@/src/goldline-po-data';
import type {PoStatus} from '@/src/goldline-po';
import {Card, CardContent} from '@/components/ui/card';
import {SegmentedControl} from '@/components/analyst/segmented-control';
import {NativeSelect} from '@/components/ui/native-select';
import {peso} from '@/components/analyst/goldline-ops-shared';
import {PoStatusChip} from '@/components/analyst/goldline-po-shared';
import {cn} from '@/lib/utils';

export type OrderDatesViewData = {configured: boolean; dates: PoDate[]; month: string | null};
export type OrdersOfDayViewData = {date: string; rows: PoListRow[]};

type StatusFilter = 'all' | Exclude<PoStatus, 'empty'>;

const rowDay = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', {weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC'});
const longDay = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', {weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC'});
const monthLabel = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-US', {month: 'long', year: 'numeric', timeZone: 'UTC'});
const cycleLabel = (c: string) => `${c.endsWith('a') ? '1st' : '2nd'} half of ${new Date(`${c.slice(0, 7)}-01T00:00:00Z`).toLocaleDateString('en-US', {month: 'short', timeZone: 'UTC'})} run`;
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

const TH = 'border-y border-border bg-muted/40 text-left text-[11px] tracking-wide whitespace-nowrap text-muted-foreground uppercase';
const ROW = 'relative border-b border-border/60 transition-colors duration-150 last:border-0 hover:bg-muted/40';
// The whole row opens the link; it stretches over the row.
const ROW_LINK = 'font-medium after:absolute after:inset-0 focus-visible:underline focus-visible:outline-none';
const ARROW =
  'rounded-md p-1.5 text-muted-foreground transition-[color,transform] duration-150 ease-out hover:text-foreground active:scale-[0.97] disabled:pointer-events-none disabled:opacity-35';

export function GoldlineOrderDates({data}: {data: OrderDatesViewData}) {
  const router = useRouter();
  const pathname = usePathname();

  // Months with POs, newest first, and how many order dates each has.
  const months = useMemo(() => {
    const by = new Map<string, number>();
    for (const d of data.dates) by.set(d.date.slice(0, 7), (by.get(d.date.slice(0, 7)) ?? 0) + 1);
    return [...by.entries()].sort(([a], [b]) => b.localeCompare(a));
  }, [data.dates]);
  const month = data.month && months.some(([m]) => m === data.month) ? data.month : (months[0]?.[0] ?? null);
  const days = data.dates.filter((d) => month && d.date.startsWith(month));
  const at = months.findIndex(([m]) => m === month);
  const older = at >= 0 ? months[at + 1]?.[0] : undefined;
  const newer = at > 0 ? months[at - 1]?.[0] : undefined;
  const goMonth = (m: string) => router.push(`${pathname}?month=${m}`, {scroll: false});

  return (
    <div className="mx-auto flex max-w-7xl min-w-0 flex-col gap-6 px-4 py-6 *:min-w-0">
      <header className="flex flex-col gap-3">
        <div className="flex items-baseline gap-3">
          <h1 className="font-heading text-2xl font-semibold tracking-tight">Orders</h1>
          <Link href="/stock/restock" className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
            Restock
          </Link>
        </div>
        <p className="max-w-[70ch] text-sm text-muted-foreground text-pretty">
          Purchase orders by the day they were made, one per store, laid out like Nichido&apos;s paper form. The lines approved on the Restock run ship from the warehouse when the PO is
          made. When stock arrives, fill in the received section; what was received counts as delivered in the next form vs. sales check.
        </p>
      </header>

      {!data.configured ? (
        <Empty icon={<Info className="size-6 text-muted-foreground" aria-hidden />} title="Orders aren't connected">
          Purchase orders live in the Nichido database, which isn&apos;t set up in this environment.
        </Empty>
      ) : data.dates.length === 0 ? (
        <Empty icon={<ClipboardList className="size-6 text-muted-foreground" aria-hidden />} title="No purchase orders yet">
          Approve lines on the{' '}
          <Link href="/stock/restock" className="underline underline-offset-4">
            Restock
          </Link>{' '}
          run, then choose Make purchase orders. Each store with approved lines gets one, and its lines ship.
        </Empty>
      ) : (
        <Card className="py-0">
          <CardContent className="flex flex-col gap-3 px-0 pt-4 pb-0">
            <div className="flex flex-wrap items-center justify-between gap-3 px-4">
              <h2 className="font-heading text-base font-semibold">Order dates</h2>
              <div className="flex items-center gap-1">
                <button type="button" aria-label={older ? `Older: ${monthLabel(older)}` : 'No older months'} disabled={!older} onClick={() => older && goMonth(older)} className={ARROW}>
                  <ChevronLeft className="size-4" aria-hidden />
                </button>
                <NativeSelect aria-label="Month" value={month ?? ''} onChange={(e) => goMonth(e.target.value)}>
                  {months.map(([m, n]) => (
                    <option key={m} value={m}>
                      {monthLabel(m)} ({plural(n, 'date')})
                    </option>
                  ))}
                </NativeSelect>
                <button type="button" aria-label={newer ? `Newer: ${monthLabel(newer)}` : 'No newer months'} disabled={!newer} onClick={() => newer && goMonth(newer)} className={ARROW}>
                  <ChevronRight className="size-4" aria-hidden />
                </button>
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className={TH}>
                    <th className="py-2 pr-3 pl-4 font-medium">Date</th>
                    <th className="py-2 pr-3 text-right font-medium">Stores</th>
                    <th className="py-2 pr-3 text-right font-medium">Approved total</th>
                    <th className="py-2 pr-3 text-right font-medium">Received</th>
                    <th className="py-2 pr-4 font-medium">Restock run</th>
                  </tr>
                </thead>
                <tbody>
                  {days.map((d) => {
                    const done = d.lines > 0 && d.received === d.lines;
                    return (
                      <tr key={d.date} className={ROW}>
                        <td className="py-2.5 pr-3 pl-4 whitespace-nowrap">
                          <Link href={`/stock/orders/date/${d.date}`} className={ROW_LINK}>
                            {rowDay(d.date)}
                          </Link>{' '}
                          <span className="text-xs text-muted-foreground tabular-nums">{d.date.slice(0, 4)}</span>
                        </td>
                        <td className="py-2.5 pr-3 text-right tabular-nums">{d.pos}</td>
                        <td className="py-2.5 pr-3 text-right tabular-nums">{peso(d.total)}</td>
                        <td className={cn('py-2.5 pr-3 text-right whitespace-nowrap tabular-nums', done ? 'text-[var(--status-good)]' : 'text-muted-foreground')}>
                          {done ? 'All received' : `${d.received} of ${plural(d.lines, 'line')}`}
                        </td>
                        <td className="py-2.5 pr-4 whitespace-nowrap text-muted-foreground">{d.cycles.map(cycleLabel).join(', ')}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

export function GoldlineOrdersOfDay({data}: {data: OrdersOfDayViewData}) {
  const [status, setStatus] = useState<StatusFilter>('all');
  const [query, setQuery] = useState('');
  const ofDay = data.rows;
  const statusCount = (s: StatusFilter) => (s === 'all' ? ofDay.length : ofDay.filter((r) => r.status === s).length);
  const q = query.trim().toLowerCase();
  const shown = ofDay
    .filter((r) => status === 'all' || r.status === status)
    .filter((r) => !q || r.storeCode.toLowerCase().includes(q) || (r.storeName ?? '').toLowerCase().includes(q) || r.number.toLowerCase().includes(q))
    .sort((a, b) => (a.storeName ?? a.storeCode).localeCompare(b.storeName ?? b.storeCode, undefined, {numeric: true}));

  return (
    <div className="mx-auto flex max-w-7xl min-w-0 flex-col gap-6 px-4 py-6 *:min-w-0">
      <header className="flex flex-col gap-2">
        <nav aria-label="Breadcrumb" className="flex items-baseline gap-2 text-sm text-muted-foreground">
          <Link href={`/stock/orders?month=${data.date.slice(0, 7)}`} className="underline-offset-4 hover:text-foreground hover:underline">
            Orders
          </Link>
          <span aria-hidden>/</span>
          <span className="text-foreground">{rowDay(data.date)}</span>
        </nav>
        <h1 className="font-heading text-2xl font-semibold tracking-tight">{longDay(data.date)}</h1>
        <p className="text-sm text-muted-foreground">Purchase orders made this day, one per store. Open one to see its lines or fill in what arrived.</p>
      </header>

      <Card className="py-0">
        <CardContent className="flex flex-col gap-3 px-0 pt-4 pb-0">
          <div className="flex flex-wrap items-center justify-between gap-3 px-4">
            <h2 className="font-heading text-base font-semibold">{plural(ofDay.length, 'store')}</h2>
            <div className="flex flex-wrap items-center gap-2">
              <SegmentedControl<StatusFilter>
                ariaLabel="Filter by status"
                value={status}
                onChange={setStatus}
                options={[
                  {value: 'all', label: `All ${statusCount('all')}`},
                  {value: 'shipped', label: `Shipped ${statusCount('shipped')}`},
                  {value: 'partly_received', label: `Partly received ${statusCount('partly_received')}`},
                  {value: 'received', label: `Received ${statusCount('received')}`},
                ]}
              />
              <label className="relative inline-flex items-center">
                <Search className="pointer-events-none absolute left-2 size-3.5 text-muted-foreground" aria-hidden />
                <input
                  id="orders-store-search"
                  type="search"
                  aria-label="Find a store"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Store or PO no."
                  className="h-8 w-44 rounded-md border border-border bg-background pr-2 pl-7 text-sm outline-none transition-colors hover:border-foreground/25 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40"
                />
              </label>
            </div>
          </div>
          {shown.length === 0 ? (
            <p className="px-4 pt-6 pb-10 text-center text-sm text-muted-foreground">No purchase orders on this date match the filter.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className={TH}>
                    <th className="py-2 pr-3 pl-4 font-medium">Store</th>
                    <th className="py-2 pr-3 font-medium">PO</th>
                    <th className="py-2 pr-3 font-medium">Status</th>
                    <th className="py-2 pr-3 text-right font-medium">Lines</th>
                    <th className="py-2 pr-3 text-right font-medium">Approved total</th>
                    <th className="py-2 pr-4 text-right font-medium">Received</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((r) => (
                    <tr key={r.id} className={ROW}>
                      <td className="py-2.5 pr-3 pl-4">
                        <Link href={`/stock/orders/${r.id}`} className={ROW_LINK}>
                          {r.storeName ?? `Store ${r.storeCode}`}
                        </Link>{' '}
                        <span className="font-mono text-xs text-muted-foreground">{r.storeCode}</span>
                      </td>
                      <td className="py-2.5 pr-3 font-mono text-[13px] whitespace-nowrap">{r.number}</td>
                      <td className="py-2.5 pr-3">
                        <PoStatusChip status={r.status} />
                      </td>
                      <td className="py-2.5 pr-3 text-right tabular-nums">{r.lines}</td>
                      <td className="py-2.5 pr-3 text-right tabular-nums">{peso(r.approvedTotal)}</td>
                      <td className="py-2.5 pr-4 text-right whitespace-nowrap tabular-nums text-muted-foreground">
                        {r.receivedLines} of {r.lines}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Empty({icon, title, children}: {icon: React.ReactNode; title: string; children: React.ReactNode}) {
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-2 px-6 py-12 text-center">
        {icon}
        <h2 className="font-heading text-base font-semibold">{title}</h2>
        <p className="max-w-md text-sm text-muted-foreground text-pretty">{children}</p>
      </CardContent>
    </Card>
  );
}
