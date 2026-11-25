'use client';

// Goldline · Orders (F12), two pages. /stock/orders lists the days POs were made, a month
// at a time (?month=YYYY-MM, picker and older / newer), one row per date with its stores,
// approved total and how much has arrived (added up in the database, po_dates). A row opens
// /stock/orders/date/YYYY-MM-DD: that day's POs, one per store, filtered by status and a
// store search. Only the opened day's POs are loaded. Rows there open the PO.

import {useMemo} from 'react';
import {ReturnLink, useListParams, useReturnTrip} from '@/components/analyst/back-nav';
import Link from 'next/link';
import {usePathname, useRouter} from 'next/navigation';
import {ArrowRight, ChevronLeft, ChevronRight, ClipboardList, Info, Search} from 'lucide-react';
import type {PoDate, PoListRow} from '@/src/goldline-po-data';
import type {PoStatus} from '@/src/goldline-po';
import {Card, CardContent} from '@/components/ui/card';
import {SegmentedControl} from '@/components/analyst/segmented-control';
import {NativeSelect} from '@/components/ui/native-select';
import {peso, ToneChip} from '@/components/analyst/goldline-ops-shared';
import {InfoTip} from '@/components/analyst/info-tip';
import {buttonVariants} from '@/components/ui/button';
import {PoStatusChip} from '@/components/analyst/goldline-po-shared';
import {cn} from '@/lib/utils';

export type OrderDatesViewData = {configured: boolean; dates: PoDate[]; month: string | null};
export type OrdersOfDayViewData = {date: string; rows: PoListRow[]};

type StatusFilter = 'all' | Exclude<PoStatus, 'empty'>;
const STATUS_KEYS: Record<StatusFilter, true> = {all: true, shipped: true, partly_received: true, received: true};
// The day's status filter + search live in the URL (replaceState), so a PO's page returns here as you left it.
const DAY_LIST = {status: 'all', q: ''};

