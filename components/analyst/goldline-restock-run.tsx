'use client';

// Goldline Restock · the run (F11). Each line: last year's window, the store's stock on
// hand and on the way, safety, and the units Coop suggests sending, with the working shown.
// The owner approves lines as is (many at once), or edits or rejects one with a remark.
// Score per store = approved as is ÷ decided. All stores = every line with something to
// send; one store = all of its lines, covered and held included.

import {Fragment, useMemo, useState, useTransition} from 'react';
import Link from 'next/link';
import {usePathname, useRouter} from 'next/navigation';
import {AlertTriangle, CalendarClock, ChartColumn, Check, ChevronDown, ChevronRight, Info, Loader2, PackageCheck, Pencil, RotateCcw, X} from 'lucide-react';
import type {RestockRunData, RunLine} from '@/src/goldline-restock-data';
import type {Decision} from '@/src/goldline-restock';
import {restockItemHref} from '@/src/goldline-restock-item';
import {Metric} from '@/components/analyst/metric';
import {SegmentedControl} from '@/components/analyst/segmented-control';
import {Pagination} from '@/components/analyst/pagination';
import {NativeSelect} from '@/components/ui/native-select';
import {Card, CardContent} from '@/components/ui/card';
import {Button} from '@/components/ui/button';
import {fmtDay, ToneChip} from '@/components/analyst/goldline-ops-shared';
import {Modal} from '@/components/analyst/goldline-supply-dialogs';
import {HOLD_LABEL, monthLabel, num, span} from '@/components/analyst/goldline-restock-inputs';
import {decideRecommendationsAction, makeRestockRunAction} from '@/app/stock/actions';
import {cn} from '@/lib/utils';
import {GL_SCROLL_ROW_MOBILE, GL_TILES_MOBILE} from '@/src/goldline-ui';

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
const PAGE_SIZE = 25;

