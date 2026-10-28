'use client';

// Goldline Restock · one product. Its last 12 months of POS Sales Data with last year's
// window and safety month marked, then the run's months forecast from those same months,
// stock running down with and without the send, and the working behind the number. One
// store, or every store in view added up (with a row per store). The saved run's line and
// the owner's decision win; with no run yet the numbers are a preview.

import Link from 'next/link';
import {usePathname, useRouter} from 'next/navigation';
import {ArrowLeft, CalendarClock, ChevronRight, Info} from 'lucide-react';
import type {RestockItemData} from '@/src/goldline-restock-item-data';
import type {Decision} from '@/src/goldline-restock';
import {restockItemHref, type ItemStoreLine} from '@/src/goldline-restock-item';
import {Metric} from '@/components/analyst/metric';
import {NativeSelect} from '@/components/ui/native-select';
import {Card, CardContent} from '@/components/ui/card';
import {fmtDay, ToneChip} from '@/components/analyst/goldline-ops-shared';
import {HOLD_LABEL, monthLabel, num, span} from '@/components/analyst/goldline-restock-inputs';
import {RestockYearChart} from '@/components/analyst/restock-year-chart';
import {cn} from '@/lib/utils';
import {GL_TILES_MOBILE} from '@/src/goldline-ui';

export type RestockItemViewData = RestockItemData & {runDate: string; today: string; preview: boolean};

const DECISION: Record<Decision, {label: string; tone: string | null}> = {
  pending: {label: 'To decide', tone: 'var(--status-warn)'},
  approved: {label: 'Approved', tone: 'var(--status-good)'},
  edited: {label: 'Edited', tone: 'var(--status-warn)'},
  rejected: {label: 'Rejected', tone: 'var(--status-crit)'},
};
const list = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const storeLabel = (code: string, name: string | null) => (name ? `${code} · ${name}` : `Store ${code}`);