const rowDay = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', {weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC'});
const longDay = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', {weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC'});
const monthLabel = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-US', {month: 'long', year: 'numeric', timeZone: 'UTC'});
const cycleLabel = (c: string) => `${c.endsWith('a') ? '1st' : '2nd'} half of ${new Date(`${c.slice(0, 7)}-01T00:00:00Z`).toLocaleDateString('en-US', {month: 'short', timeZone: 'UTC'})}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

// Lighter table chrome than the default: no tinted header band, roomier rows, so a
// long list reads calmly (Nov 25 breathe pass).
const TH = 'border-b border-border/70 text-left text-[11px] font-medium tracking-wide whitespace-nowrap text-muted-foreground uppercase';
const ROW = 'group/row relative border-b border-border/50 transition-colors duration-150 last:border-0 hover:bg-muted/35';
// The whole row opens the link; it stretches over the row.
const ROW_LINK = 'font-medium after:absolute after:inset-0 focus-visible:underline focus-visible:outline-none';
const ARROW =
  'inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-[color,background-color,transform] duration-150 ease-out hover:bg-muted hover:text-foreground active:scale-[0.97] disabled:pointer-events-none disabled:opacity-35';
const PAGE = 'mx-auto flex w-full max-w-6xl min-w-0 flex-col gap-8 px-4 py-8 sm:px-6 lg:px-10 lg:py-10 *:min-w-0';
const HOW_IT_WORKS =
  "Lines approved on the Restock run ship from the warehouse when the PO is made. When stock arrives, fill in the received section; it counts as delivered in the next form vs. sales check.";

/** A thin received-vs-lines bar plus its count. */
function ReceivedMeter({received, lines}: {received: number; lines: number}) {
  const done = lines > 0 && received === lines;
  const ratio = lines > 0 ? Math.min(1, received / lines) : 0;
  return (
    <span className="inline-flex items-center justify-end gap-3">
      <span aria-hidden className="relative hidden h-1 w-16 overflow-hidden rounded-full bg-foreground/10 sm:block">
        <span className="absolute inset-y-0 left-0 rounded-full" style={{width: `${ratio * 100}%`, background: done ? 'var(--status-good)' : 'var(--primary)'}} />
      </span>
      <span className={cn('tabular-nums', done ? 'text-[var(--status-good)]' : 'text-muted-foreground')}>{done ? 'All received' : `${received} of ${lines}`}</span>
    </span>
  );
}

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
  // A month is a filter on this page, not a step: replace keeps Back meaning "leave Orders".
  const goMonth = (m: string) => router.replace(`${pathname}?month=${m}`, {scroll: false});
  const {leave} = useReturnTrip('orders');
  const sum = days.reduce((a, d) => ({pos: a.pos + d.pos, total: a.total + d.total, lines: a.lines + d.lines, received: a.received + d.received}), {pos: 0, total: 0, lines: 0, received: 0});
  const hasDates = data.configured && data.dates.length > 0;

  return (
    <div className={PAGE}>
      <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
        <div className="flex min-w-0 flex-col gap-2">
          <div className="flex items-baseline gap-3">
            <h1 className="font-heading text-3xl font-semibold tracking-tight">Orders</h1>
            <Link href="/stock/restock" className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
              Restock
            </Link>
          </div>
          <p className="text-sm text-muted-foreground text-pretty">
            Purchase orders by the day they were made, one per store.
            {hasDates && <InfoTip text={HOW_IT_WORKS} className="ml-1.5" />}
          </p>
        </div>
        {hasDates && (
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
        )}
      </header>

      {!data.configured ? (
        <Empty icon={Info} title="Orders aren't connected">
          <p className="max-w-sm text-sm text-muted-foreground text-pretty">Purchase orders live in the Nichido database, which isn&apos;t set up in this environment.</p>
        </Empty>
      ) : data.dates.length === 0 ? (
        <Empty icon={ClipboardList} title="No purchase orders yet">
          <ol className="flex w-full max-w-md flex-col gap-4 text-left text-sm">
            {[
              ['Approve lines', 'Pick what each store gets on the Restock run.'],
              ['Make purchase orders', 'Each store with approved lines gets one, and its lines ship.'],
              ['Fill in what arrives', 'Received stock counts as delivered in the next form check.'],
            ].map(([title, body], i) => (
              <li key={title} className="flex items-start gap-3.5">
                <span className="mt-px flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium text-muted-foreground tabular-nums">{i + 1}</span>
                <span className="flex flex-col gap-0.5 text-pretty">
                  <span className="font-medium text-foreground">{title}</span>
                  <span className="text-muted-foreground">{body}</span>
                </span>
              </li>
            ))}
          </ol>
          <Link href="/stock/restock" className={cn(buttonVariants({size: 'lg'}), 'mt-2 px-4')}>
            Go to Restock <ArrowRight className="size-4" aria-hidden />
          </Link>
        </Empty>
      ) : (
        <Card className="gap-0 py-0">
          <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 px-6 pt-6 pb-5">
            <h2 className="font-heading text-lg font-semibold">{month ? monthLabel(month) : 'Order dates'}</h2>
            <p className="text-sm text-muted-foreground tabular-nums">
              {plural(sum.pos, 'PO')} · <span className="text-foreground">{peso(sum.total)}</span> approved · {sum.received} of {plural(sum.lines, 'line')} received
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className={TH}>
                  <th className="py-3 pr-4 pl-6 font-medium">Date</th>
                  <th className="py-3 pr-4 text-right font-medium">Stores</th>
                  <th className="py-3 pr-4 text-right font-medium">Approved total</th>
                  <th className="py-3 pr-8 text-right font-medium">Received</th>
                  <th className="py-3 pr-4 font-medium">Restock run</th>
                  <th className="w-10 py-3 pr-6" aria-hidden />
                </tr>
              </thead>
              <tbody>
                {days.map((d) => (
                  <tr key={d.date} data-kept-id={d.date} className={ROW}>
                    <td className="py-4 pr-4 pl-6 whitespace-nowrap">
                      <Link data-row href={`/stock/orders/date/${d.date}`} onClick={() => leave(d.date, `/stock/orders/date/${d.date}`)} className={ROW_LINK}>
                        {rowDay(d.date)}
                      </Link>
                    </td>
                    <td className="py-4 pr-4 text-right tabular-nums">{d.pos}</td>
                    <td className="py-4 pr-4 text-right font-medium tabular-nums">{peso(d.total)}</td>
                    <td className="py-4 pr-8 text-right whitespace-nowrap">
                      <ReceivedMeter received={d.received} lines={d.lines} />
                    </td>
                    <td className="py-4 pr-4 whitespace-nowrap">
                      <span className="flex flex-wrap gap-1.5">
                        {d.cycles.map((c) => (
                          <ToneChip key={c} tone={null}>
                            {cycleLabel(c)}
                          </ToneChip>
                        ))}
                      </span>
                    </td>
                    <td className="py-4 pr-6 text-right">
                      <ChevronRight className="ml-auto size-4 text-muted-foreground/50 transition-[color,transform] duration-150 ease-out group-hover/row:translate-x-0.5 group-hover/row:text-foreground" aria-hidden />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}

export function GoldlineOrdersOfDay({data}: {data: OrdersOfDayViewData}) {
  const [lp, setLp] = useListParams(DAY_LIST);
  const {leave} = useReturnTrip('orders-day');
  const status: StatusFilter = Object.hasOwn(STATUS_KEYS, lp.status) ? (lp.status as StatusFilter) : 'all';
  const query = lp.q;
  const ofDay = data.rows;
  const statusCount = (s: StatusFilter) => (s === 'all' ? ofDay.length : ofDay.filter((r) => r.status === s).length);
  const q = query.trim().toLowerCase();
  const shown = ofDay
    .filter((r) => status === 'all' || r.status === status)
    .filter((r) => !q || r.storeCode.toLowerCase().includes(q) || (r.storeName ?? '').toLowerCase().includes(q) || r.number.toLowerCase().includes(q))
    .sort((a, b) => (a.storeName ?? a.storeCode).localeCompare(b.storeName ?? b.storeCode, undefined, {numeric: true}));

  return (
    <div className={PAGE}>
      <header className="flex flex-col gap-3">
        <nav aria-label="Breadcrumb" className="flex items-baseline gap-2 text-sm text-muted-foreground">
          <ReturnLink listKey="orders" fallback={`/stock/orders?month=${data.date.slice(0, 7)}`} className="underline-offset-4 hover:text-foreground hover:underline">
            Orders
          </ReturnLink>
          <span aria-hidden>/</span>
          <span className="text-foreground">{rowDay(data.date)}</span>
        </nav>
        <h1 className="font-heading text-3xl font-semibold tracking-tight">{longDay(data.date)}</h1>
        <p className="text-sm text-muted-foreground">One purchase order per store. Open one to see its lines or fill in what arrived.</p>
      </header>

      <Card className="py-0">
        <CardContent className="flex flex-col gap-0 px-0 pt-0 pb-0">
          <div className="flex flex-wrap items-center justify-between gap-4 px-6 pt-6 pb-5">
            <h2 className="font-heading text-lg font-semibold">{plural(ofDay.length, 'store')}</h2>
            <div className="flex flex-wrap items-center gap-2">
              <SegmentedControl<StatusFilter>
                ariaLabel="Filter by status"
                value={status}
                onChange={(v) => setLp({status: v})}
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
                  onChange={(e) => setLp({q: e.target.value})}
                  placeholder="Store or PO no."
                  className="h-8 w-48 rounded-lg border border-border bg-background pr-2 pl-7 text-sm outline-none transition-colors hover:border-foreground/25 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40"
                />
              </label>
            </div>
          </div>
          {shown.length === 0 ? (
            <p className="px-6 pt-8 pb-14 text-center text-sm text-muted-foreground">No purchase orders on this date match the filter.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className={TH}>
                    <th className="py-3 pr-4 pl-6 font-medium">Store</th>
                    <th className="py-3 pr-4 font-medium">PO</th>
                    <th className="py-3 pr-4 font-medium">Status</th>
                    <th className="py-3 pr-4 text-right font-medium">Lines</th>
                    <th className="py-3 pr-4 text-right font-medium">Approved total</th>
                    <th className="py-3 pr-6 text-right font-medium">Received</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((r) => (
                    <tr key={r.id} data-kept-id={r.id} className={ROW}>
                      <td className="py-4 pr-4 pl-6">
                        <Link data-row href={`/stock/orders/${r.id}`} onClick={() => leave(r.id, `/stock/orders/${r.id}`)} className={ROW_LINK}>
                          {r.storeName ?? `Store ${r.storeCode}`}
                        </Link>{' '}
                        <span className="font-mono text-xs text-muted-foreground">{r.storeCode}</span>
                      </td>
                      <td className="py-4 pr-4 font-mono text-[13px] whitespace-nowrap">{r.number}</td>
                      <td className="py-4 pr-4">
                        <PoStatusChip status={r.status} />
                      </td>
                      <td className="py-4 pr-4 text-right tabular-nums">{r.lines}</td>
                      <td className="py-4 pr-4 text-right tabular-nums">{peso(r.approvedTotal)}</td>
                      <td className="py-4 pr-6 text-right whitespace-nowrap tabular-nums text-muted-foreground">
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

function Empty({icon: Icon, title, children}: {icon: React.ComponentType<{className?: string}>; title: string; children: React.ReactNode}) {
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-6 px-6 py-16 text-center sm:py-20">
        <span className="flex size-12 items-center justify-center rounded-2xl bg-muted ring-1 ring-foreground/5">
          <Icon className="size-5 text-muted-foreground" aria-hidden />
        </span>
        <h2 className="font-heading text-xl font-semibold tracking-tight">{title}</h2>
        {children}
      </CardContent>
    </Card>
  );
}
