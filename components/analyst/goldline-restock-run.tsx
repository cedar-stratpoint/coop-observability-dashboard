'use client';

// Goldline Restock · the run (F11). Each line: last year's window, the store's stock on
// hand and on the way, safety, and the units Coop suggests sending, with the working shown.
// The owner approves lines as is (many at once), or edits or rejects one with a remark.
// Score per store = approved as is ÷ decided. All stores = every line with something to
// send; one store = all of its lines, covered and held included.

import {Fragment, useMemo, useState, useTransition} from 'react';
import Link from 'next/link';
import {usePathname, useRouter} from 'next/navigation';
import {AlertTriangle, CalendarClock, ChartColumn, Check, ChevronDown, ChevronRight, ClipboardList, Info, Loader2, PackageCheck, Pencil, RotateCcw, X} from 'lucide-react';
import type {RestockRunData, RunLine} from '@/src/goldline-restock-data';
import type {Decision} from '@/src/goldline-restock';
import {restockItemHref} from '@/src/goldline-restock-item';
import {metricValueClass} from '@/components/analyst/metric';
import {SegmentedControl} from '@/components/analyst/segmented-control';
import {Pagination} from '@/components/analyst/pagination';
import {useListParams, useReturnTrip} from '@/components/analyst/back-nav';
import {NativeSelect} from '@/components/ui/native-select';
import {Card, CardContent} from '@/components/ui/card';
import {Button} from '@/components/ui/button';
import {fmtDay, ToneChip} from '@/components/analyst/goldline-ops-shared';
import {Modal} from '@/components/analyst/goldline-supply-dialogs';
import {HOLD_LABEL, monthLabel, num, span} from '@/components/analyst/goldline-restock-inputs';
import {decideRecommendationsAction, makePurchaseOrdersAction, makeRestockRunAction} from '@/app/stock/actions';
import {cn} from '@/lib/utils';
import {GL_SCROLL_ROW_MOBILE, titleName} from '@/src/goldline-ui';

export type RestockRunViewData = RestockRunData & {
  company: string | null;
  runDate: string;
  today: string;
  preview: boolean;
  canDecide: boolean;
  canMakeRun: boolean;
  nav: React.ReactNode;
};

type Filter = 'to_decide' | 'decided' | 'send' | 'covered' | 'held' | 'all';
const FILTER_KEYS: Record<Filter, true> = {to_decide: true, decided: true, send: true, covered: true, held: true, all: true};
const PAGE_SIZE = 25;

