'use client';

// Goldline Restock · Hit or miss. Every line the owner decides on the Restock run is a hit
// (approved as is) or a miss (edited or rejected) for Coop's number. The board answers:
// is Coop getting better run after run, where does it miss (product lines, stores, items),
// which way is it off (too high or too low), and what did the owner say.
//
// Charts follow the dataviz method: one axis per chart (hit rate and decision counts are
// two charts), two validated colors (--hit, --miss; rejected is the miss color hatched and
// always labelled), thin marks, hover tooltips, and a table view for both charts.

import {useMemo, useState} from 'react';
import Link from 'next/link';
import {usePathname, useRouter} from 'next/navigation';
import {Info, Target} from 'lucide-react';
import {Bar, BarChart, CartesianGrid, Line, LineChart, XAxis, YAxis} from 'recharts';
import type {HitRateData} from '@/src/goldline-hit-rate-data';
import {
  byProductLine,
  byRun,
  byStore,
  change,
  deltaVsPrevious,
  filterLines,
  latestRemarks,
  mostMissed,
  OTHER_LINE,
  tally,
  type DecidedLine,
  type RunTally,
} from '@/src/goldline-hit-rate';
import {Card, CardContent} from '@/components/ui/card';
import {NativeSelect} from '@/components/ui/native-select';
import {ChartContainer, ChartTooltip, type ChartConfig} from '@/components/ui/chart';
import {Metric} from '@/components/analyst/metric';
import {SegmentedControl} from '@/components/analyst/segmented-control';
import {fmtDay, ToneChip} from '@/components/analyst/goldline-ops-shared';
import {cn} from '@/lib/utils';
import {GL_SCROLL_ROW_MOBILE, GL_TILES_MOBILE} from '@/src/goldline-ui';

export type HitRateViewData = HitRateData & {nav: React.ReactNode};

type RangeKey = '6' | '12' | 'all';
const NO_NAME = '__none__';

const pct = (x: number | null) => (x == null ? '·' : `${Math.round(x * 100)}%`);
const num = (n: number) => n.toLocaleString('en-US');
const signed = (n: number) => (n > 0 ? `+${num(n)}` : n < 0 ? `−${num(-n)}` : '0');
/** "Nov 1st" / "Oct 2nd" for a run cycle like 2026-11-a. */
const runLabel = (cycle: string) =>
  `${new Date(`${cycle.slice(0, 7)}-01T00:00:00Z`).toLocaleDateString('en-US', {month: 'short', timeZone: 'UTC'})} ${cycle.endsWith('a') ? '1st' : '2nd'}`;
const DECISION_CHIP = {edited: {label: 'Edited', tone: 'var(--status-warn)'}, rejected: {label: 'Rejected', tone: 'var(--status-crit)'}} as const;

const chartConfig = {
  rate: {label: 'Hit rate', color: 'var(--hit)'},
  hits: {label: 'Hits', color: 'var(--hit)'},
  edited: {label: 'Edited', color: 'var(--miss)'},
  rejected: {label: 'Rejected', color: 'var(--miss)'},
} satisfies ChartConfig;