export function GoldlineRestockItem({data}: {data: RestockItemViewData}) {
  const router = useRouter();
  const pathname = usePathname();
  const {item, window: w, store, totals} = data;
  const one = store ? data.lines[0] : null;
  const asOf = data.preview ? data.runDate : null;
  const backHref = (() => {
    const q = new URLSearchParams();
    if (store) q.set('store', store);
    if (asOf) q.set('asOf', asOf);
    return q.size ? `/stock/restock?${q}` : '/stock/restock';
  })();
  const go = (next: {store?: string | null; asOf?: string | null}) => {
    const q = new URLSearchParams();
    const s = next.store === undefined ? store : next.store;
    const a = next.asOf === undefined ? asOf : next.asOf;
    if (s) q.set('store', s);
    if (a && a !== data.today) q.set('asOf', a);
    router.push(q.size ? `${pathname}?${q}` : pathname);
  };

  const have = one ? (one.state === 'held' ? null : Math.max(0, one.onHand ?? 0) + one.onTheWay) : totals.ready ? totals.onHand + totals.onTheWay : null;
  const send = one ? one.send : totals.ready ? totals.send : null;
  const anySales = data.year.some((m) => (m.units ?? 0) > 0);

  return (
    <div className="mx-auto flex max-w-6xl min-w-0 flex-col gap-6 px-4 py-6 *:min-w-0">
      <header className="flex flex-col gap-3">
        <Link href={backHref} className="inline-flex w-fit items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground">
          <ArrowLeft className="size-3.5" aria-hidden /> Restock
        </Link>
        <h1 className="font-heading text-2xl font-semibold tracking-tight text-balance">{item.name}</h1>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          {data.stores.length > 0 && (
            <NativeSelect aria-label="Store" value={store ?? ''} onChange={(e) => go({store: e.target.value || null})}>
              <option value="">All stores ({data.stores.length})</option>
              {data.stores.map((s) => (
                <option key={s.code} value={s.code}>
                  {storeLabel(s.code, s.name)}
                </option>
              ))}
            </NativeSelect>
          )}
          <label className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <CalendarClock className="size-3.5" aria-hidden />
            Run date
            <input
              id="restock-item-run-date"
              type="date"
              value={data.runDate}
              onChange={(e) => e.target.value && go({asOf: e.target.value})}
              className="h-8 rounded-md border border-border bg-background px-2 text-sm text-foreground tabular-nums outline-none transition-colors hover:border-foreground/25 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40"
            />
          </label>
          {data.preview && (
            <button type="button" onClick={() => go({asOf: null})} className="text-xs font-medium underline-offset-4 hover:underline">
              Back to today
            </button>
          )}
          <span className="font-mono text-xs text-muted-foreground">
            {item.itemCode}
            {one?.onHandPeriodEnd ? ` · counted ${fmtDay(one.onHandPeriodEnd)}` : ''}
          </span>
          <Link href={`/stock/${encodeURIComponent(item.itemCode)}${store ? `?store=${encodeURIComponent(store)}` : ''}`} className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
            Inventory view
          </Link>
        </div>
        <p className="max-w-[70ch] text-sm text-muted-foreground text-pretty">
          A run on <span className="font-medium text-foreground">{fmtDay(w.runDate)}</span> covers <span className="font-medium text-foreground">{span(w.months)}</span>, from last year&apos;s{' '}
          {span(w.lastYear)}
          {w.safety.length ? `, plus ${list(w.safety.map((m) => monthLabel(m, {month: 'short'})))} as safety` : ', with no safety stock'}.{' '}
          {data.runSaved ? 'Numbers come from the saved run.' : 'No run for this half month yet, so these numbers are a preview.'}
        </p>
        <div className="h-0.5 w-24 rounded-full bg-gradient-to-r from-primary to-transparent" aria-hidden />
      </header>

      {data.stores.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 px-6 py-12 text-center">
            <Info className="size-6 text-muted-foreground" aria-hidden />
            <h2 className="font-heading text-base font-semibold">Nothing to restock yet</h2>
            <p className="max-w-md text-sm text-muted-foreground text-pretty">
              {item.skuLinked
                ? `No store you can see sold this product in ${span(w.lastYear)} or has it on its latest form.`
                : "This product isn't linked to a Watsons SKU, so its POS Sales Data can't be read. Link it on SKU linking."}
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          <section aria-label="Summary" className={cn('grid grid-cols-2 gap-4 lg:grid-cols-4', GL_TILES_MOBILE)}>
            <Metric
              label="Last year"
              value={one ? (one.need == null ? '·' : num(one.need)) : num(totals.need)}
              sub={one ? one.lyUnits.map((u) => (u == null ? '?' : num(u))).join(' · ') : `${span(w.lastYear)}, ${totals.stores} ${totals.stores === 1 ? 'store' : 'stores'}`}
            />
            <Metric label="Safety" value={one ? (one.safety == null ? '·' : num(one.safety)) : num(totals.safety)} sub={w.safety.length ? list(w.safety.map((m) => monthLabel(m))) : 'none'} />
            <Metric
              label="On hand"
              value={one ? (one.onHand == null ? 'Blank' : num(one.onHand)) : num(totals.onHand)}
              sub={one ? `+ ${num(one.onTheWay)} on the way` : `+ ${num(totals.onTheWay)} on the way · ${totals.ready} ${totals.ready === 1 ? 'store' : 'stores'} with a number`}
            />
            <Metric
              label="Send"
              value={send == null ? '·' : num(send)}
              sub={one ? <LineStatus line={one} /> : `${totals.held} ${totals.held === 1 ? 'store waits' : 'stores wait'} for a data check`}
              valueClassName={send ? 'text-[var(--status-good)]' : undefined}
            />
          </section>

          <Card>
            <CardContent className="flex flex-col gap-3">
              <h2 className="font-heading text-base font-semibold">A year of sales, then this run{store ? '' : ' · all stores'}</h2>
              {anySales ? (
                <>
                  <p className="max-w-3xl text-xs leading-relaxed text-muted-foreground">
                    Bars are pieces sold from the POS Sales Data. Last year&apos;s window is solid; the run&apos;s months (dashed) sell what the same months sold last year. The blue line is
                    stock with the send landing at the start of the run; the dotted line is without it.
                    {!store && ` Bars add up every store; the stock line follows the ${totals.ready} ${totals.ready === 1 ? 'store' : 'stores'} with a number (the rest wait for a data check).`}
                  </p>
                  <div className="-mx-1 overflow-x-auto px-1">
                    <div className="min-w-[40rem]">
                      <RestockYearChart year={data.year} projection={data.projection} have={have} send={send} />
                    </div>
                  </div>
                </>
              ) : (
                <p className="rounded-lg border border-dashed px-4 py-4 text-sm text-muted-foreground">
                  {item.skuLinked ? 'No sales in the last 12 months.' : "Not linked to a Watsons SKU, so there's no POS Sales Data to show. Link it on SKU linking."}
                </p>
              )}
              {one && <Working line={one} lastYear={w.lastYear} />}
            </CardContent>
          </Card>

          <div className={cn('grid gap-6', !store && 'lg:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]')}>
            <MonthsCard data={data} />
            {!store && <StoresCard lines={data.lines} itemCode={item.itemCode} asOf={asOf} />}
          </div>
        </>
      )}
    </div>
  );
}