const DECISION: Record<Exclude<Decision, 'pending'>, {label: string; tone: string | null}> = {
  approved: {label: 'Approved', tone: 'var(--status-good)'},
  edited: {label: 'Edited', tone: 'var(--status-warn)'},
  rejected: {label: 'Rejected', tone: 'var(--status-crit)'},
};
const pct = (x: number | null) => (x == null ? 'None yet' : `${Math.round(x * 100)}%`);
const half = (cycle: string) => `${cycle.endsWith('a') ? 'first' : 'second'} half of ${monthLabel(cycle.slice(0, 7), {month: 'long'})}`;
const stamp = (iso: string) => new Date(iso).toLocaleString('en-US', {month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Manila'});

// Filter + page live in the URL (replaceState) so a line's year-of-sales page returns here as
// you left it. `show` is blank for the scope's own default (All for one store, To decide for all).
const RUN_LIST = {show: '', page: '1'};

export function GoldlineRestockRun({data}: {data: RestockRunViewData}) {
  const router = useRouter();
  const pathname = usePathname();
  const {run, store} = data;
  const [lp, setLp] = useListParams(RUN_LIST);
  const {leave} = useReturnTrip('restock');
  const filter: Filter = (Object.hasOwn(FILTER_KEYS, lp.show) ? lp.show : store ? 'all' : 'to_decide') as Filter;
  const page = Math.max(1, Number.parseInt(lp.page, 10) || 1);
  const setPage = (n: number) => setLp({page: String(n)});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [dialog, setDialog] = useState<{line: RunLine; kind: 'edited' | 'rejected'} | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const go = (next: {store?: string | null; asOf?: string | null}) => {
    const q = new URLSearchParams();
    const s = next.store === undefined ? store : next.store;
    const a = next.asOf === undefined ? (data.preview ? data.runDate : null) : next.asOf;
    if (s) q.set('store', s);
    if (a && a !== data.today) q.set('asOf', a);
    setSelected(new Set());
    // A store or preview date is a filter on this page, not a step: replace keeps Back meaning
    // "leave Restock". The new URL has no show/page, so the list resets to the scope's default.
    router.replace(q.size ? `${pathname}?${q}` : pathname, {scroll: false});
  };

  const counts = useMemo(() => {
    const c: Record<Filter, number> = {to_decide: 0, decided: 0, send: 0, covered: 0, held: 0, all: data.lines.length};
    for (const l of data.lines) {
      c[l.state]++;
      if (l.state === 'send') c[l.decision === 'pending' ? 'to_decide' : 'decided']++;
    }
    return c;
  }, [data.lines]);
  const rows = useMemo(
    () =>
      data.lines.filter((l) =>
        filter === 'all' ? true : filter === 'to_decide' ? l.state === 'send' && l.decision === 'pending' : filter === 'decided' ? l.state === 'send' && l.decision !== 'pending' : l.state === filter,
      ),
    [data.lines, filter],
  );
  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const at = Math.min(page, pageCount);
  const pageRows = rows.slice((at - 1) * PAGE_SIZE, at * PAGE_SIZE);
  const selectable = pageRows.filter((l) => l.state === 'send' && l.decision === 'pending');
  const allOnPage = selectable.length > 0 && selectable.every((l) => selected.has(l.id));
  const sendUnits = data.stores.reduce((a, s) => a + s.sendUnits, 0);
  const skipped = run?.skipped;

  const decide = (ids: string[], decision: Decision, extra: {qty?: number; remark?: string} = {}, done?: () => void) => {
    setError(null);
    setNotice(null);
    start(async () => {
      const res = await decideRecommendationsAction({company: data.company, ids, decision, ...extra});
      if (!res.ok) return setError(res.error);
      setSelected(new Set());
      setNotice(decision === 'approved' ? `Approved ${num(res.changed)} ${res.changed === 1 ? 'line' : 'lines'}.` : decision === 'pending' ? 'Decision undone.' : 'Saved.');
      done?.();
      router.refresh();
    });
  };
  const makeRun = () => {
    setError(null);
    setNotice(null);
    start(async () => {
      const res = await makeRestockRunAction({company: data.company, runDate: data.runDate});
      if (!res.ok) return setError(res.error);
      setNotice(`Run saved: ${num(res.saved)} lines from stores with a counted form.`);
      router.refresh();
    });
  };
  const makeOrders = () => {
    if (!run) return;
    setError(null);
    setNotice(null);
    start(async () => {
      const res = await makePurchaseOrdersAction({company: data.company, runId: run.id});
      if (!res.ok) return setError(res.error);
      setNotice(
        res.lines
          ? `Shipped ${num(res.lines)} ${res.lines === 1 ? 'line' : 'lines'} on purchase orders${res.pos ? ` (${num(res.pos)} new ${res.pos === 1 ? 'PO' : 'POs'})` : ''}. Fill in the received section on Orders when stock arrives.`
          : 'Every approved line is already on a purchase order.',
      );
      router.refresh();
    });
  };
  const toggle = (set: Set<string>, id: string) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  };

  const madeBy = run?.updatedBy ? run.updatedBy.split('@')[0] : null;
  const notInRun = skipped
    ? [
        skipped.no_count.stores > 0 && `${num(skipped.no_count.stores)} waiting on a form`,
        skipped.out_of_scope.stores > 0 && `${num(skipped.out_of_scope.stores)} paused`,
      ].filter(Boolean).join(' · ')
    : '';
  const notInRunTitle = skipped
    ? `Not in this run: ${num(skipped.no_count.stores)} ${skipped.no_count.stores === 1 ? 'store' : 'stores'} with no counted form yet (${num(skipped.no_count.lines)} lines), ${num(skipped.out_of_scope.stores)} paused (${num(skipped.out_of_scope.lines)} lines).`
    : undefined;

  return (
    <div className={PAGE}>
      <header className="flex flex-col gap-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-baseline gap-3">
            <h1 className="font-heading text-3xl font-semibold tracking-tight">Restock</h1>
            <Link href="/stock" className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
              Inventory
            </Link>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {run && data.canDecide && data.toOrder.lines > 0 && (
              <Button onClick={makeOrders} disabled={pending} title="Puts approved lines on each store's purchase order and ships them from the warehouse.">
                <ClipboardList className="size-4" /> Make purchase orders
                <span className="text-primary-foreground/75 tabular-nums">
                  {num(data.toOrder.lines)} {data.toOrder.lines === 1 ? 'line' : 'lines'} · {num(data.toOrder.stores)} {data.toOrder.stores === 1 ? 'store' : 'stores'}
                </span>
              </Button>
            )}
            <Button
              variant={run ? 'outline' : 'default'}
              onClick={makeRun}
              disabled={pending || !data.canMakeRun || !data.configured}
              title={data.canMakeRun ? 'Works out every line again. Decided lines keep their numbers.' : 'Company-wide admins make the run'}
            >
              {pending ? <Loader2 className="size-4 animate-spin" /> : <PackageCheck className="size-4" />} {run ? 'Make run again' : 'Make run'}
            </Button>
          </div>
        </div>
        {data.nav}
        <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
          <div className="flex min-w-0 flex-col gap-1.5 text-sm">
            {run ? (
              <>
                <p className="text-pretty">
                  <span className="font-medium">Covers {span(run.months)}</span>
                  <span className="text-muted-foreground">
                    {' '}
                    · {cap(half(run.cycle))} run, from last year&apos;s {span(run.lastYear)}
                  </span>
                </p>
                <p className="text-xs text-muted-foreground">
                  Made {stamp(run.updatedAt)}
                  {madeBy && (
                    <>
                      {' '}
                      by <span title={run.updatedBy ?? undefined}>{madeBy}</span>
                    </>
                  )}
                  , for {fmtDay(run.runDate)}
                </p>
              </>
            ) : (
              <p className="max-w-[60ch] text-muted-foreground text-pretty">No run for the {half(data.cycle)} yet.</p>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            {run && (
              <NativeSelect aria-label="Store" value={store ?? ''} onChange={(e) => go({store: e.target.value || null})}>
                <option value="">All stores ({data.stores.length})</option>
                {data.stores.map((s) => (
                  <option key={s.storeCode} value={s.storeCode}>
                    {s.name ? `${s.storeCode} · ${titleName(s.name)}` : `Store ${s.storeCode}`}
                  </option>
                ))}
              </NativeSelect>
            )}
            <label className="inline-flex items-center gap-2 text-xs text-muted-foreground">
              <CalendarClock className="size-3.5" aria-hidden />
              Run date
              <input
                id="restock-run-date"
                type="date"
                value={data.runDate}
                onChange={(e) => e.target.value && go({asOf: e.target.value})}
                className="h-8 rounded-lg border border-border bg-background px-2.5 text-sm text-foreground tabular-nums outline-none transition-colors hover:border-foreground/25 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40"
              />
            </label>
            {data.preview && (
              <button type="button" onClick={() => go({asOf: null})} className="text-xs font-medium underline-offset-4 hover:underline">
                Back to today
              </button>
            )}
          </div>
        </div>
      </header>

      {(error || notice) && (
        <p role={error ? 'alert' : 'status'} className={cn('-mt-2 text-sm', error ? 'text-destructive' : 'text-muted-foreground')}>
          {error ?? notice}
        </p>
      )}

      {!data.configured ? (
        <EmptyCard icon={Info} title="Sales data isn't connected">
          The restock reads the Nichido database, which isn&apos;t set up in this environment.
        </EmptyCard>
      ) : !run ? (
        <EmptyCard icon={PackageCheck} title="Make the run after each form">
          Coop checks whether each store has enough for the coming months plus safety stock, and suggests what to send. Lines that need a check first are on the Inputs tab.
        </EmptyCard>
      ) : (
        <>
          {data.warehouseSample && <Banner>Warehouse stock is still sample data, so the cap on suggestions isn&apos;t real yet. Enter real counts on the Inventory board.</Banner>}

          <Card className="py-0">
            <dl className="grid grid-cols-2 lg:grid-cols-4">
              <Stat i={0} label="To decide" value={num(data.toDecide)} sub="lines to review" valueClassName={data.toDecide ? 'text-[var(--status-warn)]' : undefined} />
              <Stat i={1} label="Units to send" value={num(sendUnits)} sub="across every store" />
              <Stat
                i={2}
                label="Hit rate"
                value={pct(data.score)}
                sub={
                  <>
                    approved as is ·{' '}
                    <Link href="/stock/restock?tab=hits" className="underline underline-offset-4 hover:text-foreground">
                      Hit or miss
                    </Link>
                  </>
                }
              />
              <Stat i={3} label="Stores" value={num(data.stores.length)} sub={notInRun ? <span title={notInRunTitle}>{notInRun}</span> : 'with a counted form'} />
            </dl>
          </Card>

          <Card className="py-0">
            <CardContent className="flex flex-col gap-0 px-0 pt-0 pb-0">
              <div className="flex flex-wrap items-center justify-between gap-3 px-6 pt-5 pb-4">
                <div className={GL_SCROLL_ROW_MOBILE}>
                  <SegmentedControl<Filter>
                    ariaLabel="Filter lines"
                    value={filter}
                    onChange={(v) => setLp({show: v === (store ? 'all' : 'to_decide') ? '' : v, page: '1'})}
                    options={[
                      {value: 'to_decide', label: `To decide ${num(counts.to_decide)}`},
                      {value: 'decided', label: `Decided ${num(counts.decided)}`},
                      ...(store
                        ? ([
                            {value: 'covered', label: `Covered ${num(counts.covered)}`},
                            {value: 'held', label: `Check data first ${num(counts.held)}`},
                          ] as const)
                        : []),
                      {value: 'all', label: `All ${num(counts.all)}`},
                    ]}
                  />
                </div>
                {data.canDecide && (
                  <Button onClick={() => decide([...selected], 'approved')} disabled={pending || !selected.size}>
                    <Check className="size-4" /> Approve {selected.size ? `${num(selected.size)} selected` : 'selected'}
                  </Button>
                )}
              </div>

              {rows.length === 0 ? (
                <p className="px-6 pt-8 pb-14 text-center text-sm text-muted-foreground">
                  {filter === 'to_decide' && counts.decided ? 'Every line is decided.' : data.lines.length ? 'Nothing matches this filter.' : 'Every store in this run is covered.'}
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full border-collapse text-sm">
                    <thead>
                      <tr className={THEAD}>
                        <th className={cn(TH, 'w-10 pl-6')}>
                          {data.canDecide && selectable.length > 0 && (
                            <input
                              type="checkbox"
                              aria-label="Select every line on this page"
                              checked={allOnPage}
                              onChange={() =>
                                setSelected((s) => {
                                  const next = new Set(s);
                                  for (const l of selectable) {
                                    if (allOnPage) next.delete(l.id);
                                    else next.add(l.id);
                                  }
                                  return next;
                                })
                              }
                              className="size-3.5 accent-[var(--primary)]"
                            />
                          )}
                        </th>
                        {!store && <th className={TH}>Store</th>}
                        <th className={cn(TH, 'min-w-[16rem]')}>Product</th>
                        <th className={cn(TH, 'text-right')}>Last year {run.lastYear.map((m) => monthLabel(m, {month: 'short'})).join(' · ')}</th>
                        <th className={cn(TH, 'text-right')}>On hand</th>
                        <th className={cn(TH, 'text-right')}>Safety</th>
                        <th className={cn(TH, 'text-right')}>Send</th>
                        <th className={cn(TH, 'pr-6')}>Decision</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pageRows.map((l) => {
                        const isOpen = open.has(l.id);
                        const canPick = data.canDecide && l.state === 'send' && l.decision === 'pending';
                        return (
                          <Fragment key={l.id}>
                            <tr data-kept-id={l.id} className={cn('border-b border-border/50 transition-colors duration-150 hover:bg-muted/35', selected.has(l.id) && 'bg-primary/[0.06] hover:bg-primary/[0.09]')}>
                              <td className={cn(TD, 'pl-6')}>
                                {canPick && (
                                  <input
                                    type="checkbox"
                                    aria-label={`Select ${l.name} at ${l.storeName ?? l.storeCode}`}
                                    checked={selected.has(l.id)}
                                    onChange={() => setSelected((s) => toggle(s, l.id))}
                                    className="size-3.5 accent-[var(--primary)]"
                                  />
                                )}
                              </td>
                              {!store && (
                                <td className={TD}>
                                  <button type="button" onClick={() => go({store: l.storeCode})} className="text-left underline-offset-4 hover:underline focus-visible:underline focus-visible:outline-none">
                                    {l.storeName ? titleName(l.storeName) : `Store ${l.storeCode}`}
                                  </button>
                                </td>
                              )}
                              <td className={TD}>
                                <button
                                  type="button"
                                  onClick={() => setOpen((s) => toggle(s, l.id))}
                                  aria-expanded={isOpen}
                                  className="inline-flex items-start gap-1 text-left underline-offset-4 hover:underline focus-visible:underline focus-visible:outline-none"
                                >
                                  {isOpen ? <ChevronDown className="mt-0.5 size-3.5 shrink-0" aria-hidden /> : <ChevronRight className="mt-0.5 size-3.5 shrink-0" aria-hidden />}
                                  <span>
                                    <span className="font-medium">{l.name}</span> <span className="ml-1 font-mono text-[11px] tracking-wide text-muted-foreground">{l.itemCode}</span>
                                  </span>
                                </button>
                                <Link
                                  data-row
                                  href={restockItemHref(l.itemCode, l.storeCode, data.preview ? data.runDate : null)}
                                  onClick={() => leave(l.id, restockItemHref(l.itemCode, l.storeCode, data.preview ? data.runDate : null))}
                                  aria-label={`${l.name}: a year of sales`}
                                  title="A year of sales"
                                  className="ml-1.5 inline-flex rounded p-0.5 align-[-3px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                                >
                                  <ChartColumn className="size-3.5" aria-hidden />
                                </Link>
                              </td>
                              <td className={cn(TD, 'text-right whitespace-nowrap tabular-nums')}>
                                <span className="text-muted-foreground">{l.lyUnits.map((u) => (u == null ? '?' : num(u))).join(' · ')} =</span> {l.need == null ? '·' : num(l.need)}
                              </td>
                              <td className={cn(TD, 'text-right whitespace-nowrap tabular-nums')}>
                                {l.onHand == null ? <span className="text-muted-foreground">Blank</span> : num(l.onHand)}
                                {l.onTheWay > 0 && <span className="text-muted-foreground"> + {num(l.onTheWay)}</span>}
                              </td>
                              <td className={cn(TD, 'text-right tabular-nums')}>{l.safety == null ? '·' : num(l.safety)}</td>
                              <td className={cn(TD, 'text-right whitespace-nowrap tabular-nums')}>
                                {l.state === 'held' ? (
                                  <span className="text-muted-foreground">·</span>
                                ) : l.decision === 'edited' || l.decision === 'rejected' ? (
                                  <>
                                    <span className="font-semibold">{num(l.finalQty ?? 0)}</span> <span className="text-xs text-muted-foreground line-through">{num(l.suggested ?? 0)}</span>
                                  </>
                                ) : (
                                  <span className={cn(l.state === 'send' && 'font-semibold')}>{num(l.suggested ?? 0)}</span>
                                )}
                              </td>
                              <td className={cn(TD, 'pr-6')}>
                                <DecisionCell line={l} canDecide={data.canDecide} pending={pending} onApprove={() => decide([l.id], 'approved')} onUndo={() => decide([l.id], 'pending')} onDialog={(kind) => setDialog({line: l, kind})} />
                              </td>
                            </tr>
                            {isOpen && (
                              <tr className="border-b border-border/50 bg-muted/25">
                                <td />
                                <td colSpan={store ? 6 : 7} className="py-3.5 pr-6 text-xs leading-relaxed text-muted-foreground">
                                  <Working line={l} months={run.months} lastYear={run.lastYear} />
                                </td>
                              </tr>
                            )}
                          </Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
              {pageCount > 1 && <Pagination page={at} pageCount={pageCount} onPage={setPage} className="px-6 py-4" />}
            </CardContent>
          </Card>

          {!store && data.stores.length > 0 && <ScoreTable rows={data.stores} onPick={(code) => go({store: code})} />}
        </>
      )}

      {dialog && (
        <DecideDialog
          line={dialog.line}
          kind={dialog.kind}
          pending={pending}
          onClose={() => setDialog(null)}
          onSave={(qty, remark) => decide([dialog.line.id], dialog.kind, dialog.kind === 'edited' ? {qty, remark} : {remark}, () => setDialog(null))}
          error={error}
        />
      )}
    </div>
  );
}

const PAGE = 'mx-auto flex w-full max-w-7xl min-w-0 flex-col gap-8 px-4 py-8 sm:px-6 lg:px-10 lg:py-10 *:min-w-0';
const THEAD = 'border-b border-border/70 text-left text-[11px] tracking-wide whitespace-nowrap text-muted-foreground uppercase';
const TH = 'py-3 pr-4 font-medium';
const TD = 'py-3.5 pr-4 align-middle';
const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

/** One cell of the summary strip. Hairlines between cells, not a card per number. */
function Stat({i, label, value, sub, valueClassName}: {i: number; label: string; value: string; sub: React.ReactNode; valueClassName?: string}) {
  return (
    <div
      className={cn(
        'flex flex-col gap-2 border-border/60 px-6 py-5',
        i % 2 === 0 && 'border-r',
        i < 2 && 'border-b lg:border-b-0',
        i === 1 && 'lg:border-r',
        i === 3 && 'lg:border-r-0',
      )}
    >
      <dt className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{label}</dt>
      <dd className={cn(metricValueClass, 'text-3xl', valueClassName)}>{value}</dd>
      <dd className="text-xs text-muted-foreground">{sub}</dd>
    </div>
  );
}

function EmptyCard({icon: Icon, title, children}: {icon: React.ComponentType<{className?: string}>; title: string; children: React.ReactNode}) {
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-4 px-6 py-16 text-center">
        <span className="flex size-12 items-center justify-center rounded-2xl bg-muted ring-1 ring-foreground/5">
          <Icon className="size-5 text-muted-foreground" aria-hidden />
        </span>
        <h2 className="font-heading text-xl font-semibold tracking-tight">{title}</h2>
        <p className="max-w-md text-sm text-muted-foreground text-pretty">{children}</p>
      </CardContent>
    </Card>
  );
}

function Banner({children}: {children: React.ReactNode}) {
  return (
    <div role="status" className="flex items-start gap-3 rounded-xl border border-[color-mix(in_oklab,var(--status-warn)_28%,transparent)] bg-[color-mix(in_oklab,var(--status-warn)_7%,transparent)] px-4 py-3 text-sm text-[color-mix(in_oklab,var(--status-warn)_30%,var(--foreground))]">
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-[var(--status-warn)]" aria-hidden />
      <p>{children}</p>
    </div>
  );
}

function DecisionCell({
  line: l,
  canDecide,
  pending,
  onApprove,
  onUndo,
  onDialog,
}: {
  line: RunLine;
  canDecide: boolean;
  pending: boolean;
  onApprove: () => void;
  onUndo: () => void;
  onDialog: (kind: 'edited' | 'rejected') => void;
}) {
  if (l.state === 'held') {
    return (
      <span className="flex flex-wrap items-center gap-1">
        <ToneChip tone="var(--status-warn)">Check data first</ToneChip>
        {l.holds.map((h) => (
          <span key={h} title={HOLD_LABEL[h].hint} className="text-xs text-muted-foreground">
            {HOLD_LABEL[h].label}
          </span>
        ))}
      </span>
    );
  }
  if (l.state === 'covered') {
    return (
      <span className="flex flex-wrap items-center gap-1.5">
        {/* Capped to 0: the store needs some, but the warehouse has none left (not covered). */}
        {l.warehouseShort ? <ToneChip tone="var(--status-warn)">Warehouse short</ToneChip> : <ToneChip tone={null}>Covered</ToneChip>}
        {l.warehouseShort ? <span className="text-xs text-muted-foreground">Warehouse has none to spare</span> : <span className="text-xs text-muted-foreground">Nothing to send</span>}
      </span>
    );
  }
  if (l.decision !== 'pending') {
    const d = DECISION[l.decision];
    // A line on a PO has shipped. Changing it takes it back off (its shipment is cancelled)
    // until the stock is received or due to have arrived (F12).
    const locked = l.po?.locked ?? false;
    return (
      <span className="flex flex-col gap-1">
        <span className="flex flex-wrap items-center gap-1.5">
          <ToneChip tone={d.tone}>{d.label}</ToneChip>
          {l.po && (
            <Link
              href={`/stock/orders/${l.po.id}`}
              title={l.po.locked ? 'Shipped on this PO and received or due' : 'Shipped on this PO. Undo takes it back off and returns the stock.'}
              className="font-mono text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
            >
              {l.po.number}
            </Link>
          )}
          {canDecide && !locked && (
            <button type="button" onClick={onUndo} disabled={pending} className="inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline disabled:opacity-50">
              <RotateCcw className="size-3" aria-hidden /> Undo
            </button>
          )}
        </span>
        {l.remark && <span className="max-w-[28ch] text-xs text-muted-foreground text-pretty">&ldquo;{l.remark}&rdquo;</span>}
      </span>
    );
  }
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      {l.warehouseShort && (
        <span title={`Coop's number before the cap was ${num(l.rawSend ?? 0)}`}>
          <ToneChip tone="var(--status-warn)">Warehouse short</ToneChip>
        </span>
      )}
      {canDecide ? (
        <>
          <Button size="sm" variant="outline" onClick={onApprove} disabled={pending}>
            <Check className="size-3.5" /> Approve
          </Button>
          <Button size="icon-sm" variant="ghost" onClick={() => onDialog('edited')} disabled={pending} aria-label={`Edit the number for ${l.name}`} title="Edit the number" className="text-muted-foreground">
            <Pencil className="size-3.5" />
          </Button>
          <Button size="icon-sm" variant="ghost" onClick={() => onDialog('rejected')} disabled={pending} aria-label={`Reject ${l.name}`} title="Reject" className="text-muted-foreground hover:text-[var(--status-crit)]">
            <X className="size-3.5" />
          </Button>
        </>
      ) : (
        <span className="text-xs text-muted-foreground">Waiting for a decision</span>
      )}
    </span>
  );
}

/** "Why 53": the line's working, in the meeting's words. */
function Working({line: l, months, lastYear}: {line: RunLine; months: string[]; lastYear: string[]}) {
  if (l.state === 'held') return <>Coop gives no number until this is cleared: {l.holds.map((h) => HOLD_LABEL[h].hint.toLowerCase()).join('; ')}.</>;
  const need = l.need ?? 0;
  const safety = l.safety ?? 0;
  const have = Math.max(0, l.onHand ?? 0) + l.onTheWay;
  const parts = lastYear.map((m, i) => `${monthLabel(m, {month: 'short'})} ${num(l.lyUnits[i] ?? 0)}`).join(' + ');
  const haveText = `${num(l.onHand ?? 0)} on hand (${fmtDay(l.onHandPeriodEnd)} form)${(l.onHand ?? 0) < 0 ? ', counted as 0' : ''}`;
  return (
    <span className="tabular-nums">
      Covers {span(months)}: last year {parts} = {num(need)}. Minus {haveText}
      {l.onTheWay ? ` and ${num(l.onTheWay)} on the way` : ''} = {num(need - have)}. Plus safety stock ({num(safety)}) ={' '}
      <span className="font-medium text-foreground">{num(Math.max(0, need - have + safety))}</span>
      {need - have + safety <= 0 && ', so the store is good for the window'}.
      {l.warehouseShort && ` The warehouse can't cover every store, so this store's share is ${num(l.suggested ?? 0)}.`}
      {l.decidedBy && ` Decided by ${l.decidedBy}${l.decidedAt ? ` on ${stamp(l.decidedAt)}` : ''}.`}
    </span>
  );
}

function ScoreTable({rows, onPick}: {rows: RestockRunData['stores']; onPick: (code: string) => void}) {
  return (
    <section aria-label="Score by store" className="flex flex-col gap-4 pt-2">
      <h2 className="font-heading text-lg font-semibold">By store</h2>
      <Card className="py-0">
        <CardContent className="px-0 py-0">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className={THEAD}>
                  <th className={cn(TH, 'pl-6')}>Store</th>
                  <th className={cn(TH, 'text-right')}>To send</th>
                  <th className={cn(TH, 'text-right')}>Covered</th>
                  <th className={cn(TH, 'text-right')}>Check data first</th>
                  <th className={cn(TH, 'text-right')}>To decide</th>
                  <th className={cn(TH, 'text-right')}>Units</th>
                  <th className={cn(TH, 'pr-6 text-right')} title="Approved as is ÷ decided">
                    Approved as is
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.storeCode} className="border-b border-border/50 transition-colors duration-150 last:border-b-0 hover:bg-muted/35">
                    <td className={cn(TD, 'pl-6')}>
                      <button type="button" onClick={() => onPick(r.storeCode)} className="text-left underline-offset-4 hover:underline focus-visible:underline focus-visible:outline-none">
                        <span className="font-medium">{r.name ? titleName(r.name) : `Store ${r.storeCode}`}</span> <span className="ml-1 font-mono text-[11px] text-muted-foreground">{r.storeCode}</span>
                      </button>
                    </td>
                    <td className={cn(TD, 'text-right tabular-nums')}>{num(r.send)}</td>
                    <td className={cn(TD, 'text-right tabular-nums')}>{num(r.covered)}</td>
                    <td className={cn(TD, 'text-right tabular-nums', r.held && 'text-[var(--status-warn)]')}>{num(r.held)}</td>
                    <td className={cn(TD, 'text-right tabular-nums')}>{num(r.pending)}</td>
                    <td className={cn(TD, 'text-right tabular-nums')}>{num(r.sendUnits)}</td>
                    <td className={cn(TD, 'pr-6 text-right tabular-nums')}>{r.score == null ? <span className="text-muted-foreground">·</span> : `${Math.round(r.score * 100)}%`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </section>
  );
}

const FIELD =
  'h-9 w-full rounded-md border border-border bg-background px-2.5 text-sm tabular-nums outline-none transition-colors hover:border-foreground/25 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40 disabled:opacity-60';

function DecideDialog({
  line: l,
  kind,
  pending,
  error,
  onClose,
  onSave,
}: {
  line: RunLine;
  kind: 'edited' | 'rejected';
  pending: boolean;
  error: string | null;
  onClose: () => void;
  onSave: (qty: number, remark: string) => void;
}) {
  const [qty, setQty] = useState(String(l.suggested ?? 0));
  const [remark, setRemark] = useState('');
  const n = Number(qty);
  const validQty = kind === 'rejected' || (qty.trim() !== '' && Number.isInteger(n) && n >= 0);
  const valid = validQty && remark.trim().length > 0;
  const where = `${l.name} at ${l.storeName ?? `store ${l.storeCode}`}`;

  return (
    <Modal open onClose={onClose} title={kind === 'edited' ? 'Edit the number' : 'Reject this line'} description={`${where}. Coop suggested ${num(l.suggested ?? 0)}. Your remark is kept so Coop can learn from it later.`}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) onSave(n, remark.trim());
        }}
      >
        {kind === 'edited' && (
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium">Units to send</span>
            <input id="restock-edit-qty" type="number" inputMode="numeric" min={0} value={qty} onChange={(e) => setQty(e.target.value)} className={FIELD} disabled={pending} autoFocus />
          </label>
        )}
        <label className="flex flex-col gap-1.5 text-sm">
          <span className="font-medium">Remark</span>
          <textarea
            id="restock-remark"
            rows={3}
            maxLength={500}
            value={remark}
            onChange={(e) => setRemark(e.target.value)}
            placeholder={kind === 'edited' ? 'Mall sale in December, send more' : 'Store is closing for renovation'}
            className={cn(FIELD, 'h-auto py-2')}
            disabled={pending}
            autoFocus={kind === 'rejected'}
          />
        </label>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" disabled={pending || !valid}>
            {pending && <Loader2 className="size-4 animate-spin" />}
            {kind === 'edited' ? 'Save' : 'Reject'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
