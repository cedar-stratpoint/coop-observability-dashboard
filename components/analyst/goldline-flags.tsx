'use client';

import {Fragment, useEffect, useMemo, useRef, useState, useTransition} from 'react';
import {useRouter} from 'next/navigation';
import {ArrowLeft, ArrowRight, Calculator, ChevronLeft, ChevronRight, CircleAlert, CircleCheck, OctagonAlert, PenLine, RefreshCw, TriangleAlert, Trash2} from 'lucide-react';
import type {AdjustmentReason, AdjustmentRow, BaTile, FlagRow, FlagsData, FormCell, FormCycle, FormRow} from '@/src/goldline-flags-data';
import {basOf, FLAG_CAUSES, type BaTag, type FlagCause} from '@/src/goldline-checks';
import {addAdjustmentAction, deleteAdjustmentAction, formPagesAction, logLossAction, remarkFlagAction, runChecksAction, type FlagActionResult} from '@/app/flags/actions';
import {Card, CardContent} from '@/components/ui/card';
import {Button} from '@/components/ui/button';
import {NativeSelect} from '@/components/ui/native-select';
import {Pagination} from '@/components/analyst/pagination';
import {GL_PAGE, GL_SCROLL_ROW_MOBILE, GL_TILES_MOBILE} from '@/src/goldline-ui';
import {cn} from '@/lib/utils';

// The flag queue (F7), as decided Oct 26: one tile per store, BA and month with the BA's
// points and tag; opening a tile shows the form page by page, every flagged cell boxed
// with its reason. Every flag counts against the BA as soon as Coop raises it, for good:
// there's no approve, dismiss or remove, and a count corrected later still counts (the
// form was wrong when written). Admins add remarks, and a sales gap that was really a
// pull-out, damage or loss can be logged as an adjustment (F5) so next month starts right. Product names lead (item codes repeat on the form); labels and icons carry
// the meaning, colour only backs them up.

type Tab = 'bas' | 'adjustments';
type Tone = 'warn' | 'crit' | 'info' | 'good';
const PAGE_SIZE = 12;
const n = (v: unknown) => (typeof v === 'number' ? Math.round(v * 10) / 10 : Number(v) || 0).toLocaleString('en-US');