function LineStatus({line: l}: {line: RestockItemData['lines'][number]}) {
  if (l.state === 'held')
    return (
      <span className="flex flex-wrap gap-1">
        {l.holds.map((h) => (
          <span key={h} title={HOLD_LABEL[h].hint}>
            <ToneChip tone={HOLD_LABEL[h].tone}>{HOLD_LABEL[h].label}</ToneChip>
          </span>
        ))}
      </span>
    );
  if (l.state === 'covered')
    return l.warehouseShort ? <ToneChip tone="var(--status-warn)">Warehouse has none to spare</ToneChip> : <>Good for the window</>;
  return (
    <span className="flex flex-wrap items-center gap-1">
      {l.decision ? <ToneChip tone={DECISION[l.decision].tone}>{DECISION[l.decision].label}</ToneChip> : <ToneChip tone={null}>Preview</ToneChip>}
      {l.warehouseShort && <ToneChip tone="var(--status-warn)">Warehouse short</ToneChip>}
    </span>
  );
}

function Working({line: l, lastYear}: {line: ItemStoreLine; lastYear: string[]}) {
  const box = 'rounded-lg bg-muted/50 px-3 py-2 text-xs text-muted-foreground tabular-nums';
  if (l.state === 'held') return <p className={box}>Coop gives no number until this is cleared: {l.holds.map((h) => HOLD_LABEL[h].hint.toLowerCase()).join('; ')}.</p>;
  const need = l.need ?? 0;
  const safety = l.safety ?? 0;
  const raw = Math.max(0, need - Math.max(0, l.onHand ?? 0) - l.onTheWay + safety);
  return (
    <p className={box}>
      Why {num(raw)}: {lastYear.map((m, i) => `${monthLabel(m, {month: 'short'})} ${num(l.lyUnits[i] ?? 0)}`).join(' + ')} = {num(need)}, minus {num(l.onHand ?? 0)} on hand
      {l.onTheWay ? ` and ${num(l.onTheWay)} on the way` : ''}, plus {num(safety)} safety ={' '}
      <span className="font-semibold text-foreground">{num(raw)}</span>
      {raw === 0 && ', so the store is good for the window'}.
      {l.warehouseShort && ` The warehouse can't cover every store, so this store's share is ${num(l.suggested ?? 0)}.`}
      {(l.decision === 'edited' || l.decision === 'rejected') && ` The owner ${l.decision === 'edited' ? `changed it to ${num(l.finalQty ?? 0)}` : 'rejected it'}${l.remark ? `: "${l.remark}"` : ''}.`}
    </p>
  );
}

const TH = 'py-2 pr-3 font-medium';
const TD = 'py-2 pr-3';