const DECISION: Record<Exclude<Decision, 'pending'>, {label: string; tone: string | null}> = {
  approved: {label: 'Approved', tone: 'var(--status-good)'},
  edited: {label: 'Edited', tone: 'var(--status-warn)'},
  rejected: {label: 'Rejected', tone: 'var(--status-crit)'},
};
const pct = (x: number | null) => (x == null ? 'None yet' : `${Math.round(x * 100)}%`);
const half = (cycle: string) => `${cycle.endsWith('a') ? 'first' : 'second'} half of ${monthLabel(cycle.slice(0, 7), {month: 'long'})}`;
const stamp = (iso: string) => new Date(iso).toLocaleString('en-US', {month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Manila'});

export function GoldlineRestockRun({data}: {data: RestockRunViewData}) {
  const router = useRouter();
  const pathname = usePathname();
  const {run, store} = data;
  const [filter, setFilter] = useState<Filter>(store ? 'all' : 'to_decide');
  const [page, setPage] = useState(1);
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
    setPage(1);
    setFilter(s ? 'all' : 'to_decide');
    router.push(q.size ? `${pathname}?${q}` : pathname);
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
  const toggle = (set: Set<string>, id: string) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  };

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
              {run ? (
                <>
                  The run for the {half(run.cycle)} covers <span className="font-medium text-foreground">{span(run.months)}</span>, from last year&apos;s {span(run.lastYear)}. Made{' '}
                  {stamp(run.updatedAt)}
                  {run.updatedBy ? ` by ${run.updatedBy}` : ''}, for {fmtDay(run.runDate)}.
                </>
              ) : (
                <>No run for the {half(data.cycle)} yet. Making one works out what each store needs for the coming months and saves it for approval.</>
              )}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              {run && (
                <NativeSelect aria-label="Store" value={store ?? ''} onChange={(e) => go({store: e.target.value || null})}>
                  <option value="">All stores ({data.stores.length})</option>
                  {data.stores.map((s) => (
                    <option key={s.storeCode} value={s.storeCode}>
                      {s.name ? `${s.storeCode} · ${s.name}` : `Store ${s.storeCode}`}
                    </option>
                  ))}
                </NativeSelect>
              )}
              <label className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                <CalendarClock className="size-3.5" aria-hidden />
                Run date
                <input
                  id="restock-run-date"
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
            </div>
          </div>
          <Button
            variant={run ? 'outline' : 'default'}
            size="sm"
            onClick={makeRun}
            disabled={pending || !data.canMakeRun || !data.configured}
            title={data.canMakeRun ? 'Works out every line again. Decided lines keep their numbers.' : 'Company-wide admins make the run'}
          >
            {pending ? <Loader2 className="size-4 animate-spin" /> : <PackageCheck className="size-4" />} {run ? 'Make run again' : 'Make run'}
          </Button>
        </div>
        <div className="h-0.5 w-24 rounded-full bg-gradient-to-r from-primary to-transparent" aria-hidden />
      </header>

      {(error || notice) && (
        <p role={error ? 'alert' : 'status'} className={cn('text-sm', error ? 'text-destructive' : 'text-muted-foreground')}>
          {error ?? notice}
        </p>
      )}

      {!data.configured ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 px-6 py-12 text-center">
            <Info className="size-6 text-muted-foreground" aria-hidden />
            <h2 className="font-heading text-base font-semibold">Sales data isn&apos;t connected</h2>
            <p className="max-w-md text-sm text-muted-foreground">The restock reads the Nichido database, which isn&apos;t set up in this environment.</p>
          </CardContent>
        </Card>
      ) : !run ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 px-6 py-12 text-center">
            <PackageCheck className="size-6 text-muted-foreground" aria-hidden />
            <h2 className="font-heading text-base font-semibold">Make the run after each form</h2>
            <p className="max-w-md text-sm text-muted-foreground text-pretty">
              Coop checks whether each store is good for the window plus safety stock, and suggests what to send when it isn&apos;t. Lines that need a check first are listed on the Inputs tab.
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          {data.warehouseSample && <Banner>Warehouse stock is still sample data, so the cap on what Coop suggests isn&apos;t real yet. Enter real counts on the Inventory board.</Banner>}
          {skipped && (skipped.no_count.stores > 0 || skipped.out_of_scope.stores > 0) && (
            <p className="-mt-2 text-xs text-muted-foreground">
              Not in this run:{' '}
              {skipped.no_count.stores > 0 && (
                <>
                  {num(skipped.no_count.stores)} {skipped.no_count.stores === 1 ? 'store' : 'stores'} with no counted form yet ({num(skipped.no_count.lines)} lines)
                </>
              )}
              {skipped.no_count.stores > 0 && skipped.out_of_scope.stores > 0 && ', '}
              {skipped.out_of_scope.stores > 0 && (
                <>
                  {num(skipped.out_of_scope.stores)} paused {skipped.out_of_scope.stores === 1 ? 'store' : 'stores'} ({num(skipped.out_of_scope.lines)} lines)
                </>
              )}
              .
            </p>
          )}

          <section aria-label="Summary" className={cn('grid grid-cols-2 gap-4 lg:grid-cols-4', GL_TILES_MOBILE)}>
            <Metric label="To decide" value={num(data.toDecide)} sub="lines with something to send" valueClassName={data.toDecide ? 'text-[var(--status-warn)]' : undefined} />
            <Metric label="Units to send" value={num(sendUnits)} sub="suggested or decided, every store" />
            <Metric label="Approved as is" value={pct(data.score)} sub="of decided lines, this run" />
            <Metric label="Stores" value={num(data.stores.length)} sub="with a counted form, restock on" />
          </section>

          <Card className="py-0">
            <CardContent className="flex flex-col gap-3 px-0 pt-4 pb-3">
              <div className="flex flex-wrap items-center justify-between gap-2 px-4">
                <div className={GL_SCROLL_ROW_MOBILE}>
                  <SegmentedControl<Filter>
                    ariaLabel="Filter lines"
                    value={filter}
                    onChange={(v) => {
                      setFilter(v);
                      setPage(1);
                    }}
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
                  <Button size="sm" onClick={() => decide([...selected], 'approved')} disabled={pending || !selected.size}>
                    <Check className="size-4" /> Approve {selected.size ? `${num(selected.size)} selected` : 'selected'}
                  </Button>
                )}
              </div>

              {rows.length === 0 ? (
                <p className="px-4 py-10 text-center text-sm text-muted-foreground">
                  {filter === 'to_decide' && counts.decided ? 'Every line is decided.' : data.lines.length ? 'Nothing matches this filter.' : 'Every store in this run is covered.'}
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full border-collapse text-sm">
                    <thead>
                      <tr className="border-y border-border bg-muted/40 text-left text-[11px] tracking-wide whitespace-nowrap text-muted-foreground uppercase">
                        <th className={cn(TH, 'w-8 pl-4')}>
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
                        <th className={TH}>Product</th>
                        <th className={cn(TH, 'text-right')}>Last year {run.lastYear.map((m) => monthLabel(m, {month: 'short'})).join(' · ')}</th>
                        <th className={cn(TH, 'text-right')}>On hand</th>
                        <th className={cn(TH, 'text-right')}>Safety</th>
                        <th className={cn(TH, 'text-right')}>Send</th>
                        <th className={cn(TH, 'pr-4')}>Decision</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pageRows.map((l) => {
                        const isOpen = open.has(l.id);
                        const canPick = data.canDecide && l.state === 'send' && l.decision === 'pending';
                        return (
                          <Fragment key={l.id}>
                            <tr className={cn('border-b border-border/60 transition-colors duration-150 hover:bg-muted/40', selected.has(l.id) && 'bg-muted/50')}>
                              <td className={cn(TD, 'pl-4')}>
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
                                    {l.storeName ?? `Store ${l.storeCode}`}
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
                                    <span className="font-medium">{l.name}</span> <span className="font-mono text-xs text-muted-foreground">{l.itemCode}</span>
                                  </span>
                                </button>
                                <Link
                                  href={restockItemHref(l.itemCode, l.storeCode, data.preview ? data.runDate : null)}
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
                              <td className={cn(TD, 'pr-4')}>
                                <DecisionCell line={l} canDecide={data.canDecide} pending={pending} onApprove={() => decide([l.id], 'approved')} onUndo={() => decide([l.id], 'pending')} onDialog={(kind) => setDialog({line: l, kind})} />
                              </td>
                            </tr>
                            {isOpen && (
                              <tr className="border-b border-border/60 bg-muted/30">
                                <td />
                                <td colSpan={store ? 6 : 7} className="py-2.5 pr-4 text-xs text-muted-foreground">
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
              {pageCount > 1 && <Pagination page={at} pageCount={pageCount} onPage={setPage} className="px-4" />}
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

const TH = 'py-2 pr-3 font-medium';
const TD = 'py-2.5 pr-3 align-top';

function Banner({children}: {children: React.ReactNode}) {
  return (
    <div role="status" className="flex items-start gap-2.5 rounded-lg border border-[color-mix(in_oklab,var(--status-warn)_35%,transparent)] bg-[color-mix(in_oklab,var(--status-warn)_9%,transparent)] px-3.5 py-3 text-sm">
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
    return (
      <span className="flex flex-col gap-1">
        <span className="flex flex-wrap items-center gap-1.5">
          <ToneChip tone={d.tone}>{d.label}</ToneChip>
          {canDecide && (
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
          <Button size="xs" variant="outline" onClick={onApprove} disabled={pending}>
            <Check className="size-3.5" /> Approve
          </Button>
          <Button size="xs" variant="ghost" onClick={() => onDialog('edited')} disabled={pending}>
            <Pencil className="size-3.5" /> Edit
          </Button>
          <Button size="xs" variant="ghost" onClick={() => onDialog('rejected')} disabled={pending}>
            <X className="size-3.5" /> Reject
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
    <section aria-label="Score by store" className="flex flex-col gap-2">
      <h2 className="font-heading text-base font-semibold">By store</h2>
      <Card className="py-0">
        <CardContent className="px-0 py-0">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/40 text-left text-[11px] tracking-wide whitespace-nowrap text-muted-foreground uppercase">
                  <th className={cn(TH, 'pl-4')}>Store</th>
                  <th className={cn(TH, 'text-right')}>To send</th>
                  <th className={cn(TH, 'text-right')}>Covered</th>
                  <th className={cn(TH, 'text-right')}>Check data first</th>
                  <th className={cn(TH, 'text-right')}>To decide</th>
                  <th className={cn(TH, 'text-right')}>Units</th>
                  <th className={cn(TH, 'pr-4 text-right')} title="Approved as is ÷ decided">
                    Approved as is
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
                    </td>
                    <td className={cn(TD, 'text-right tabular-nums')}>{num(r.send)}</td>
                    <td className={cn(TD, 'text-right tabular-nums')}>{num(r.covered)}</td>
                    <td className={cn(TD, 'text-right tabular-nums', r.held && 'text-[var(--status-warn)]')}>{num(r.held)}</td>
                    <td className={cn(TD, 'text-right tabular-nums')}>{num(r.pending)}</td>
                    <td className={cn(TD, 'text-right tabular-nums')}>{num(r.sendUnits)}</td>
                    <td className={cn(TD, 'pr-4 text-right tabular-nums')}>{r.score == null ? <span className="text-muted-foreground">·</span> : `${Math.round(r.score * 100)}%`}</td>
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
