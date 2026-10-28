'use client';

// Goldline Restock · forecast inputs (F10), the page's Inputs tab. For the next run: the months it covers, last
// year's same months (loaded or missing), how many store × product lines are ready, and
// which wait ("check data first") and why. All stores = one row per store; one store =
// one row per product. Window and safety months live in Restock settings.

import {useMemo, useState, useTransition} from 'react';
import Link from 'next/link';
import {usePathname, useRouter} from 'next/navigation';
import {AlertTriangle, CalendarClock, CheckCircle2, Info, Loader2, Settings2} from 'lucide-react';
import type {ForecastData} from '@/src/goldline-forecast-data';
import {HOLD_REASONS, MAX_WINDOW_MONTHS, type HoldReason} from '@/src/goldline-forecast';
import {Metric} from '@/components/analyst/metric';
import {SegmentedControl} from '@/components/analyst/segmented-control';
import {Pagination} from '@/components/analyst/pagination';
import {NativeSelect} from '@/components/ui/native-select';
import {Card, CardContent} from '@/components/ui/card';
import {Button} from '@/components/ui/button';
import {fmtDay, ToneChip} from '@/components/analyst/goldline-ops-shared';
import {Modal} from '@/components/analyst/goldline-supply-dialogs';
import {saveForecastSettingsAction} from '@/app/stock/actions';
import {cn} from '@/lib/utils';
import {GL_SCROLL_ROW_MOBILE, GL_TILES_MOBILE} from '@/src/goldline-ui';

export type RestockViewData = ForecastData & {company: string | null; today: string; preview: boolean; canEditSettings: boolean; nav?: React.ReactNode};

type Filter = 'all' | 'ready' | 'held';
const PAGE_SIZE = 25;

export const HOLD_LABEL: Record<HoldReason, {label: string; hint: string; tone: string | null}> = {
  missing_month: {label: 'Month missing', hint: "A month of last year's POS Sales Data isn't loaded", tone: 'var(--status-warn)'},
  out_of_scope: {label: 'Store out of scope', hint: 'No sales in the last 3 loaded months, or set Always out', tone: null},
  no_count: {label: 'No count yet', hint: 'The store has no counted form, so its stock on hand is unknown', tone: 'var(--status-warn)'},
  blank_on_form: {label: 'Blank on form', hint: "The store's latest form has no figure for this product", tone: 'var(--status-warn)'},
  retired: {label: 'Retired', hint: 'The product is retired', tone: null},
  open_flag: {label: 'Open flag', hint: 'An open flag for this store and product', tone: 'var(--status-crit)'},
  no_history: {label: 'No sales last year', hint: "Counted now, but didn't sell in last year's window", tone: 'var(--status-warn)'},
};

export const num = (n: number) => n.toLocaleString('en-US');
const compact = (n: number) => new Intl.NumberFormat('en', {notation: 'compact', maximumFractionDigits: 0}).format(n);
export const monthLabel = (key: string, opts: Intl.DateTimeFormatOptions = {month: 'short', year: 'numeric'}) => {
  const [y, m] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-US', {...opts, timeZone: 'UTC'});
};
export const span = (months: string[]) => (months.length === 1 ? monthLabel(months[0]) : `${monthLabel(months[0])} to ${monthLabel(months[months.length - 1])}`);
const list = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