export function GoldlineHitRate({data}: {data: HitRateViewData}) {
  const router = useRouter();
  const pathname = usePathname();
  const [store, setStore] = useState('');
  const [line, setLine] = useState('');
  const [by, setBy] = useState('');
  const [showTable, setShowTable] = useState(false);

  const storeName = (code: string) => data.storeNames[code] ?? `Store ${code}`;
  const itemName = (code: string) => data.itemNames[code] ?? code;

  const options = useMemo(() => {
    const nameOf = (c: string) => data.storeNames[c] ?? `Store ${c}`;
    const stores = [...new Set(data.lines.map((l) => l.storeCode))].sort((a, b) => nameOf(a).localeCompare(nameOf(b), undefined, {numeric: true}));
    const lines = [...new Set(data.lines.map((l) => l.productLine?.trim() || OTHER_LINE))].sort((a, b) => (a === OTHER_LINE ? 1 : b === OTHER_LINE ? -1 : a.localeCompare(b)));
    const people = [...new Set(data.lines.map((l) => l.decidedBy ?? ''))].sort();
    return {stores, lines, people};
  }, [data.lines, data.storeNames]);

  const shown = useMemo(
    () => filterLines(data.lines, {store: store || null, productLine: line || null, decidedBy: by === '' ? null : by === NO_NAME ? '' : by}),
    [data.lines, store, line, by],
  );
  const t = tally(shown);
  const runs = byRun(shown);
  const delta = deltaVsPrevious(runs);
  const rangeKey: RangeKey = data.range == null ? 'all' : (String(data.range) as RangeKey);
  const setRange = (k: RangeKey) => {
    const q = new URLSearchParams({tab: 'hits'});
    if (k !== '6') q.set('range', k);
    router.push(`${pathname}?${q}`, {scroll: false});
  };

  return (
    <div className="mx-auto flex max-w-7xl min-w-0 flex-col gap-6 px-4 py-6 *:min-w-0">
      <header className="flex flex-col gap-3">
        <div className="flex items-baseline gap-3">
          <h1 className="font-heading text-2xl font-semibold tracking-tight">Restock</h1>
          <Link href="/stock" className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
            Inventory
          </Link>
        </div>
        {data.nav}
        <p className="max-w-[70ch] text-sm text-muted-foreground text-pretty">
          Every line approved as is on the Restock run is a hit for Coop&apos;s number; every line edited or rejected is a miss. Lines waiting for a decision, held or covered
          don&apos;t count.
        </p>
      </header>

      {!data.configured ? (
        <Empty icon={<Info className="size-6 text-muted-foreground" aria-hidden />} title="Restock isn't connected">
          The restock reads the Nichido database, which isn&apos;t set up in this environment.
        </Empty>
      ) : data.lines.length === 0 ? (
        <Empty icon={<Target className="size-6 text-muted-foreground" aria-hidden />} title="No decisions yet">
          The hit rate starts with the first line approved, edited or rejected on the{' '}
          <Link href="/stock/restock" className="underline underline-offset-4">
            Restock run
          </Link>
          .
        </Empty>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2" aria-label="Filters">
            <div className={GL_SCROLL_ROW_MOBILE}>
              <SegmentedControl<RangeKey>
                ariaLabel="Runs"
                value={rangeKey}
                onChange={setRange}
                options={[
                  {value: '6', label: 'Last 6 runs'},
                  {value: '12', label: 'Last 12 runs'},
                  {value: 'all', label: 'All runs'},
                ]}
              />
            </div>
            <NativeSelect aria-label="Store" value={store} onChange={(e) => setStore(e.target.value)}>
              <option value="">All stores ({options.stores.length})</option>
              {options.stores.map((s) => (
                <option key={s} value={s}>
                  {storeName(s)}
                </option>
              ))}
            </NativeSelect>
            <NativeSelect aria-label="Product line" value={line} onChange={(e) => setLine(e.target.value)}>
              <option value="">All product lines</option>
              {options.lines.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </NativeSelect>
            {options.people.length > 1 && (
              <NativeSelect aria-label="Decided by" value={by} onChange={(e) => setBy(e.target.value)}>
                <option value="">Decided by anyone</option>
                {options.people.map((p) => (
                  <option key={p || NO_NAME} value={p || NO_NAME}>
                    {p || 'No name on file'}
                  </option>
                ))}
              </NativeSelect>
            )}
          </div>

          <section aria-label="Summary" className={cn('grid grid-cols-2 gap-4 lg:grid-cols-4', GL_TILES_MOBILE)}>
            <Metric
              label="Hit rate"
              value={pct(t.rate)}
              valueClassName="text-[var(--hit)]"
              sub={
                <>
                  {num(t.hits)} of {num(t.decided)} lines
                  {delta && runs.length > 1 && (
                    <>
                      {' '}
                      · latest run {pct(delta.latest)}
                      {delta.points != null && delta.points !== 0 && (
                        <span className={cn('font-medium', delta.points > 0 ? 'text-[var(--status-good)]' : 'text-[var(--status-crit)]')}>
                          {' '}
                          {delta.points > 0 ? 'up' : 'down'} {Math.abs(delta.points)} pts
                        </span>
                      )}
                    </>
                  )}
                </>
              }
            />
            <Metric label="Hits" value={num(t.hits)} sub="approved as is" />
            <Metric label="Misses" value={num(t.misses)} sub={`${num(t.edited)} edited · ${num(t.rejected)} rejected`} />
            <Metric label="Units changed" value={num(t.tooHigh + t.tooLow)} sub={`Coop too high ${num(t.tooHigh)} · too low ${num(t.tooLow)}`} />
          </section>

          <div className="grid gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
            <Panel title="Hit rate by run" legend={<Swatch kind="hit" label="Hit rate" />}>
              <RateChart runs={runs} />
            </Panel>
            <Panel title="Decisions per run" legend={<><Swatch kind="hit" label="Hit" /><Swatch kind="miss" label="Edited" /><Swatch kind="rejected" label="Rejected" /></>}>
              <MixChart runs={runs} />
            </Panel>
          </div>
          <div className="-mt-2">
            <button type="button" onClick={() => setShowTable((v) => !v)} aria-expanded={showTable} className="text-xs font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
              {showTable ? 'Hide the table' : 'Show both charts as a table'}
            </button>
            {showTable && <RunTable runs={runs} />}
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Panel title="Where Coop misses, by product line" legend={<><Swatch kind="miss" label="Too high" /><Swatch kind="hit" label="Too low" /></>}>
              <LineTable lines={shown} />
            </Panel>
            <Panel title="Stores" legend={<span className="text-xs text-muted-foreground">lowest hit rate first</span>}>
              <StoreTable lines={shown} storeName={storeName} />
            </Panel>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Panel title="Most missed items">
              <MissedTable lines={shown} itemName={itemName} />
            </Panel>
            <Panel title="Owner's remarks">
              <Remarks lines={shown} itemName={itemName} storeName={storeName} />
            </Panel>
          </div>
        </>
      )}
    </div>
  );
}

// ── Charts ──────────────────────────────────────────────────────────────────────────

const AXIS = {tickLine: false, axisLine: false, fontSize: 11} as const;

function RateChart({runs}: {runs: RunTally[]}) {
  const rows = runs.map((r) => ({...r, label: runLabel(r.cycle), rate: r.rate == null ? null : Math.round(r.rate * 1000) / 10}));
  return (
    <ChartContainer config={chartConfig} className="h-[220px] w-full">
      <LineChart data={rows} margin={{left: 0, right: 12, top: 12, bottom: 0}}>
        <CartesianGrid vertical={false} strokeDasharray="3 3" />
        <XAxis dataKey="label" {...AXIS} tickMargin={8} />
        <YAxis {...AXIS} width={40} domain={[0, 100]} ticks={[0, 25, 50, 75, 100]} tickFormatter={(v) => `${v}%`} />
        <ChartTooltip cursor={{strokeDasharray: '3 3'}} content={<RunTooltip />} />
        <Line dataKey="rate" type="linear" stroke="var(--hit)" strokeWidth={2} dot={{r: 4, strokeWidth: 2, fill: 'var(--card)'}} activeDot={{r: 6}} isAnimationActive={false} />
      </LineChart>
    </ChartContainer>
  );
}

function MixChart({runs}: {runs: RunTally[]}) {
  const rows = runs.map((r) => ({...r, label: runLabel(r.cycle)}));
  return (
    <ChartContainer config={chartConfig} className="h-[220px] w-full">
      <BarChart data={rows} margin={{left: 0, right: 4, top: 12, bottom: 0}} barCategoryGap="28%">
        <defs>
          <pattern id="hit-rate-hatch" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="5" height="5" fill="var(--miss-soft)" />
            <line x1="0" y1="0" x2="0" y2="5" stroke="var(--miss)" strokeWidth="2.4" />
          </pattern>
        </defs>
        <CartesianGrid vertical={false} strokeDasharray="3 3" />
        <XAxis dataKey="label" {...AXIS} tickMargin={8} />
        <YAxis {...AXIS} width={32} allowDecimals={false} />
        <ChartTooltip cursor={{fill: 'var(--muted)', opacity: 0.4}} content={<RunTooltip />} />
        {/* A 2px card-colored stroke separates the stacked segments. */}
        <Bar dataKey="hits" stackId="d" fill="var(--hit)" stroke="var(--card)" strokeWidth={2} isAnimationActive={false} />
        <Bar dataKey="edited" stackId="d" fill="var(--miss)" stroke="var(--card)" strokeWidth={2} isAnimationActive={false} />
        <Bar dataKey="rejected" stackId="d" fill="url(#hit-rate-hatch)" stroke="var(--card)" strokeWidth={2} radius={[4, 4, 0, 0]} isAnimationActive={false} />
      </BarChart>
    </ChartContainer>
  );
}

function RunTooltip({active, payload}: {active?: boolean; payload?: Array<{payload: RunTally & {label: string}}>}) {
  const r = payload?.[0]?.payload;
  if (!active || !r) return null;
  return (
    <div className="grid gap-0.5 rounded-lg border border-border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md tabular-nums">
      <span className="font-medium">{r.label} run</span>
      <span>Hit rate {pct(r.rate)}</span>
      <span className="text-muted-foreground">
        {num(r.hits)} hits · {num(r.edited)} edited · {num(r.rejected)} rejected
      </span>
    </div>
  );
}

function RunTable({runs}: {runs: RunTally[]}) {
  return (
    <div className="mt-2 overflow-x-auto rounded-lg border border-border">
      <table className="w-full border-collapse text-sm tabular-nums">
        <thead>
          <tr className="border-b border-border bg-muted/40 text-left text-[11px] tracking-wide text-muted-foreground uppercase">
            <th className="py-2 pr-3 pl-4 font-medium">Run</th>
            <th className="py-2 pr-3 text-right font-medium">Hit rate</th>
            <th className="py-2 pr-3 text-right font-medium">Hits</th>
            <th className="py-2 pr-3 text-right font-medium">Edited</th>
            <th className="py-2 pr-3 text-right font-medium">Rejected</th>
            <th className="py-2 pr-4 text-right font-medium">Units off (too high · too low)</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.cycle} className="border-b border-border/60 last:border-0">
              <td className="py-2 pr-3 pl-4">{runLabel(r.cycle)}</td>
              <td className="py-2 pr-3 text-right">{pct(r.rate)}</td>
              <td className="py-2 pr-3 text-right">{num(r.hits)}</td>
              <td className="py-2 pr-3 text-right">{num(r.edited)}</td>
              <td className="py-2 pr-3 text-right">{num(r.rejected)}</td>
              <td className="py-2 pr-4 text-right">
                {num(r.tooHigh)} · {num(r.tooLow)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Tables ──────────────────────────────────────────────────────────────────────────

const TH = 'py-2 pr-3 text-[11px] font-medium tracking-wide whitespace-nowrap text-muted-foreground uppercase';
const TD = 'py-2 pr-3 align-middle';

function RateBar({rate}: {rate: number | null}) {
  return (
    <span className="flex min-w-[7rem] items-center gap-2">
      <span className="relative h-2 flex-1 rounded-full bg-muted" aria-hidden>
        <span className="absolute inset-y-0 left-0 rounded-full bg-[var(--hit)]" style={{width: `${Math.round((rate ?? 0) * 100)}%`}} />
      </span>
      <span className="w-9 text-right tabular-nums">{pct(rate)}</span>
    </span>
  );
}

function LineTable({lines}: {lines: DecidedLine[]}) {
  const rows = byProductLine(lines);
  const max = Math.max(1, ...rows.flatMap((r) => [r.tooHigh, r.tooLow]));
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm tabular-nums">
        <thead>
          <tr className="border-b border-border text-left">
            <th className={TH}>Product line</th>
            <th className={TH}>Hit rate</th>
            <th className={cn(TH, 'text-right')}>Misses</th>
            <th className={cn(TH, 'text-center')}>Units off: too high · too low</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} className="border-b border-border/60 last:border-0">
              <td className={cn(TD, 'max-w-[16rem]')}>{r.key}</td>
              <td className={TD}>
                <RateBar rate={r.rate} />
              </td>
              <td className={cn(TD, 'text-right whitespace-nowrap')}>
                {num(r.misses)} of {num(r.decided)}
              </td>
              <td className={cn(TD, 'pr-0')} title={`Coop too high ${r.tooHigh} units · too low ${r.tooLow} units`}>
                <span className="grid min-w-[8rem] grid-cols-[1fr_1px_1fr] items-center">
                  <span className="flex justify-end">
                    <span className="block h-2 rounded-l-full bg-[var(--miss)]" style={{width: `${(r.tooHigh / max) * 100}%`}} />
                  </span>
                  <span className="h-4 bg-muted-foreground/50" aria-hidden />
                  <span className="flex">
                    <span className="block h-2 rounded-r-full bg-[var(--hit)]" style={{width: `${(r.tooLow / max) * 100}%`}} />
                  </span>
                </span>
                <span className="flex justify-between text-[11px] text-muted-foreground">
                  <span>{num(r.tooHigh)}</span>
                  <span>{num(r.tooLow)}</span>
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StoreTable({lines, storeName}: {lines: DecidedLine[]; storeName: (c: string) => string}) {
  const rows = byStore(lines);
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm tabular-nums">
        <thead>
          <tr className="border-b border-border text-left">
            <th className={TH}>Store</th>
            <th className={TH}>Hit rate</th>
            <th className={cn(TH, 'text-right')}>Decided</th>
            <th className={cn(TH, 'text-right')}>Misses</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} className="relative border-b border-border/60 transition-colors duration-150 last:border-0 hover:bg-muted/40">
              <td className={TD}>
                {/* Opens the store's lines on the Run tab; the link stretches over the row. */}
                <Link href={`/stock/restock?store=${encodeURIComponent(r.key)}`} className="underline-offset-4 after:absolute after:inset-0 hover:underline focus-visible:underline focus-visible:outline-none">
                  {storeName(r.key)}
                </Link>
              </td>
              <td className={TD}>
                <RateBar rate={r.rate} />
              </td>
              <td className={cn(TD, 'text-right')}>{num(r.decided)}</td>
              <td className={cn(TD, 'text-right')}>{num(r.misses)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MissedTable({lines, itemName}: {lines: DecidedLine[]; itemName: (c: string) => string}) {
  const rows = mostMissed(lines, 6);
  if (!rows.length) return <p className="py-6 text-center text-sm text-muted-foreground">No misses in view. Every decided line was approved as is.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm tabular-nums">
        <thead>
          <tr className="border-b border-border text-left">
            <th className={TH}>Item</th>
            <th className={cn(TH, 'text-right')}>Missed</th>
            <th className={cn(TH, 'text-right')}>Typical change</th>
            <th className={TH}>Latest remark</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.itemCode} className="border-b border-border/60 last:border-0">
              <td className={TD}>
                {itemName(r.itemCode)} <span className="font-mono text-xs text-muted-foreground">{r.itemCode}</span>
              </td>
              <td className={cn(TD, 'text-right whitespace-nowrap')}>
                {num(r.missed)} of {num(r.decided)}
              </td>
              <td className={cn(TD, 'text-right')}>{signed(r.typicalChange)}</td>
              <td className={cn(TD, 'max-w-[18rem] text-xs text-muted-foreground italic')}>{r.latestRemark ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Remarks({lines, itemName, storeName}: {lines: DecidedLine[]; itemName: (c: string) => string; storeName: (c: string) => string}) {
  const rows = latestRemarks(lines, 6);
  if (!rows.length) return <p className="py-6 text-center text-sm text-muted-foreground">No remarks yet. Edits and rejections each carry one.</p>;
  return (
    <ul className="flex flex-col">
      {rows.map((l) => {
        const chip = DECISION_CHIP[l.decision as 'edited' | 'rejected'];
        const final = l.decision === 'rejected' ? 0 : (l.finalQty ?? 0);
        return (
          <li key={`${l.cycle}|${l.storeCode}|${l.itemCode}`} className="grid grid-cols-[4.5rem_minmax(0,1fr)_auto] items-baseline gap-x-3 gap-y-0.5 border-b border-border/60 py-2.5 last:border-0">
            <span className="text-xs text-muted-foreground tabular-nums">{fmtDay((l.decidedAt ?? l.runDate).slice(0, 10))}</span>
            <span className="min-w-0 text-sm">
              {storeName(l.storeCode)} · {itemName(l.itemCode)} <ToneChip tone={chip.tone}>{chip.label}</ToneChip>
              <span className="block text-xs text-muted-foreground italic">{l.remark}</span>
            </span>
            <span className="text-sm whitespace-nowrap tabular-nums" title={`Change ${signed(change(l))}`}>
              {num(l.suggested ?? 0)} → {num(final)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

// ── Bits ────────────────────────────────────────────────────────────────────────────

function Panel({title, legend, children}: {title: string; legend?: React.ReactNode; children: React.ReactNode}) {
  return (
    <Card className="py-0">
      <CardContent className="flex flex-col gap-3 p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold">{title}</h2>
          {legend && <span className="flex flex-wrap items-center gap-3">{legend}</span>}
        </div>
        {children}
      </CardContent>
    </Card>
  );
}

function Swatch({kind, label}: {kind: 'hit' | 'miss' | 'rejected'; label: string}) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      <span
        aria-hidden
        className="size-3 rounded-[3px]"
        style={{
          background:
            kind === 'hit' ? 'var(--hit)' : kind === 'miss' ? 'var(--miss)' : 'repeating-linear-gradient(45deg, var(--miss) 0 2px, var(--miss-soft) 2px 4px)',
        }}
      />
      {label}
    </span>
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