export const CAUSE: Record<FlagCause, {label: string; tone: Tone; Icon: typeof PenLine; help: string}> = {
  messy_handwriting: {label: 'Messy handwriting', tone: 'info', Icon: PenLine, help: 'Unclear digits, erasures, overwrites.'},
  incorrect_total: {label: 'Incorrect total', tone: 'warn', Icon: Calculator, help: 'A row that doesn’t add up, or more gone than POS sold.'},
  padding: {label: 'Padding', tone: 'crit', Icon: TriangleAlert, help: 'POS sold more than the counts show, or a count at 0 or below.'},
};
export const TAG: Record<BaTag, {label: string; tone: Tone; Icon: typeof CircleCheck}> = {
  clear: {label: 'Clear', tone: 'good', Icon: CircleCheck},
  at_risk: {label: 'At risk', tone: 'warn', Icon: CircleAlert},
  delinquent: {label: 'Delinquent', tone: 'crit', Icon: OctagonAlert},
};
const REASON: Record<AdjustmentReason, string> = {pull_out: 'Pull-out', damage: 'Damage', loss: 'Loss or pilferage'};
const CELLS: Array<[FormCell, string]> = [
  ['stockroom', 'Stockroom'],
  ['drawer', 'Drawer'],
  ['selling_area', 'Selling area'],
  ['delivery', 'Delivery'],
  ['ending_on_hand', 'Ending'],
];
export const toneVar = (t: Tone) => (t === 'info' ? 'var(--chart-2, var(--muted-foreground))' : `var(--status-${t})`);
export const tint = (t: Tone, pct = 12) => `color-mix(in oklab, ${toneVar(t)} ${pct}%, transparent)`;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const FULL_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const fmtDay = (iso: string) => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}`;
const fmtMonth = (ym: string) => `${FULL_MONTHS[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;
const fmtCycle = (a: string, b: string) => (a.slice(0, 7) === b.slice(0, 7) ? `${fmtDay(a)} to ${Number(b.slice(8, 10))}` : `${fmtDay(a)} to ${fmtDay(b)}`);
const plural = (k: number, one: string, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;

/**
 * Which cells on the form a flag points at; the first is where its note's arrow lands.
 * A sales gap points at the month's ending: that's the number POS disagrees with.
 */
function cellsOf(f: FlagRow): FormCell[] {
  if (f.kind === 'unreadable') return ((f.details.marks as Array<{field: string}> | undefined) ?? []).map((m) => m.field as FormCell);
  if (f.kind === 'zero_or_below' && f.details.source === 'parts') return ['stockroom', 'drawer', 'selling_area'];
  return ['ending_on_hand'];
}
/** For an incorrect row total, the cells it should add up (underlined, not boxed). */
const partsOf = (f: FlagRow, r: FormRow): FormCell[] =>
  f.kind === 'row_math' ? (['stockroom', 'drawer', 'selling_area'] as FormCell[]).filter((c) => r[c] != null) : [];
// The box style names the cause without colour: solid, dashed, dotted.
const BORDER: Record<FlagCause, 'solid' | 'dashed' | 'dotted'> = {incorrect_total: 'solid', padding: 'dashed', messy_handwriting: 'dotted'};
// Column layout of the digital form (fixed, so a note's arrow can land on its cell).
const PRODUCT_W = 30;
const CELL_W = (100 - PRODUCT_W) / 5;
const cellCenter = (c: FormCell) => PRODUCT_W + (CELLS.findIndex(([k]) => k === c) + 0.5) * CELL_W;

/** One plain sentence saying what Coop saw, in the words on the form. */
export function explain(f: FlagRow): string {
  const d = f.details;
  if (f.kind === 'row_math') {
    const parts = (
      [
        ['stockroom', d.stockroom],
        ['drawer', d.drawer],
        ['selling area', d.selling_area],
      ] as Array<[string, unknown]>
    )
      .filter(([, v]) => v != null)
      .map(([k, v], i) => `${i === 0 ? k[0].toUpperCase() + k.slice(1) : k} ${n(v)}`);
    return `${parts.join(' + ') || 'Nothing counted'} = ${n(d.counted)}, but the ending says ${n(d.written)}.`;
  }
  if (f.kind === 'zero_or_below') return Number(d.onHand) === 0 ? 'The count is 0.' : `The count is below 0 (${n(d.onHand)}).`;
  if (f.kind === 'unreadable') {
    const marks = (d.marks as Array<{field: string; mark: string; written?: string | null}> | undefined) ?? [];
    const word = (m: string) => (m === 'overwritten' ? 'written over' : m === 'straddle' ? 'between two boxes' : 'unclear');
    return marks.map((m) => `${CELLS.find(([c]) => c === m.field)?.[1] ?? m.field} ${word(m.mark)}${m.written ? `: ${m.written}?` : ''}`).join('. ') || 'A cell couldn’t be read clearly.';
  }
  const gap = Number(d.gap);
  return gap > 0
    ? `The counts show ${n(d.form_sold)} gone this month, but POS sold ${n(d.pos_sold)}: ${n(gap)} more left than were sold.`
    : `POS sold ${n(d.pos_sold)} this month, but the counts show only ${n(d.form_sold)} gone. The ending looks ${n(-gap)} too high.`;
}

function Pill({tone, Icon, children}: {tone: Tone; Icon?: typeof PenLine; children: React.ReactNode}) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium" style={{color: toneVar(tone), background: tint(tone, 14)}}>
      {Icon && <Icon aria-hidden className="size-3.5" />}
      {children}
    </span>
  );
}

const breakdown = (t: BaTile) =>
  FLAG_CAUSES.filter((c) => t.byCause[c] > 0)
    .map((c) => `${t.byCause[c]} ${CAUSE[c].label}`)
    .join(' · ');

type Act = (fn: () => Promise<FlagActionResult>, okText: string, after?: () => void) => void;

export function GoldlineFlags({
  company,
  data,
  canEdit,
  initialOpen = null,
  initialMonth = null,
}: {
  company: string;
  data: FlagsData;
  canEdit: boolean;
  /** Tile key (store|month|BA) to open on, from the BA scorecard. */
  initialOpen?: string | null;
  initialMonth?: string | null;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [notice, setNotice] = useState<{kind: 'ok' | 'err'; text: string} | null>(null);
  const [tab, setTab] = useState<Tab>('bas');
  const months = useMemo(() => [...new Set(data.tiles.map((t) => t.month))].sort().reverse(), [data.tiles]);
  const [month, setMonth] = useState(initialMonth && months.includes(initialMonth) ? initialMonth : (months[0] ?? ''));
  const [tagFilter, setTagFilter] = useState<BaTag | 'all'>('all');
  const [store, setStore] = useState('all');
  const [page, setPage] = useState(1);
  const [openKey, setOpenKey] = useState<string | null>(initialOpen);

  function act(fn: () => Promise<FlagActionResult>, okText: string, after?: () => void) {
    setNotice(null);
    start(async () => {
      const res = await fn();
      if (res.ok) {
        setNotice({kind: 'ok', text: res.note ?? okText});
        after?.();
        router.refresh();
      } else setNotice({kind: 'err', text: res.error});
    });
  }

  const inMonth = data.tiles.filter((t) => t.month === month);
  const tagCounts = {clear: 0, at_risk: 0, delinquent: 0} as Record<BaTag, number>;
  for (const t of inMonth) tagCounts[t.tag]++;
  const causeCounts = {messy_handwriting: 0, incorrect_total: 0, padding: 0} as Record<FlagCause, number>;
  for (const f of data.flags) if (f.periodEnd.slice(0, 7) === month) causeCounts[f.cause]++;
  const list = inMonth.filter((t) => (tagFilter === 'all' || t.tag === tagFilter) && (store === 'all' || t.store_code === store));
  const pageCount = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const rows = list.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);
  const opened = openKey ? data.tiles.find((t) => t.key === openKey) : null;
  const cov = data.coverage.find((c) => c.month === month);

  return (
    <div className={cn(GL_PAGE, GL_TILES_MOBILE)}>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="font-heading text-xl font-semibold tracking-tight">Flags</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Every flag Coop raises counts against the BA on the form. One tile per store and BA; open it to see the form with each flagged cell boxed.
          </p>
        </div>
        {canEdit && (
          <Button size="sm" variant="outline" disabled={pending} onClick={() => act(() => runChecksAction({company}), 'Checks ran.')}>
            <RefreshCw className={cn('size-3.5', pending && 'animate-spin motion-reduce:animate-none')} /> Run checks
          </Button>
        )}
      </header>

      {notice && (
        <p role="status" className={cn('text-sm', notice.kind === 'ok' ? 'text-muted-foreground' : 'text-destructive')}>
          {notice.text}
        </p>
      )}

      {opened ? (
        <FormView key={opened.key} tile={opened} company={company} flags={data.flags} canEdit={canEdit} pending={pending} act={act} onBack={() => setOpenKey(null)} />
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className={GL_SCROLL_ROW_MOBILE}>
              <div role="group" aria-label="Show" className="flex gap-2">
                {(
                  [
                    ['bas', 'BAs', inMonth.length],
                    ['adjustments', 'Adjustments', data.adjustments.length],
                  ] as Array<[Tab, string, number]>
                ).map(([v, label, c]) => (
                  <button
                    key={v}
                    type="button"
                    aria-pressed={tab === v}
                    onClick={() => setTab(v)}
                    className={cn(
                      'inline-flex h-7 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-[background-color,border-color,transform] duration-150 ease-out active:scale-[0.97]',
                      tab === v ? 'border-primary bg-primary text-primary-foreground' : 'border-border hover:border-foreground/30',
                    )}
                  >
                    {label} <span className="tabular-nums opacity-80">{c}</span>
                  </button>
                ))}
              </div>
            </div>
            {tab === 'bas' && months.length > 0 && (
              <div className="flex flex-wrap gap-2">
                <NativeSelect
                  aria-label="Month"
                  value={month}
                  onChange={(e) => {
                    setMonth(e.target.value);
                    setPage(1);
                  }}
                >
                  {months.map((m) => (
                    <option key={m} value={m}>
                      {fmtMonth(m)}
                    </option>
                  ))}
                </NativeSelect>
                {data.stores.length > 1 && (
                  <NativeSelect
                    aria-label="Store"
                    value={store}
                    onChange={(e) => {
                      setStore(e.target.value);
                      setPage(1);
                    }}
                  >
                    <option value="all">All stores</option>
                    {[...new Set(inMonth.map((t) => t.store_code))].map((code) => (
                      <option key={code} value={code}>
                        {inMonth.find((t) => t.store_code === code)?.storeName ?? code}
                      </option>
                    ))}
                  </NativeSelect>
                )}
              </div>
            )}
          </div>

          {tab === 'adjustments' ? (
            <Adjustments company={company} data={data} canEdit={canEdit} pending={pending} act={act} />
          ) : months.length === 0 ? (
            <Card>
              <CardContent className="px-6 py-10 text-center text-sm text-muted-foreground">No forms saved yet. Tiles appear once a store’s form is saved.</CardContent>
            </Card>
          ) : (
            <>
              <div className="grid grid-cols-3 gap-2 sm:gap-3">
                {(['delinquent', 'at_risk', 'clear'] as BaTag[]).map((t) => {
                  const {label, tone, Icon} = TAG[t];
                  return (
                    <button
                      key={t}
                      type="button"
                      aria-pressed={tagFilter === t}
                      onClick={() => {
                        setTagFilter(tagFilter === t ? 'all' : t);
                        setPage(1);
                      }}
                      className={cn(
                        'flex items-center justify-between gap-2 rounded-xl border bg-card px-4 py-3 text-left transition-[border-color,transform] duration-150 ease-out active:scale-[0.98] max-sm:flex-col-reverse max-sm:items-start max-sm:gap-0.5 max-sm:px-3 max-sm:py-2.5',
                        tagFilter === t ? 'border-foreground/40' : 'border-border hover:border-foreground/25',
                      )}
                    >
                      <span className="inline-flex items-center gap-1.5 text-sm font-medium" style={{color: toneVar(tone)}}>
                        <Icon aria-hidden className="size-4" /> {label}
                      </span>
                      <span className="font-heading text-xl font-semibold tabular-nums">{tagCounts[t]}</span>
                    </button>
                  );
                })}
              </div>

              <p className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm text-muted-foreground">
                <span className="font-medium text-foreground">{fmtMonth(month)}:</span>
                {FLAG_CAUSES.map((c) => {
                  const {label, tone, Icon} = CAUSE[c];
                  return (
                    <span key={c} className="inline-flex items-center gap-1" title={CAUSE[c].help}>
                      <Icon aria-hidden className="size-3.5" style={{color: toneVar(tone)}} />
                      <span className="tabular-nums text-foreground">{causeCounts[c]}</span> {label}
                    </span>
                  );
                })}
              </p>
              {cov && (cov.waiting_sales > 0 || cov.unlinked > 0) && (
                <p className="text-xs text-muted-foreground">
                  Form vs. sales:{' '}
                  {[
                    cov.waiting_sales && `${cov.waiting_sales} waiting for that month’s POS Sales Data`,
                    cov.unlinked && `${cov.unlinked} held out (Watsons SKU not linked)`,
                    cov.baseline && `${cov.baseline} first counts (baseline only)`,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
              )}

              {rows.length === 0 ? (
                <Card>
                  <CardContent className="px-6 py-10 text-center text-sm text-muted-foreground">No BAs match.</CardContent>
                </Card>
              ) : (
                <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
                  {rows.map((t) => (
                    <li key={t.key}>
                      <Tile t={t} onOpen={() => setOpenKey(t.key)} />
                    </li>
                  ))}
                </ul>
              )}
              <Pagination page={safePage} pageCount={pageCount} onPage={setPage} label="BA pages" />
            </>
          )}
        </>
      )}
    </div>
  );
}

function Tile({t, onOpen}: {t: BaTile; onOpen: () => void}) {
  const tag = TAG[t.tag];
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex h-full w-full flex-col gap-3 rounded-xl border border-border bg-card p-4 text-left transition-[border-color,background-color,transform] duration-150 ease-out hover:border-foreground/25 hover:bg-muted/25 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none active:scale-[0.98]"
    >
      <span className="flex items-start justify-between gap-3">
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate text-sm font-medium">{t.storeName ?? `Store ${t.store_code}`}</span>
          {/* Full BA name, never shortened (Oct 26). */}
          <span className="text-sm text-muted-foreground">{t.ba ?? 'BA not named on the form'}</span>
        </span>
        <Pill tone={tag.tone} Icon={tag.Icon}>
          {tag.label}
        </Pill>
      </span>
      <span className="flex flex-col gap-1 text-xs text-muted-foreground">
        <span>
          <span className="font-medium tabular-nums text-foreground">{plural(t.points, 'point')}</span>
          {t.points ? ` · ${breakdown(t)}` : ' · form in, nothing flagged'}
        </span>
        {t.category && t.points > 1 && <span>Mostly {CAUSE[t.category].label.toLowerCase()}</span>}
      </span>
      <span className="mt-auto flex items-center gap-1 border-t border-border/60 pt-3 text-xs font-medium text-foreground">
        Open form <ArrowRight aria-hidden className="size-3.5 transition-transform duration-150 ease-out group-hover:translate-x-0.5" />
      </span>
    </button>
  );
}

function FormView({tile, company, flags, canEdit, pending, act, onBack}: {tile: BaTile; company: string; flags: FlagRow[]; canEdit: boolean; pending: boolean; act: Act; onBack: () => void}) {
  const [cycles, setCycles] = useState<FormCycle[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ci, setCi] = useState(0);
  const [pi, setPi] = useState(0);
  const [onlyFlagged, setOnlyFlagged] = useState(false);
  const top = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    formPagesAction({company, store: tile.store_code, month: tile.month, ba: tile.ba}).then((res) => {
      if (!live) return;
      if (!res.ok) return setError(res.error);
      setCycles(res.cycles);
      // Start on the first page that has a flag.
      for (let c = 0; c < res.cycles.length; c++) {
        const p = res.cycles[c].pages.findIndex((pg) => pg.rows.some((r) => r.flagIds.length));
        if (p >= 0) {
          setCi(c);
          setPi(p);
          return;
        }
      }
    });
    return () => {
      live = false;
    };
    // Re-read after a remark or adjustment refreshes the flags.
  }, [company, tile.store_code, tile.month, tile.ba, flags]);

  useEffect(() => {
    // On a phone, start on the flagged rows; the whole page is one tap away.
    if (matchMedia('(max-width: 640px)').matches) setOnlyFlagged(true);
    top.current?.scrollIntoView({block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'});
  }, []);

  const byId = useMemo(() => new Map(flags.map((f) => [f.id, f])), [flags]);
  // Flags for this tile that sit on no row (e.g. a sales gap for an item missing from
  // the last form): listed under the form so nothing that counts is hidden.
  const tileFlags = flags.filter((f) => f.storeCode === tile.store_code && f.periodEnd.slice(0, 7) === tile.month && basOf(f.consultant).includes(tile.ba));
  const placed = new Set(cycles?.flatMap((c) => c.pages.flatMap((p) => p.rows.flatMap((r) => r.flagIds))) ?? []);
  const loose = cycles ? tileFlags.filter((f) => !placed.has(f.id)) : [];

  const cycle = cycles?.[ci];
  const pg = cycle?.pages[pi];
  const rows = (pg?.rows ?? []).filter((r) => !onlyFlagged || r.flagIds.length);
  const pageFlags = (pg?.rows ?? []).flatMap((r) => r.flagIds.map((id) => byId.get(id)).filter((f): f is FlagRow => !!f));
  // Flags are numbered down the page, so a boxed cell, its note and its card share a number.
  const num = new Map(pageFlags.map((f, i) => [f.id, i + 1]));
  const tag = TAG[tile.tag];

  return (
    <div ref={top} className="flex scroll-mt-20 flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button size="sm" variant="ghost" onClick={onBack} className="-ml-2">
          <ArrowLeft className="size-3.5" /> All BAs
        </Button>
        <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Pill tone={tag.tone} Icon={tag.Icon}>
            {tag.label}
          </Pill>
          <span className="tabular-nums">{plural(tile.points, 'point')}</span>
          {tile.points > 0 && <span>· {breakdown(tile)}</span>}
        </span>
      </div>

      <div className="flex flex-col gap-1">
        <h2 className="font-heading text-lg font-semibold tracking-tight">
          {tile.storeName ?? `Store ${tile.store_code}`} · {tile.ba ?? 'BA not named on the form'}
        </h2>
        <p className="text-sm text-muted-foreground">
          {cycle ? `${fmtCycle(cycle.periodStart, cycle.periodEnd)} · ${pg?.page != null ? `page ${pg.page}` : 'form'} of ${cycle.pages.length}` : fmtMonth(tile.month)}
        </p>
      </div>

      {error ? (
        <p className="text-sm text-destructive">{error}</p>
      ) : !cycles ? (
        <p className="text-sm text-muted-foreground">Loading the form…</p>
      ) : cycles.length === 0 ? (
        <Card>
          <CardContent className="px-6 py-10 text-center text-sm text-muted-foreground">No saved form for this BA in {fmtMonth(tile.month)}.</CardContent>
        </Card>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap gap-2">
              {cycles.length > 1 &&
                cycles.map((c, i) => (
                  <button
                    key={`${c.periodStart}|${c.periodEnd}`}
                    type="button"
                    aria-pressed={ci === i}
                    onClick={() => {
                      setCi(i);
                      setPi(0);
                    }}
                    className={cn(
                      'h-7 rounded-full border px-3 text-xs font-medium transition-[background-color,border-color,transform] duration-150 ease-out active:scale-[0.97]',
                      ci === i ? 'border-primary bg-primary text-primary-foreground' : 'border-border hover:border-foreground/30',
                    )}
                  >
                    {fmtCycle(c.periodStart, c.periodEnd)}
                    {(() => {
                      const k = new Set(c.pages.flatMap((p) => p.rows.flatMap((r) => r.flagIds))).size;
                      return k ? ` · ${plural(k, 'flag')}` : '';
                    })()}
                  </button>
                ))}
              <label className="inline-flex h-7 items-center gap-1.5 text-xs text-muted-foreground">
                <input type="checkbox" checked={onlyFlagged} onChange={(e) => setOnlyFlagged(e.target.checked)} className="size-3.5 accent-[var(--primary)]" />
                Flagged rows only
              </label>
            </div>
            {cycle && cycle.pages.length > 1 && (
              <div className="flex items-center gap-1">
                <Button size="sm" variant="outline" disabled={pi === 0} onClick={() => setPi(pi - 1)} aria-label="Previous page">
                  <ChevronLeft className="size-3.5" />
                </Button>
                <NativeSelect aria-label="Page" value={String(pi)} onChange={(e) => setPi(Number(e.target.value))}>
                  {cycle.pages.map((p, i) => {
                    const k = p.rows.filter((r) => r.flagIds.length).length;
                    return (
                      <option key={p.uploadId ?? i} value={i}>
                        {p.page != null ? `Page ${p.page}` : 'Form'}
                        {k ? ` · ${plural(k, 'flagged row')}` : ''}
                      </option>
                    );
                  })}
                </NativeSelect>
                <Button size="sm" variant="outline" disabled={pi >= cycle.pages.length - 1} onClick={() => setPi(pi + 1)} aria-label="Next page">
                  <ChevronRight className="size-3.5" />
                </Button>
              </div>
            )}
          </div>

          <Card className="py-0">
            <CardContent className="px-0 py-0">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] table-fixed text-sm">
                  <colgroup>
                    <col style={{width: `${PRODUCT_W}%`}} />
                    {CELLS.map(([c]) => (
                      <col key={c} style={{width: `${CELL_W}%`}} />
                    ))}
                  </colgroup>
                  <thead>
                    <tr className="border-b border-border text-left text-xs text-muted-foreground">
                      <th className="px-4 py-2.5 font-medium">Product</th>
                      {CELLS.map(([c, label]) => (
                        <th key={c} className="px-2 py-2.5 text-right font-medium">
                          {label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.length === 0 ? (
                      <tr>
                        <td colSpan={CELLS.length + 1} className="px-4 py-8 text-center text-muted-foreground">
                          Nothing flagged on this page.
                        </td>
                      </tr>
                    ) : (
                      rows.map((r, i) => <FormLine key={`${r.itemCode}|${i}`} r={r} byId={byId} num={num} />)
                    )}
                  </tbody>
                </table>
              </div>
              <FormKey />
            </CardContent>
          </Card>
        </>
      )}

      {[...pageFlags, ...loose].length > 0 && (
        <div className="flex flex-col gap-2.5">
          <p className="text-sm font-medium">{loose.length && !pageFlags.length ? 'Flags not on a page' : 'Remarks and adjustments'}</p>
          <ul className="flex flex-col gap-2.5">
            {[...pageFlags, ...loose].map((f) => (
              <li key={f.id}>
                <FlagNote f={f} num={num.get(f.id)} company={company} canEdit={canEdit} pending={pending} act={act} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** One form row, then a note under it for each flag, its arrow on the cell that's wrong. */
function FormLine({r, byId, num}: {r: FormRow; byId: Map<string, FlagRow>; num: Map<string, number>}) {
  const fl = r.flagIds.map((id) => byId.get(id)).filter((f): f is FlagRow => !!f);
  const boxed = new Map<FormCell, FlagRow>();
  for (const f of fl) for (const c of cellsOf(f)) if (!boxed.has(c)) boxed.set(c, f);
  const parts = new Set(fl.flatMap((f) => partsOf(f, r)));
  return (
    <>
      <tr className={cn('align-top', fl.length ? '' : 'border-b border-border/60 last:border-0')} style={fl.length ? {background: tint(CAUSE[fl[0].cause].tone, 5)} : undefined}>
        <td className="px-4 py-2.5">{r.name}</td>
        {CELLS.map(([c]) => {
          const f = boxed.get(c);
          const v = r[c];
          const text = v == null ? '·' : n(v);
          return (
            <td key={c} className="px-2 py-2 text-right font-mono tabular-nums">
              {f ? (
                <span
                  className="relative inline-flex min-w-9 items-center justify-end rounded-md border-2 px-1.5 py-0.5 font-semibold"
                  style={{borderColor: toneVar(CAUSE[f.cause].tone), borderStyle: BORDER[f.cause], background: tint(CAUSE[f.cause].tone, 12)}}
                  aria-label={`${text}, flag ${num.get(f.id) ?? ''}: ${CAUSE[f.cause].label}`}
                >
                  {text}
                  <sup
                    aria-hidden
                    className="absolute -top-2 -right-2 grid size-4 place-items-center rounded-full font-sans text-[10px] leading-none font-semibold text-background"
                    style={{background: toneVar(CAUSE[f.cause].tone)}}
                  >
                    {num.get(f.id)}
                  </sup>
                </span>
              ) : parts.has(c) ? (
                <span className="underline decoration-dotted decoration-2 underline-offset-4" style={{textDecorationColor: toneVar(CAUSE.incorrect_total.tone)}}>
                  {text}
                </span>
              ) : v == null ? (
                <span className="text-muted-foreground">·</span>
              ) : (
                text
              )}
            </td>
          );
        })}
      </tr>
      {fl.map((f, i) => {
        const {label, tone, Icon} = CAUSE[f.cause];
        const at = cellCenter(cellsOf(f)[0]);
        // Notes under the right-hand columns hang from the right edge, so the arrow always lands on the box.
        const right = at > 60;
        return (
          <Fragment key={f.id}>
            <tr className={cn(i === fl.length - 1 && 'border-b border-border/60 last:border-0')} style={{background: tint(tone, 5)}}>
              <td colSpan={CELLS.length + 1} className="relative px-3 pt-1.5 pb-3">
                <span
                  aria-hidden
                  className="absolute top-0 size-3 rotate-45 border-t-[1.5px] border-l-[1.5px] max-sm:hidden"
                  style={{left: `calc(${at}% - 6px)`, borderColor: toneVar(tone), borderStyle: BORDER[f.cause], background: `color-mix(in oklab, ${toneVar(tone)} 12%, var(--card))`}}
                />
                <span
                  // On a phone the form scrolls sideways: the note pins to the visible left edge instead (it names the column).
                  className="block w-fit max-w-[22rem] rounded-lg border-[1.5px] px-2.5 py-1.5 text-xs leading-relaxed max-sm:sticky max-sm:left-3 max-sm:!ml-0 max-sm:max-w-[calc(100vw-4.5rem)]"
                  style={{
                    borderColor: toneVar(tone),
                    borderStyle: BORDER[f.cause],
                    background: `color-mix(in oklab, ${toneVar(tone)} 12%, var(--card))`,
                    ...(right ? {marginLeft: 'auto'} : {marginLeft: `clamp(0px, calc(${at}% - 3rem), calc(100% - 22rem))`}),
                  }}
                >
                  <span className="mr-1.5 inline-flex items-center gap-1 font-semibold" style={{color: toneVar(tone)}}>
                    {num.get(f.id)} · <Icon aria-hidden className="size-3.5" /> {label}
                  </span>
                  {explain(f)}
                  {f.status === 'resolved' && <span className="text-muted-foreground"> Data changed since, still counts.</span>}
                  {f.remark && <span className="mt-0.5 block text-muted-foreground">Remark: {f.remark}</span>}
                </span>
              </td>
            </tr>
          </Fragment>
        );
      })}
    </>
  );
}

/** What the box styles mean, so the form reads without colour. */
function FormKey() {
  return (
    <p className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
      {FLAG_CAUSES.map((c) => (
        <span key={c} className="inline-flex items-center gap-1.5">
          <span aria-hidden className="inline-block h-3 w-4 rounded-[3px] border-2" style={{borderColor: toneVar(CAUSE[c].tone), borderStyle: BORDER[c], background: tint(CAUSE[c].tone, 12)}} />
          {CAUSE[c].label} · {BORDER[c]} box
        </span>
      ))}
      <span className="inline-flex items-center gap-1.5">
        <span className="font-mono underline decoration-dotted decoration-2 underline-offset-4" style={{textDecorationColor: toneVar(CAUSE.incorrect_total.tone)}}>
          12
        </span>
        the numbers a total should add up to
      </span>
    </p>
  );
}

function FlagNote({f, num, company, canEdit, pending, act}: {f: FlagRow; num?: number; company: string; canEdit: boolean; pending: boolean; act: Act}) {
  const c = CAUSE[f.cause];
  const lossy = f.kind === 'sales_gap' && Number(f.details.gap) > 0;
  const [mode, setMode] = useState<'none' | 'remark' | 'loss'>('none');
  const [remark, setRemark] = useState(f.remark ?? '');
  const [reason, setReason] = useState<AdjustmentReason>('loss');
  const [qty, setQty] = useState(String(Math.max(1, Math.round(Number(f.details.gap) || 1))));
  const field = 'rounded-md border border-border bg-background px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40';
  return (
    <Card className="py-0">
      <CardContent className="flex flex-col gap-2.5 px-4 py-3">
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
          <div className="flex min-w-0 flex-col gap-1">
            <p className="flex flex-wrap items-center gap-2 text-xs">
              <Pill tone={c.tone} Icon={c.Icon}>
                {num != null ? `${num} · ` : ''}
                {c.label}
              </Pill>
              <span className="text-muted-foreground">{f.kind === 'sales_gap' ? `${fmtMonth(f.periodEnd.slice(0, 7))} vs. POS` : fmtCycle(f.periodStart, f.periodEnd)}</span>
              {f.status === 'resolved' && <span className="text-muted-foreground">· data changed since, still counts</span>}
            </p>
            <p className="text-sm font-medium">{f.itemName ?? f.itemCode}</p>
          </div>
          {canEdit && mode === 'none' && (
            <div className="flex shrink-0 gap-2">
              {lossy && (
                <Button size="sm" variant="outline" onClick={() => setMode('loss')}>
                  Log pull-out or loss
                </Button>
              )}
              <Button size="sm" variant="outline" onClick={() => setMode('remark')}>
                {f.remark ? 'Edit remark' : 'Add remark'}
              </Button>
            </div>
          )}
        </div>
        <p className="text-sm">{explain(f)}</p>
        {f.remark && mode === 'none' && (
          <p className="text-xs text-muted-foreground">
            <span className="font-medium text-foreground">Remark:</span> {f.remark}
            {f.remarkBy ? ` · ${f.remarkBy}` : ''}
            {f.remarkedAt ? ` · ${fmtDay(f.remarkedAt.slice(0, 10))}` : ''}
          </p>
        )}
        {mode !== 'none' && (
          <div className="flex flex-col gap-2.5 rounded-lg border border-border bg-muted/40 p-3">
            {mode === 'loss' && (
              <div className="flex flex-wrap items-center gap-2">
                <NativeSelect aria-label="What happened" value={reason} onChange={(e) => setReason(e.target.value as AdjustmentReason)}>
                  {(Object.keys(REASON) as AdjustmentReason[]).map((r) => (
                    <option key={r} value={r}>
                      {REASON[r]}
                    </option>
                  ))}
                </NativeSelect>
                <input aria-label="Units" inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value.replace(/\D/g, ''))} className={cn(field, 'h-8 w-24 tabular-nums')} />
                <span className="text-xs text-muted-foreground">units in {fmtMonth(f.periodEnd.slice(0, 7))}. Next month starts from the right number; this flag still counts.</span>
              </div>
            )}
            <textarea
              aria-label="Remark"
              value={remark}
              onChange={(e) => setRemark(e.target.value)}
              maxLength={500}
              rows={2}
              placeholder={mode === 'loss' ? 'What happened to the stock' : 'What you found. The flag still counts.'}
              className={cn(field, 'w-full resize-y py-2')}
            />
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={() => setMode('none')}>
                Cancel
              </Button>
              <Button
                size="sm"
                disabled={pending || !remark.trim() || (mode === 'loss' && !Number(qty))}
                onClick={() =>
                  mode === 'loss'
                    ? act(() => logLossAction({company, id: f.id, reason, qty: Number(qty), remark}), 'Logged.', () => setMode('none'))
                    : act(() => remarkFlagAction({company, id: f.id, remark}), 'Remark saved.', () => setMode('none'))
                }
              >
                {mode === 'loss' ? 'Log it' : 'Save remark'}
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Adjustments({company, data, canEdit, pending, act}: {company: string; data: FlagsData; canEdit: boolean; pending: boolean; act: Act}) {
  const [store, setStore] = useState(data.stores[0]?.code ?? '');
  const [item, setItem] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [reason, setReason] = useState<AdjustmentReason>('pull_out');
  const [qty, setQty] = useState('');
  const [note, setNote] = useState('');
  const ready = store && item && from && to && from <= to && Number(qty) > 0;
  const field = 'h-8 rounded-md border border-border bg-background px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40';
  return (
    <div className="flex flex-col gap-4">
      {canEdit && (
        <Card>
          <CardContent className="flex flex-col gap-3">
            <p className="text-sm font-medium">Log stock that left without a sale</p>
            <p className="text-xs text-muted-foreground">Pull-outs, damage and losses lower that month’s start, so the form vs. sales check doesn’t flag them.</p>
            <div className="flex flex-wrap gap-2">
              <NativeSelect aria-label="Store" value={store} onChange={(e) => setStore(e.target.value)}>
                {data.stores.map((s) => (
                  <option key={s.code} value={s.code}>
                    {s.name}
                  </option>
                ))}
              </NativeSelect>
              <NativeSelect aria-label="Product" value={item} onChange={(e) => setItem(e.target.value)} wrapperClassName="min-w-0 flex-1">
                <option value="">Pick the product…</option>
                {data.items.map((i) => (
                  <option key={i.code} value={i.code}>
                    {i.name}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                Cycle <input type="date" aria-label="Cycle start" value={from} onChange={(e) => setFrom(e.target.value)} className={field} />
              </label>
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                to <input type="date" aria-label="Cycle end" value={to} onChange={(e) => setTo(e.target.value)} className={field} />
              </label>
              <NativeSelect aria-label="What happened" value={reason} onChange={(e) => setReason(e.target.value as AdjustmentReason)}>
                {(Object.keys(REASON) as AdjustmentReason[]).map((r) => (
                  <option key={r} value={r}>
                    {REASON[r]}
                  </option>
                ))}
              </NativeSelect>
              <input aria-label="Units" inputMode="numeric" placeholder="Units" value={qty} onChange={(e) => setQty(e.target.value.replace(/\D/g, ''))} className={cn(field, 'w-24 tabular-nums')} />
            </div>
            <input aria-label="Note" placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} className={field} />
            <div className="flex justify-end">
              <Button
                size="sm"
                disabled={pending || !ready}
                onClick={() =>
                  act(
                    () => addAdjustmentAction({company, store, item, periodStart: from, periodEnd: to, reason, qty: Number(qty), note}),
                    'Logged. That store’s checks ran again.',
                    () => {
                      setQty('');
                      setNote('');
                    },
                  )
                }
              >
                Log adjustment
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
      {data.adjustments.length === 0 ? (
        <Card>
          <CardContent className="px-6 py-10 text-center text-sm text-muted-foreground">No adjustments logged yet.</CardContent>
        </Card>
      ) : (
        <ul className="flex flex-col gap-2">
          {data.adjustments.map((a: AdjustmentRow) => (
            <li key={a.id}>
              <Card className="py-0">
                <CardContent className="flex items-center justify-between gap-4 px-4 py-3">
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <p className="text-sm">
                      <span className="font-medium">{REASON[a.reason]}</span> · <span className="tabular-nums">{a.qty}</span> units · {a.itemName ?? a.itemCode}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {a.storeName ?? `Store ${a.storeCode}`} · {fmtCycle(a.periodStart, a.periodEnd)}
                      {a.sourceFlagId ? ' · from a flag' : ''}
                      {a.createdBy ? ` · ${a.createdBy}` : ''}
                    </p>
                    {a.note && <p className="text-xs text-muted-foreground">{a.note}</p>}
                  </div>
                  {canEdit && (
                    <Button size="sm" variant="ghost" disabled={pending} aria-label="Delete adjustment" onClick={() => act(() => deleteAdjustmentAction({company, id: a.id}), 'Deleted. That store’s checks ran again.')}>
                      <Trash2 className="size-3.5" />
                    </Button>
                  )}
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