export function GoldlineRestockInputs({data}: {data: RestockViewData}) {
  const router = useRouter();
  const pathname = usePathname();
  const {window: w, summary, settings, store} = data;
  const [filter, setFilter] = useState<Filter>('all');
  const [page, setPage] = useState(1);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const go = (next: {store?: string | null; asOf?: string | null}) => {
    const q = new URLSearchParams({tab: 'inputs'});
    const s = next.store === undefined ? store : next.store;
    const a = next.asOf === undefined ? (data.preview ? w.runDate : null) : next.asOf;
    if (s) q.set('store', s);
    if (a && a !== data.today) q.set('asOf', a);
    router.push(`${pathname}?${q}`);
  };

  const storeRows = useMemo(() => data.stores.filter((r) => (filter === 'ready' ? r.ready > 0 : filter === 'held' ? r.held > 0 : true)), [data.stores, filter]);
  const lineRows = useMemo(() => data.lines.filter((l) => (filter === 'ready' ? !l.holds.length : filter === 'held' ? l.holds.length > 0 : true)), [data.lines, filter]);
  const total = store ? lineRows.length : storeRows.length;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const at = Math.min(page, pageCount);
  const slice = <T,>(xs: T[]) => xs.slice((at - 1) * PAGE_SIZE, at * PAGE_SIZE);
  const picked = store ? data.stores.find((s) => s.storeCode === store) : null;
  const counts = store
    ? {all: data.lines.length, ready: data.lines.filter((l) => !l.holds.length).length, held: data.lines.filter((l) => l.holds.length).length}
    : {all: summary.lines, ready: summary.ready, held: summary.held};
  const unlinkedPct = summary.windowUnits ? Math.round((summary.unlinkedUnits / summary.windowUnits) * 100) : 0;
  const inWindow = new Set(w.lastYear);
  const safety = new Set(w.safety);

  return (
    <div className="mx-auto flex max-w-7xl min-w-0 flex-col gap-6 px-4 py-6 *:min-w-0">
      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-2">
            <div className="flex items-baseline gap-3">
              <h1 className="font-heading text-2xl font-semibold tracking-tight">Restock</h1>
              <Link href="/stock" className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
                Inventory
              </Link>
            </div>
            {data.nav}
            <p className="max-w-[70ch] text-sm text-muted-foreground text-pretty">
              A run on <span className="font-medium text-foreground">{fmtDay(w.runDate)}</span> covers{' '}
              <span className="font-medium text-foreground">{span(w.months)}</span>, from last year&apos;s {span(w.lastYear)}
              {w.safety.length > 0 ? (
                <>
                  , plus {w.safety.length === 1 ? 'a safety month' : `${w.safety.length} safety months`} ({list(w.safety.map((m) => monthLabel(m)))}).
                </>
              ) : (
                <>, with no safety stock.</>
              )}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <NativeSelect aria-label="Store" value={store ?? ''} onChange={(e) => (setPage(1), go({store: e.target.value || null}))}>
                <option value="">All stores ({data.stores.length})</option>
                {data.stores.map((s) => (
                  <option key={s.storeCode} value={s.storeCode}>
                    {s.name ? `${s.storeCode} · ${s.name}` : `Store ${s.storeCode}`}
                  </option>
                ))}
              </NativeSelect>
              <label className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                <CalendarClock className="size-3.5" aria-hidden />
                Run date
                <input
                  type="date"
                  value={w.runDate}
                  onChange={(e) => e.target.value && go({asOf: e.target.value})}
                  className="h-8 rounded-md border border-border bg-background px-2 text-sm text-foreground tabular-nums outline-none transition-colors hover:border-foreground/25 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40"
                />
              </label>
              {data.preview && (
                <button type="button" onClick={() => go({asOf: null})} className="text-xs font-medium underline-offset-4 hover:underline">
                  Back to today
                </button>
              )}
            </div>
          </div>
          <Button variant="outline" size="sm" onClick={() => setSettingsOpen(true)} disabled={!data.canEditSettings} title={data.canEditSettings ? undefined : 'Company-wide admins set the window'}>
            <Settings2 className="size-4" /> Restock settings
          </Button>
        </div>
        <div className="h-0.5 w-24 rounded-full bg-gradient-to-r from-primary to-transparent" aria-hidden />
      </header>

      {!data.configured ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 px-6 py-12 text-center">
            <Info className="size-6 text-muted-foreground" aria-hidden />
            <h2 className="font-heading text-base font-semibold">Sales data isn&apos;t connected</h2>
            <p className="max-w-md text-sm text-muted-foreground">The restock reads last year&apos;s POS Sales Data from the Nichido database, which isn&apos;t set up in this environment.</p>
          </CardContent>
        </Card>
      ) : (
        <>
          {summary.missingMonths.length > 0 && (
            <div role="status" className="flex items-start gap-2.5 rounded-lg border border-[color-mix(in_oklab,var(--status-warn)_35%,transparent)] bg-[color-mix(in_oklab,var(--status-warn)_9%,transparent)] px-3.5 py-3 text-sm">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-[var(--status-warn)]" aria-hidden />
              <p>
                <span className="font-medium">Check data first: {list(summary.missingMonths.map((m) => monthLabel(m)))} POS Sales Data isn&apos;t loaded.</span>{' '}
                <span className="text-muted-foreground">
                  Every line in this run waits until the {summary.missingMonths.length === 1 ? 'file is' : 'files are'} uploaded. Ask Justin for{' '}
                  {summary.missingMonths.length === 1 ? 'it' : 'them'} (Q16).
                </span>
              </p>
            </div>
          )}

          <MonthStrip year={data.year} inWindow={inWindow} safety={safety} />

          <section aria-label="Summary" className={cn('grid grid-cols-2 gap-4 lg:grid-cols-4', GL_TILES_MOBILE)}>
            <Metric label="Ready" value={num(summary.ready)} sub={`of ${num(summary.lines)} store × product lines`} valueClassName={summary.ready ? 'text-[var(--status-good)]' : undefined} />
            <Metric label="Check data first" value={num(summary.held)} sub="held out of the restock" valueClassName={summary.held ? 'text-[var(--status-warn)]' : undefined} />
            <Metric label="Last year, ready lines" value={compact(summary.needUnits)} sub={`units sold in ${span(w.lastYear)}`} />
            <Metric label="Not linked" value={`${unlinkedPct}%`} sub={`${compact(summary.unlinkedUnits)} units on Watsons SKUs with no product`} valueClassName={unlinkedPct ? 'text-[var(--status-warn)]' : undefined} />
          </section>

          {summary.held > 0 && (
            <section aria-label="Why lines are held" className="-mt-2 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs">
              <span className="text-muted-foreground">Held because:</span>
              {HOLD_REASONS.filter((r) => summary.byReason[r]).map((r) => (
                <span key={r} title={HOLD_LABEL[r].hint} className="inline-flex items-center gap-1.5">
                  <ToneChip tone={HOLD_LABEL[r].tone}>{HOLD_LABEL[r].label}</ToneChip>
                  <span className="tabular-nums text-muted-foreground">{num(summary.byReason[r])}</span>
                </span>
              ))}
              <span className="text-muted-foreground">A line can have more than one reason.</span>
            </section>
          )}

          <Card className="py-0">
            <CardContent className="flex flex-col gap-3 px-0 pt-4 pb-3">
              <div className="flex flex-wrap items-center gap-2 px-4">
                <div className={GL_SCROLL_ROW_MOBILE}>
                  <SegmentedControl<Filter>
                    ariaLabel="Filter lines"
                    value={filter}
                    onChange={(v) => {
                      setFilter(v);
                      setPage(1);
                    }}
                    options={[
                      {value: 'all', label: `All ${num(counts.all)}`},
                      {value: 'ready', label: `Ready ${num(counts.ready)}`},
                      {value: 'held', label: `Check data first ${num(counts.held)}`},
                    ]}
                  />
                </div>
                {picked && !picked.inScope && <ToneChip tone={null}>Store out of scope</ToneChip>}
              </div>

              {total === 0 ? (
                <p className="px-4 py-10 text-center text-sm text-muted-foreground">
                  {data.stores.length === 0 ? `No sales in ${span(w.lastYear)} and no counts yet.` : 'Nothing matches this filter.'}
                </p>
              ) : store ? (
                <LineTable rows={slice(lineRows)} months={w.lastYear} safety={safety} />
              ) : (
                <StoreTable rows={slice(storeRows)} onPick={(code) => go({store: code})} />
              )}
              {pageCount > 1 && <Pagination page={at} pageCount={pageCount} onPage={setPage} className="px-4" />}
            </CardContent>
          </Card>
        </>
      )}

      {settingsOpen && <RestockSettingsDialog company={data.company} initial={settings} onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}

/** Last year's 12 months: loaded or missing, with the run's window and safety marked. */
function MonthStrip({year, inWindow, safety}: {year: ForecastData['year']; inWindow: Set<string>; safety: Set<string>}) {
  const max = Math.max(1, ...year.map((m) => m.units));
  return (
    <section aria-label="Last year's POS Sales Data by month" className="flex min-w-0 flex-col gap-2">
      <div className="overflow-x-auto pb-1">
        <ol className="grid min-w-[40rem] grid-cols-12 gap-1.5">
          {year.map((m) => {
            const win = inWindow.has(m.month);
            const linked = m.units - m.unlinkedUnits;
            return (
              <li
                key={m.month}
                title={m.loaded ? `${monthLabel(m.month)}: ${num(m.units)} units, ${num(m.unlinkedUnits)} on unlinked SKUs` : `${monthLabel(m.month)}: not loaded`}
                className={cn(
                  'flex flex-col gap-1.5 rounded-lg border px-2 pt-2 pb-1.5 transition-colors',
                  win ? 'border-primary/45 bg-[color-mix(in_oklab,var(--primary)_7%,transparent)]' : 'border-border/70',
                  !m.loaded && 'border-dashed border-[color-mix(in_oklab,var(--status-warn)_55%,transparent)] bg-[color-mix(in_oklab,var(--status-warn)_8%,transparent)]',
                )}
              >
                <div className="flex h-14 items-end" aria-hidden>
                  {m.loaded ? (
                    <div className="flex w-full flex-col justify-end overflow-hidden rounded-[3px]" style={{height: `${Math.max(6, (m.units / max) * 100)}%`}}>
                      <div className="bg-[color-mix(in_oklab,var(--primary)_28%,transparent)]" style={{flexGrow: m.unlinkedUnits}} />
                      <div className={win ? 'bg-primary' : 'bg-[color-mix(in_oklab,var(--primary)_55%,transparent)]'} style={{flexGrow: linked}} />
                    </div>
                  ) : (
                    <AlertTriangle className="mx-auto mb-3 size-4 text-[var(--status-warn)]" />
                  )}
                </div>
                <div className="flex flex-col leading-tight">
                  <span className={cn('text-xs', win ? 'font-semibold' : 'font-medium')}>{monthLabel(m.month, {month: 'short'})}</span>
                  <span className="text-[11px] text-muted-foreground tabular-nums">{m.loaded ? compact(m.units) : 'Missing'}</span>
                  <span className={cn('text-[11px] font-medium', safety.has(m.month) ? 'text-foreground' : 'invisible')} aria-hidden={!safety.has(m.month)}>
                    Safety
                  </span>
                </div>
              </li>
            );
          })}
        </ol>
      </div>
      <p className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <i className="inline-block size-2.5 rounded-[2px] bg-primary" aria-hidden /> In this run, linked SKUs
        </span>
        <span className="inline-flex items-center gap-1.5">
          <i className="inline-block size-2.5 rounded-[2px] bg-[color-mix(in_oklab,var(--primary)_28%,transparent)]" aria-hidden /> Unlinked SKUs (not forecast)
        </span>
        <span>{year[0] && `${monthLabel(year[0].month)} to ${monthLabel(year[year.length - 1].month)}`}</span>
      </p>
    </section>
  );
}

const TH = 'py-2 pr-3 font-medium';
const TD = 'py-2.5 pr-3';

function StoreTable({rows, onPick}: {rows: RestockViewData['stores']; onPick: (code: string) => void}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-y border-border bg-muted/40 text-left text-[11px] tracking-wide whitespace-nowrap text-muted-foreground uppercase">
            <th className={cn(TH, 'pl-4')}>Store</th>
            <th className={cn(TH, 'text-right')}>Lines</th>
            <th className={cn(TH, 'text-right')}>Ready</th>
            <th className={cn(TH, 'text-right')}>Check data first</th>
            <th className={cn(TH, 'pr-4 text-right')} title="Units sold last year in the window, on ready lines">
              Last year
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.storeCode} className="border-b border-border/60 transition-colors duration-150 last:border-b-0 hover:bg-muted/40">
              <td className={cn(TD, 'pl-4')}>
                <button type="button" onClick={() => onPick(r.storeCode)} className="text-left underline-offset-4 hover:underline focus-visible:underline focus-visible:outline-none">
                  <span className="font-medium">{r.name ?? `Store ${r.storeCode}`}</span> <span className="font-mono text-xs text-muted-foreground">{r.storeCode}</span>
                </button>
                {!r.inScope && (
                  <span className="ml-2">
                    <ToneChip tone={null}>Out of scope</ToneChip>
                  </span>
                )}
              </td>
              <td className={cn(TD, 'text-right tabular-nums')}>{num(r.lines)}</td>
              <td className={cn(TD, 'text-right tabular-nums')}>{num(r.ready)}</td>
              <td className={cn(TD, 'text-right tabular-nums', r.held && 'text-[var(--status-warn)]')}>{num(r.held)}</td>
              <td className={cn(TD, 'pr-4 text-right tabular-nums')}>{num(r.needUnits)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function LineTable({rows, months, safety}: {rows: RestockViewData['lines']; months: string[]; safety: Set<string>}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-y border-border bg-muted/40 text-left text-[11px] tracking-wide whitespace-nowrap text-muted-foreground uppercase">
            <th className={cn(TH, 'pl-4')}>Product</th>
            {months.map((m) => (
              <th key={m} className={cn(TH, 'text-right')} title={safety.has(m) ? 'Also the safety month' : undefined}>
                {monthLabel(m, {month: 'short', year: '2-digit'})}
              </th>
            ))}
            <th className={cn(TH, 'text-right')}>Need</th>
            <th className={cn(TH, 'text-right')}>Safety</th>
            <th className={cn(TH, 'pr-4')}>Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((l) => (
            <tr key={l.itemCode} className="border-b border-border/60 transition-colors duration-150 last:border-b-0 hover:bg-muted/40">
              <td className={cn(TD, 'pl-4')}>
                <span className="font-medium">{l.name}</span> <span className="font-mono text-xs text-muted-foreground">{l.itemCode}</span>
              </td>
              {l.units.map((u, i) => (
                <td key={months[i]} className={cn(TD, 'text-right tabular-nums', u == null && 'text-muted-foreground')}>
                  {u == null ? 'Missing' : num(u)}
                </td>
              ))}
              <td className={cn(TD, 'text-right font-medium tabular-nums')}>{l.need == null ? '·' : num(l.need)}</td>
              <td className={cn(TD, 'text-right tabular-nums')}>{l.safety == null ? '·' : num(l.safety)}</td>
              <td className={cn(TD, 'pr-4')}>
                {l.holds.length ? (
                  <span className="flex flex-wrap gap-1">
                    {l.holds.map((h) => (
                      <span key={h} title={HOLD_LABEL[h].hint}>
                        <ToneChip tone={HOLD_LABEL[h].tone}>{HOLD_LABEL[h].label}</ToneChip>
                      </span>
                    ))}
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-xs font-medium text-[var(--status-good)]">
                    <CheckCircle2 className="size-3.5" aria-hidden /> Ready
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const FIELD =
  'h-9 w-full rounded-md border border-border bg-background px-2.5 text-sm tabular-nums outline-none transition-colors hover:border-foreground/25 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40 disabled:opacity-60';

function RestockSettingsDialog({company, initial, onClose}: {company: string | null; initial: ForecastData['settings']; onClose: () => void}) {
  const router = useRouter();
  const [windowMonths, setWindow] = useState(String(initial.windowMonths));
  const [safetyMonths, setSafety] = useState(String(initial.safetyMonths));
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const wn = Number(windowMonths);
  const sn = Number(safetyMonths);
  const valid = Number.isInteger(wn) && wn >= 1 && wn <= MAX_WINDOW_MONTHS && Number.isInteger(sn) && sn >= 0 && sn <= wn;
  const changed = wn !== initial.windowMonths || sn !== initial.safetyMonths;

  return (
    <Modal open onClose={onClose} title="Restock settings" description="How far ahead each run plans, from each store's own sales in last year's same months.">
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!valid) return;
          setError(null);
          start(async () => {
            const res = await saveForecastSettingsAction({company, windowMonths: wn, safetyMonths: sn});
            if (!res.ok) return setError(res.error);
            router.refresh();
            onClose();
          });
        }}
      >
        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium">Months to cover</span>
            <input id="forecast-window" type="number" inputMode="numeric" min={1} max={MAX_WINDOW_MONTHS} value={windowMonths} onChange={(e) => setWindow(e.target.value)} className={FIELD} disabled={pending} />
            <span className="text-xs text-muted-foreground">Starting the month after the run.</span>
          </label>
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium">Safety months</span>
            <input id="forecast-safety" type="number" inputMode="numeric" min={0} max={wn || MAX_WINDOW_MONTHS} value={safetyMonths} onChange={(e) => setSafety(e.target.value)} className={FIELD} disabled={pending} />
            <span className="text-xs text-muted-foreground">Last year&apos;s final months of the window.</span>
          </label>
        </div>
        {!valid && <p className="text-sm text-destructive">Cover 1 to {MAX_WINDOW_MONTHS} months; safety can&apos;t be longer than that.</p>}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" disabled={pending || !valid || !changed}>
            {pending && <Loader2 className="size-4 animate-spin" />}
            Save
          </Button>
        </div>
      </form>
    </Modal>
  );
}