function MonthsCard({data}: {data: RestockItemViewData}) {
  const rows = [
    ...data.year.map((m) => ({key: m.month, label: monthLabel(m.month), units: m.units, use: m.safety ? 'Window and safety' : m.inWindow ? "Last year's window" : null, forecast: false})),
    ...data.projection.map((m) => ({key: m.month, label: monthLabel(m.month), units: m.units, use: `Forecast, from ${monthLabel(m.lastYear)}`, forecast: true})),
  ];
  return (
    <Card className="py-0">
      <CardContent className="flex flex-col gap-1 px-0 pt-4 pb-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2 px-4">
          <h2 className="font-heading text-base font-semibold">Month by month</h2>
          <span className="text-xs text-muted-foreground">POS Sales Data</span>
        </div>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-y border-border bg-muted/40 text-left text-[11px] tracking-wide whitespace-nowrap text-muted-foreground uppercase">
                <th className={cn(TH, 'pl-4')}>Month</th>
                <th className={cn(TH, 'text-right')}>Pieces</th>
                <th className={cn(TH, 'pr-4')}>Used for</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key} className={cn('border-b border-border/60 last:border-b-0', r.forecast && 'bg-muted/30')}>
                  <td className={cn(TD, 'pl-4 whitespace-nowrap')}>{r.label}</td>
                  <td className={cn(TD, 'text-right font-mono text-xs font-semibold tabular-nums')}>
                    {r.units == null ? <span className="font-normal text-[var(--status-warn)]">Not loaded</span> : `${r.forecast ? '~' : ''}${num(r.units)}`}
                  </td>
                  <td className={cn(TD, 'pr-4 text-xs', r.use ? 'text-foreground' : 'text-muted-foreground')}>{r.use ?? 'Shown only'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

function StoresCard({lines, itemCode, asOf}: {lines: RestockItemData['lines']; itemCode: string; asOf: string | null}) {
  const rank = (l: RestockItemData['lines'][number]) => (l.state === 'send' ? 0 : l.state === 'covered' ? 1 : 2);
  const sorted = [...lines].sort((a, b) => rank(a) - rank(b) || (b.send ?? 0) - (a.send ?? 0) || a.storeCode.localeCompare(b.storeCode, undefined, {numeric: true}));
  return (
    <Card className="py-0">
      <CardContent className="flex flex-col gap-1 px-0 pt-4 pb-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2 px-4">
          <h2 className="font-heading text-base font-semibold">By store</h2>
          <span className="text-xs text-muted-foreground">most to send first · open a store for its year</span>
        </div>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-y border-border bg-muted/40 text-left text-[11px] tracking-wide whitespace-nowrap text-muted-foreground uppercase">
                <th className={cn(TH, 'pl-4')}>Store</th>
                <th className={cn(TH, 'text-right')}>Last year</th>
                <th className={cn(TH, 'text-right')}>Safety</th>
                <th className={cn(TH, 'text-right')}>On hand</th>
                <th className={cn(TH, 'text-right')}>Send</th>
                <th className={TH}>Status</th>
                <th className="w-8 py-2 pr-3" aria-hidden />
              </tr>
            </thead>
            <tbody>
              {sorted.map((l) => (
                <tr key={l.storeCode} className="group relative border-b border-border/60 transition-colors duration-150 last:border-b-0 hover:bg-muted/40 has-[a:focus-visible]:bg-muted/40">
                  <td className={cn(TD, 'pl-4')}>
                    <Link
                      href={restockItemHref(itemCode, l.storeCode, asOf)}
                      className="font-medium whitespace-nowrap outline-none after:absolute after:inset-0 after:content-[''] focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset"
                    >
                      {storeLabel(l.storeCode, l.name)}
                    </Link>
                  </td>
                  <td className={cn(TD, 'text-right font-mono text-xs tabular-nums')}>{l.need == null ? '·' : num(l.need)}</td>
                  <td className={cn(TD, 'text-right font-mono text-xs tabular-nums')}>{l.safety == null ? '·' : num(l.safety)}</td>
                  <td className={cn(TD, 'text-right font-mono text-xs whitespace-nowrap tabular-nums')}>
                    {l.onHand == null ? <span className="text-muted-foreground">·</span> : num(l.onHand)}
                    {l.onTheWay > 0 && <span className="text-muted-foreground"> + {num(l.onTheWay)}</span>}
                  </td>
                  <td className={cn(TD, 'text-right font-mono text-xs font-semibold tabular-nums')}>{l.send == null ? <span className="font-normal text-muted-foreground">·</span> : num(l.send)}</td>
                  <td className={TD}>
                    <LineStatus line={l} />
                  </td>
                  <td className="py-2 pr-3 text-muted-foreground">
                    <ChevronRight className="size-4" aria-hidden />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
