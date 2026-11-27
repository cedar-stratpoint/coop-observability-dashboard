'use client';

// All flags (Flags hub, Nov 26): every check, reader and reviewer flag for the company, as
// square tiles first (one per kind, by tier), then the flags behind a tile. Plan:
// knowledge/tasks/2026-11-26-nichido-flags-hub.md.
//
// - Overview: Needs you tiles are the only tinted ones (Von Restorff); Open, For your
//   information and Cleared follow, each quieter than the last. A tile shows one number.
// - A tile opens in place (same page): `?kind=<tile>` is pushed, so the browser's Back returns
//   to the tiles with the scroll kept and the tile marked (useDrillIn). The page number sits in
//   the URL too (replace, not push), so coming back from "Open page" lands on the same page.
// - Rows are one compact line on desktop: product and why, store and page, BA, actions. Checks
//   take a remark, never a clear: they always count against the BA (Oct 26).
// - Filters live in the URL (replaceState, no server round trip per keystroke); the CSV takes
//   the same filters.

import {useCallback, useEffect, useMemo, useRef, useState, useTransition} from 'react';
import type {ReactNode} from 'react';
import Link from 'next/link';
import {useRouter, useSearchParams} from 'next/navigation';
import {
  ArrowLeft,
  ArrowLeftRight,
  ArrowUpRight,
  Calculator,
  CircleCheck,
  Columns3,
  Download,
  EyeOff,
  Flag,
  ListPlus,
  OctagonAlert,
  PackageX,
  PenLine,
  Search,
  StickyNote,
  Tag,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';
import {cn} from '@/lib/utils';
import {FilterSelect, type FilterOption} from '@/components/ui/filter-select';
import {Button} from '@/components/ui/button';
import {Pagination} from '@/components/analyst/pagination';
import {keptId, useDrillIn, useReturnTrip} from '@/components/analyst/back-nav';
import {useLeaving} from '@/components/analyst/leaving';
import {FLAG_SOURCES, SOURCE_LABEL, filterLines, type FlagFilter, type FlagLine} from '@/src/goldline-flag-lines';
import type {FlagLinesData} from '@/src/goldline-flag-lines-data';
import {CLEARED_TILE, HUB_TIERS, clearableIds, hubTiles, isTileKey, kindMeta, lineMeta, pageOf, tileLines, type FlagMeta, type FlagTone, type HubTier, type HubTile} from '@/src/goldline-flag-hub';
import {titleName} from '@/src/goldline-ui';
import {peso} from '@/src/band-prices';
import {remarkFlagAction} from '@/app/flags/actions';
import {clearMarkAction, reopenMarkAction, setMarksAction} from '@/app/uploads/review-marks-actions';
import {setBandPriceAction} from '@/app/uploads/actions';
import {explain} from '@/components/analyst/goldline-flags';
import type {FlagRow} from '@/src/goldline-flags-data';

const EASE = 'ease-[cubic-bezier(0.23,1,0.32,1)]';

const ICON: Record<string, LucideIcon> = {
  'check:unreadable': PenLine,
  'check:row_math': Calculator,
  'check:zero_or_below': TriangleAlert,
  'check:sales_gap': ArrowLeftRight,
  'mark:illegible': EyeOff,
  'mark:note': StickyNote,
  'mark:damage': PackageX,
  'mark:column_changed': Columns3,
  'mark:added_row': ListPlus,
  'mark:price': Tag,
  'mark:other': Flag,
};
const iconFor = (kind: string | null) => (kind ? (ICON[kind] ?? Flag) : CircleCheck);

// One color per kind of flag (kindMeta), the same on its tile, its list header and every row.
// Info is a slate blue set on the hub's root (--flag-info), so it never reads as the brand green.
const TONE: Record<FlagTone, string> = {
  crit: 'var(--status-crit)',
  warn: 'var(--status-warn)',
  info: 'var(--flag-info)',
  good: 'var(--status-good)',
  neutral: 'var(--muted-foreground)',
};
/** Text on a tint: mixed toward the foreground so it clears AA in both themes. */
const toneInk = (t: FlagTone) => (t === 'neutral' ? 'var(--muted-foreground)' : `color-mix(in oklab, ${TONE[t]} 72%, var(--foreground))`);
const toneBg = (t: FlagTone, pct = 14) => `color-mix(in oklab, ${TONE[t]} ${pct}%, transparent)`;

/** The kind's icon on a tile of its color. */
function IconChip({kind, tone, size = 'md'}: {kind: string | null; tone: FlagTone; size?: 'md' | 'lg'}) {
  const Icon = iconFor(kind);
  return (
    <span
      className={cn('inline-flex shrink-0 items-center justify-center', size === 'lg' ? 'size-11 rounded-xl' : 'size-9 rounded-xl')}
      style={{background: toneBg(tone, tone === 'neutral' ? 10 : 15), color: tone === 'neutral' ? 'var(--muted-foreground)' : TONE[tone]}}
    >
      <Icon aria-hidden className={size === 'lg' ? 'size-5' : 'size-4'} />
    </span>
  );
}

/** What to do next, as a small pill in the kind's color: a dot carries the color, the words
 *  carry the meaning (so color is never the only cue). */
function TodoPill({meta, className}: {meta: FlagMeta; className?: string}) {
  return (
    <span
      className={cn('inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[0.6875rem] leading-4 font-medium whitespace-nowrap', className)}
      style={{color: toneInk(meta.tone), background: toneBg(meta.tone, meta.tone === 'neutral' ? 10 : 13)}}
    >
      <span aria-hidden className="size-1.5 rounded-full" style={{background: TONE[meta.tone]}} />
      {meta.todo}
    </span>
  );
}

/** The overview's one-line hint under each tier (the list view carries the full note). */
const TIER_HINT: Record<HubTier, string> = {
  needs: 'Answer before commit',
  open: 'Checks count against the BA',
  fyi: 'Nothing to fix',
  cleared: 'Kept for the record',
};

const TIER: Record<HubTier, {title: string; sub: string}> = {
  needs: {title: 'Needs you', sub: 'Answer these before the pages are committed, or the form is valued and checked on a guess.'},
  open: {title: 'Open', sub: 'Coop’s checks count against the BA and can take a remark. Review flags never count.'},
  fyi: {title: 'For your information', sub: 'Notes, relabelled columns and products written in. Worth knowing, nothing to fix.'},
  cleared: {title: 'Cleared', sub: 'A resolved check still counts against the BA; the form was wrong when written.'},
};

/** One line under a tile's title in the list view: what it is and whether it counts. */
function tileNote(t: HubTile): string {
  if (t.tier === 'needs') return TIER.needs.sub;
  if (t.tier === 'cleared') return TIER.cleared.sub;
  if (t.tier === 'fyi') return 'Raised by the reader or a reviewer. Worth knowing, never counts against the BA.';
  return t.kind?.startsWith('check:') ? 'Coop’s check. Counts against the BA; add a remark if there is more to it.' : 'Raised by the reader or a reviewer. Never counts against the BA.';
}

const monthName = (m: string) => {
  const [y, mo] = m.split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1, 1)).toLocaleDateString('en-US', {month: 'long', year: 'numeric', timeZone: 'UTC'});
};
const monthShort = (m: string) => {
  const [y, mo] = m.split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1, 1)).toLocaleDateString('en-US', {month: 'short', year: 'numeric', timeZone: 'UTC'});
};
const fmt = (n: number) => n.toLocaleString('en-US');
const plural = (n: number, one: string, many = `${one}s`) => `${fmt(n)} ${n === 1 ? one : many}`;

/** The hub's URL: filters, plus the open tile and page when there is one. */
function hubUrl(f: FlagFilter, kind: string | null, page: number): string {
  const sp = new URLSearchParams();
  if (f.store) sp.set('store', f.store);
  if (f.month) sp.set('month', f.month);
  if (f.source) sp.set('source', f.source);
  if (f.q) sp.set('q', f.q);
  if (kind) sp.set('kind', kind);
  if (kind && page > 1) sp.set('p', String(page));
  const q = sp.toString();
  return `/flags${q ? `?${q}` : ''}`;
}

type Toast = {id: number; text: string; undo?: () => void};
type Act = {
  clear: (l: FlagLine) => void;
  reopen: (l: FlagLine) => void;
  clearAll: (lines: FlagLine[]) => void;
  price: (l: FlagLine, price: number) => void;
  remark: (l: FlagLine, remark: string) => Promise<string | null>;
};

export function FlagsHub({data, initial, company, canEdit}: {data: FlagLinesData; initial: FlagFilter; company: string; canEdit: boolean}) {
  const router = useRouter();
  const params = useSearchParams();
  const [pending, start] = useTransition();
  const [f, setF] = useState<FlagFilter>({...initial, open: 'all'});
  const [openParam, openTile, closeTile] = useDrillIn('kind');
  // Coming back from a page opened here (our Back link or the browser's): scroll and the row
  // come back, the row marked. `leave` remembers them, with the tile's name for the Back label.
  const {leave} = useReturnTrip('flags');
  const tileKey = isTileKey(openParam) ? openParam : null;
  const page = Math.max(1, Number(params.get('p')) || 1);
  // Lines on their way out (fading) and gone (removed until the server agrees).
  const {leaving, gone, remove, restore, reset: forgetRemovals} = useLeaving();
  const [toast, setToast] = useState<Toast | null>(null);
  const [error, setError] = useState<string | null>(null);
  const top = useRef<HTMLDivElement>(null);

  // Filters write the URL in place, keeping the open tile; a new filter starts at page 1. Only
  // when they differ from the URL's, so a deep link's page (and a Back) is never reset.
  useEffect(() => {
    const cur = new URLSearchParams(window.location.search);
    const want: Record<string, string> = {store: f.store ?? '', month: f.month ?? '', source: f.source ?? '', q: f.q};
    if (Object.entries(want).every(([k, v]) => (cur.get(k) ?? '') === v)) return;
    window.history.replaceState(null, '', hubUrl(f, cur.get('kind'), 1));
  }, [f]);

  // A server refresh brings lines back in their real state; forget the local removals.
  useEffect(() => forgetRemovals(), [data, forgetRemovals]);

  const setPage = useCallback(
    (p: number) => {
      window.history.replaceState(null, '', hubUrl(f, tileKey, p));
      top.current?.scrollIntoView({block: 'start', behavior: 'instant'});
    },
    [f, tileKey],
  );
  const open = (key: string) => {
    openTile(key);
    window.scrollTo({top: 0, behavior: 'instant'});
  };

  const filtered = useMemo(() => filterLines(data.lines, f).filter((l) => !gone.has(l.key)), [data.lines, f, gone]);
  const tiles = useMemo(() => hubTiles(filtered), [filtered]);
  const tile = tileKey ? (HUB_TIERS.flatMap((t) => tiles[t]).find((t) => t.key === tileKey) ?? null) : null;
  const lines = useMemo(() => (tileKey ? tileLines(filtered, tileKey) : []), [filtered, tileKey]);

  const say = (text: string, undo?: () => void) => setToast({id: Date.now(), text, undo});
  const fail = (text: string) => {
    setError(text);
    setToast(null);
  };

  const act: Act = {
    clear(l) {
      if (!l.id) return;
      setError(null);
      remove([l.key]);
      start(async () => {
        const res = await clearMarkAction({company, id: l.id as string});
        if (!res.ok) {
          restore([l.key]);
          return fail(res.error);
        }
        say('Flag cleared', () => act.reopen(l));
        router.refresh();
      });
    },
    reopen(l) {
      if (!l.id) return;
      setToast(null);
      restore([l.key]);
      start(async () => {
        const res = await reopenMarkAction({company, id: l.id as string});
        if (!res.ok) return fail(res.error);
        router.refresh();
      });
    },
    clearAll(all) {
      const marks = all.filter((l) => l.open && l.source !== 'check' && l.id);
      const ids = clearableIds(marks);
      if (!ids.length) return;
      setError(null);
      remove(marks.map((l) => l.key));
      start(async () => {
        const res = await setMarksAction({company, ids, open: false});
        if (!res.ok) {
          restore(marks.map((l) => l.key));
          return fail(res.error);
        }
        say(`${plural(res.count, 'flag')} cleared`, () => {
          setToast(null);
          restore(marks.map((l) => l.key));
          start(async () => {
            const back = await setMarksAction({company, ids, open: true});
            if (!back.ok) return fail(back.error);
            router.refresh();
          });
        });
        router.refresh();
      });
    },
    price(l, price) {
      if (!l.uploadId || !l.band) return;
      setError(null);
      const band = l.band;
      remove([l.key]);
      start(async () => {
        const res = await setBandPriceAction({company, uploadId: l.uploadId as string, group: band.group, price});
        if (!res.ok) {
          restore([l.key]);
          return fail(res.error);
        }
        say(`${peso(price)} kept for this form. Change it on the page before commit.`);
        router.refresh();
      });
    },
    async remark(l, remark) {
      if (!l.id) return 'That flag could not be found.';
      const res = await remarkFlagAction({company, id: l.id, remark});
      if (!res.ok) return res.error;
      say('Remark saved. The flag still counts against the BA.');
      router.refresh();
      return null;
    },
  };

  const filtersOn = Boolean(f.store || f.month || f.source || f.q);
  const reset = () => setF({store: null, month: null, source: null, open: 'all', q: ''});
  const csv = hubUrl(f, null, 1).replace(/^\/flags\??/, '');

  if (!data.configured) return <p className="py-16 text-center text-sm text-muted-foreground">Connect the database to see flags.</p>;

  return (
    <div ref={top} className="flex w-full min-w-0 max-w-[80rem] scroll-mt-24 flex-col gap-10 [--flag-info:#3d6a99] dark:[--flag-info:#8eb2d9]">
      <Filters data={data} f={f} setF={setF} filtersOn={filtersOn} reset={reset} csv={csv} />

      {error && (
        <p role="alert" className="-mt-4 text-sm text-destructive">
          {error}
        </p>
      )}

      {tileKey ? (
        <TileView
          tileKey={tileKey}
          tile={tile}
          lines={lines}
          page={page}
          setPage={setPage}
          onBack={closeTile}
          leave={leave}
          canEdit={canEdit}
          pending={pending}
          leaving={leaving}
          act={act}
        />
      ) : (
        <Overview tiles={tiles} total={filtered.length} filtersOn={filtersOn} reset={reset} onOpen={open} />
      )}

      <ToastBar toast={toast} onDone={() => setToast(null)} />
    </div>
  );
}

// ---------------------------------------------------------------------------------- Filters

function Filters({data, f, setF, filtersOn, reset, csv}: {data: FlagLinesData; f: FlagFilter; setF: (f: FlagFilter) => void; filtersOn: boolean; reset: () => void; csv: string}) {
  const monthOpts: Array<FilterOption<string>> = [{value: 'all', label: 'Every month'}, ...data.months.map((m) => ({value: m, label: monthName(m)}))];
  const storeOpts: Array<FilterOption<string>> = [{value: 'all', label: 'Every store'}, ...data.stores.map((s) => ({value: s.code, label: s.name ? `${titleName(s.name)} · ${s.code}` : s.code}))];
  const sourceOpts: Array<FilterOption<string>> = [{value: 'all', label: 'Checks and review flags'}, ...FLAG_SOURCES.map((s) => ({value: s, label: SOURCE_LABEL[s]}))];
  return (
    <div className="flex flex-wrap items-center gap-3">
      <FilterSelect label="Month" value={f.month ?? 'all'} defaultValue="all" options={monthOpts} onValueChange={(v) => setF({...f, month: v === 'all' ? null : v})} />
      <FilterSelect label="Store" value={f.store ?? 'all'} defaultValue="all" options={storeOpts} onValueChange={(v) => setF({...f, store: v === 'all' ? null : v})} />
      <FilterSelect label="Raised by" value={f.source ?? 'all'} defaultValue="all" options={sourceOpts} onValueChange={(v) => setF({...f, source: v === 'all' ? null : (v as FlagFilter['source'])})} />
      <label className="relative min-w-48 flex-1 sm:max-w-80">
        <span className="sr-only">Search flags</span>
        <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <input
          value={f.q}
          maxLength={80}
          onChange={(e) => setF({...f, q: e.target.value})}
          placeholder="Product, item code, BA or scan"
          className="h-8 w-full rounded-full border border-border bg-background pr-3 pl-8 text-xs outline-none transition-[border-color] duration-150 placeholder:text-muted-foreground pointer-fine:hover:border-foreground/25 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40"
        />
      </label>
      <div className="ml-auto flex items-center gap-4">
        {filtersOn && (
          <button type="button" onClick={reset} className="text-xs font-medium text-muted-foreground underline-offset-4 transition-colors duration-150 pointer-fine:hover:text-foreground pointer-fine:hover:underline">
            Clear filters
          </button>
        )}
        <a
          href={`/api/goldline/flag-lines-export${csv ? `?${csv}` : ''}`}
          className="inline-flex h-8 items-center gap-1.5 rounded-full border border-border bg-background px-3 text-xs font-medium transition-[border-color,scale] duration-150 active:scale-[0.97] pointer-fine:hover:border-foreground/25 motion-reduce:active:scale-100"
        >
          <Download aria-hidden className="size-3.5" /> Export CSV
        </a>
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------------- Overview

function Overview({tiles, total, filtersOn, reset, onOpen}: {tiles: Record<HubTier, HubTile[]>; total: number; filtersOn: boolean; reset: () => void; onOpen: (key: string) => void}) {
  if (!total) {
    return (
      <div className="flex flex-col items-center gap-3 py-20 text-center">
        <p className="text-sm text-muted-foreground">{filtersOn ? 'No flags match these filters.' : 'No flags yet. They show here once forms are read and checked.'}</p>
        {filtersOn && (
          <Button size="sm" variant="outline" onClick={reset}>
            Show every flag
          </Button>
        )}
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-start gap-x-14 gap-y-10">
      {tiles.needs.length === 0 && (
        <p className="flex w-full items-center gap-2.5 text-sm text-muted-foreground">
          <CircleCheck aria-hidden className="size-4 shrink-0 text-[var(--status-good)]" />
          {filtersOn ? 'Nothing in these filters needs you.' : 'Nothing needs you. Every band price and unreadable cell on pages in review is answered.'}
        </p>
      )}
      {HUB_TIERS.filter((t) => tiles[t].length > 0).map((tier) => {
        const count = tiles[tier].reduce((s, t) => s + t.count, 0);
        return (
          <section key={tier} aria-labelledby={`tier-${tier}`} className="flex flex-col gap-4 max-sm:w-full">
            <div className="flex flex-col gap-1">
              <h2 id={`tier-${tier}`} className="flex items-center gap-2.5 font-heading text-lg font-semibold tracking-tight">
                {tier === 'needs' && <OctagonAlert aria-hidden className="size-[1.125rem] text-[var(--status-crit)]" />}
                {TIER[tier].title}
                <span className="font-sans text-sm font-normal text-muted-foreground tabular-nums">{fmt(count)}</span>
              </h2>
              <p className="text-sm text-muted-foreground" title={TIER[tier].sub}>
                {TIER_HINT[tier]}
              </p>
            </div>
            <ul className="grid grid-cols-2 gap-4 sm:flex sm:flex-wrap">
              {tiles[tier].map((t) => (
                <li key={t.key} data-kept-id={keptId(t.key)} className="sm:w-[11.5rem]">
                  <TileButton t={t} onOpen={onOpen} />
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

/** A square tile: the kind's icon, one big number, its name, and where it is. */
function TileButton({t, onOpen}: {t: HubTile; onOpen: (key: string) => void}) {
  const meta = kindMeta(t.kind, t.tier);
  const needs = t.tier === 'needs';
  const quiet = t.tier === 'fyi' || t.tier === 'cleared';
  const where = [t.stores ? plural(t.stores, 'store') : null, t.pages ? plural(t.pages, 'page') : null].filter(Boolean).join(' · ');
  return (
    <button
      type="button"
      data-row
      title={where ? `${t.label} · ${where}` : t.label}
      onClick={() => onOpen(t.key)}
      className={cn(
        'group/tile relative flex aspect-square w-full flex-col rounded-2xl border p-4.5 text-left outline-none',
        'transition-[border-color,background-color,box-shadow,translate,scale] duration-200',
        EASE,
        'pointer-fine:hover:-translate-y-0.5 pointer-fine:hover:shadow-[0_14px_32px_-18px_color-mix(in_oklab,var(--foreground)_35%,transparent)] active:translate-y-0 active:scale-[0.98] active:duration-100',
        'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        'motion-reduce:pointer-fine:hover:translate-y-0 motion-reduce:active:scale-100',
        needs
          ? 'border-[color-mix(in_oklab,var(--status-warn)_34%,transparent)] bg-[color-mix(in_oklab,var(--status-warn)_9%,var(--card))] pointer-fine:hover:border-[color-mix(in_oklab,var(--status-warn)_55%,transparent)]'
          : quiet
            ? 'border-border bg-transparent pointer-fine:hover:border-foreground/25 pointer-fine:hover:bg-card'
            : 'border-border bg-card pointer-fine:hover:border-primary/40',
      )}
    >
      <span className="flex items-start justify-between gap-3">
        <IconChip kind={t.kind} tone={meta.tone} />
        <ArrowUpRight
          aria-hidden
          className={cn('size-4 text-muted-foreground/60 transition-[translate,color] duration-200 group-hover/tile:translate-x-0.5 group-hover/tile:-translate-y-0.5 group-hover/tile:text-foreground motion-reduce:group-hover/tile:translate-0', EASE)}
        />
      </span>
      <span className={cn('mt-3 font-heading text-[2.25rem] leading-none font-semibold tracking-tight tabular-nums', quiet && 'text-foreground/70')}>{fmt(t.count)}</span>
      <span className="mt-auto flex min-w-0 flex-col gap-1">
        <span className="line-clamp-2 text-[0.8125rem] leading-snug font-medium text-balance">{t.label}</span>
        <TodoPill meta={meta} className="mt-0.5 self-start" />
      </span>
    </button>
  );
}

// -------------------------------------------------------------------------------- Tile view

type ViewProps = {canEdit: boolean; pending: boolean; leaving: Set<string>; act: Act};
type Leave = (rowId: string | null, href: string, label?: string | null) => void;

function TileView({
  tileKey,
  tile,
  lines,
  page,
  setPage,
  onBack,
  leave,
  ...rest
}: {tileKey: string; tile: HubTile | null; lines: FlagLine[]; page: number; setPage: (p: number) => void; onBack: () => void; leave: Leave} & ViewProps) {
  const [confirm, setConfirm] = useState(false);
  const paged = pageOf(lines, page);
  const kind = tile?.kind ?? (tileKey === CLEARED_TILE ? null : tileKey.slice(tileKey.indexOf('.') + 1));
  const tier = tile?.tier ?? (tileKey.split('.')[0] as HubTier);
  const meta = kindMeta(kind, tier);
  const label = tile?.label ?? (tileKey === CLEARED_TILE ? 'Cleared and resolved' : 'Flags');
  const ids = clearableIds(lines);
  const needs = tile?.tier === 'needs';
  const mixed = tileKey === CLEARED_TILE;

  return (
    <section aria-labelledby="tile-title" className="flex flex-col gap-6">
      <div className="flex flex-col gap-5">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex w-fit items-center gap-1.5 rounded-md text-sm font-medium text-muted-foreground outline-none transition-colors duration-150 pointer-fine:hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/40"
        >
          <ArrowLeft aria-hidden className="size-4" /> All flags
        </button>
        <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
          <div className="flex min-w-0 items-start gap-4">
            <IconChip kind={kind} tone={meta.tone} size="lg" />
            <div className="flex min-w-0 flex-col gap-1.5">
              <h2 id="tile-title" className="flex flex-wrap items-baseline gap-x-3 font-heading text-xl font-semibold tracking-tight">
                {label}
                <span className="font-sans text-sm font-normal text-muted-foreground tabular-nums">
                  {[plural(lines.length, 'flag'), tile?.stores ? plural(tile.stores, 'store') : null, tile?.pages ? plural(tile.pages, 'page') : null].filter(Boolean).join(' · ')}
                </span>
              </h2>
              <p className="max-w-2xl text-sm text-muted-foreground">{tile ? tileNote(tile) : 'Nothing left here with these filters.'}</p>
              {!mixed && (
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  <TodoPill meta={meta} />
                  {meta.cause && (
                    <span className="inline-flex items-center rounded-full border border-border px-2 py-0.5 text-[0.6875rem] leading-4 font-medium text-muted-foreground">
                      Scorecard: {meta.cause}
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>
          {/* Not on Needs you: clearing an unanswered price skips the decision it asks for. */}
          {rest.canEdit && !needs && ids.length > 1 && (
            <div className="flex items-center gap-2">
              {confirm ? (
                <>
                  <span className="text-xs text-muted-foreground">Clear {plural(ids.length, 'flag')}?</span>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={rest.pending}
                    onClick={() => {
                      setConfirm(false);
                      rest.act.clearAll(lines);
                    }}
                  >
                    Clear
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setConfirm(false)}>
                    Cancel
                  </Button>
                </>
              ) : (
                <Button size="sm" variant="outline" onClick={() => setConfirm(true)}>
                  Clear all {fmt(ids.length)}
                </Button>
              )}
            </div>
          )}
        </div>
      </div>

      {lines.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-border py-16 text-center">
          <CircleCheck aria-hidden className="size-5 text-[var(--status-good)]" />
          <p className="text-sm text-muted-foreground">All done here.</p>
          <Button size="sm" variant="outline" onClick={onBack}>
            Back to all flags
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="overflow-hidden rounded-2xl border border-border bg-card">
            <div aria-hidden className="hidden grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)_minmax(0,0.75fr)_13rem] gap-6 border-b border-border px-6 py-3 text-xs text-muted-foreground md:grid">
              <span>{mixed ? 'Flag' : 'Product'}</span>
              <span>Store and page</span>
              <span>BA</span>
              <span />
            </div>
            <ul>
              {paged.rows.map((l) => (
                <Row key={l.key} l={l} mixed={mixed} onOpen={(href) => leave(l.key, href, label)} {...rest} />
              ))}
            </ul>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="text-xs text-muted-foreground tabular-nums">
              {paged.pageCount > 1 ? `${fmt(paged.from)} to ${fmt(paged.to)} of ${fmt(lines.length)}` : plural(lines.length, 'flag')}
            </span>
            <Pagination page={paged.page} pageCount={paged.pageCount} onPage={setPage} label="Flag pages" variant="segmented" />
          </div>
        </div>
      )}
    </section>
  );
}

/** What Coop saw for a check, or the reader's or reviewer's words for a mark. */
function reasonOf(l: FlagLine): string | null {
  if (l.source === 'check') return l.details && l.kind ? explain({kind: l.kind, details: l.details} as unknown as FlagRow) : null;
  if (!l.note) return null;
  return l.source === 'reviewer' ? `“${l.note}”` : l.note;
}

function Row({l, mixed, onOpen, canEdit, pending, leaving, act}: {l: FlagLine; mixed: boolean; onOpen: (href: string) => void} & ViewProps) {
  const [editing, setEditing] = useState(false);
  const out = leaving.has(l.key);
  const isCheck = l.source === 'check';
  const reason = reasonOf(l);
  const meta = lineMeta(l);
  const head = mixed ? l.why : (l.product ?? (l.itemCode ? l.itemCode : 'Whole page'));
  const sub = mixed ? [l.product, reason].filter(Boolean).join(' · ') : reason;
  const store = l.storeName ? titleName(l.storeName) : l.storeCode ? `Store ${l.storeCode}` : 'Store not known yet';
  const where = [l.page != null ? (l.pageOf ? `Page ${l.page} of ${l.pageOf}` : `Page ${l.page}`) : null, l.file].filter(Boolean).join(' · ');
  const status = l.open ? null : isCheck ? 'Resolved, still counts' : 'Cleared';

  return (
    <li
      data-kept-id={keptId(l.key)}
      className={cn(
        'grid grid-cols-[minmax(0,1fr)] border-b border-border/70 transition-[grid-template-rows,opacity] duration-200 last:border-b-0 motion-reduce:transition-none',
        EASE,
        out ? 'grid-rows-[0fr] opacity-0' : 'grid-rows-[1fr]',
      )}
    >
      <div className="min-h-0 min-w-0 overflow-hidden">
        <div className="grid grid-cols-1 gap-x-6 gap-y-2.5 px-5 py-4 transition-colors duration-150 pointer-fine:hover:bg-muted/40 sm:px-6 md:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)_minmax(0,0.75fr)_13rem] md:items-center md:py-3.5">
          <div className="flex min-w-0 flex-col gap-0.5">
            <p className={cn('truncate text-sm font-medium', !l.open && 'text-muted-foreground')} title={head}>
              {head}
              {status && <span className="ml-2 text-xs font-normal text-muted-foreground">{status}</span>}
            </p>
            <div className="mt-0.5 flex min-w-0 items-start gap-2">
              <TodoPill meta={meta} className="mt-px" />
              {sub && <p className="line-clamp-2 min-w-0 text-[0.8125rem] leading-snug text-muted-foreground">{sub}</p>}
            </div>
            {isCheck && l.note && <p className="truncate text-[0.8125rem] text-foreground/75">Remark: {l.note}</p>}
          </div>
          <div className="flex min-w-0 flex-col gap-0.5">
            <p className="truncate text-sm" title={l.storeName ?? undefined}>
              {store}
            </p>
            {where && (
              <p className="truncate text-xs text-muted-foreground" title={where}>
                {where}
              </p>
            )}
          </div>
          <div className="flex min-w-0 flex-col gap-0.5 max-md:flex-row max-md:gap-2">
            <p className="truncate text-sm max-md:text-xs max-md:text-muted-foreground">{l.ba ? titleName(l.ba) : <span className="text-muted-foreground">No BA read</span>}</p>
            {l.month && <p className="text-xs text-muted-foreground tabular-nums">{monthShort(l.month)}</p>}
          </div>
          <div className="flex items-center gap-2 md:justify-end">
            <Actions l={l} canEdit={canEdit} pending={pending} act={act} editing={editing} setEditing={setEditing} />
            {l.uploadId && (
              <Link
                href={`/uploads/${l.uploadId}?from=flags`}
                onClick={() => onOpen(`/uploads/${l.uploadId}`)}
                aria-label={`Open ${where || 'the page'}`}
                title="Open page"
                className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors duration-150 pointer-fine:hover:bg-muted pointer-fine:hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/40"
              >
                <ArrowUpRight aria-hidden className="size-4" />
              </Link>
            )}
          </div>
        </div>
        {isCheck && <RemarkEditor open={editing} l={l} act={act} onClose={() => setEditing(false)} />}
      </div>
    </li>
  );
}

function Actions({l, canEdit, pending, act, editing, setEditing}: {l: FlagLine; canEdit: boolean; pending: boolean; act: Act; editing: boolean; setEditing: (v: boolean) => void}) {
  if (!canEdit) return null;
  if (l.source === 'check') {
    if (!l.open) return null;
    return (
      <Button size="sm" variant="ghost" aria-expanded={editing} onClick={() => setEditing(!editing)}>
        {l.note ? 'Edit remark' : 'Remark'}
      </Button>
    );
  }
  if (!l.open) {
    return (
      <Button size="sm" variant="ghost" disabled={pending} onClick={() => act.reopen(l)}>
        Reopen
      </Button>
    );
  }
  if (l.band) {
    const b = l.band;
    return (
      <span className="inline-flex items-center rounded-lg border border-border p-0.5">
        <button
          type="button"
          disabled={pending}
          onClick={() => act.price(l, b.offer)}
          className="h-7 rounded-md bg-primary px-2.5 text-xs font-medium text-primary-foreground tabular-nums transition-[opacity,scale] duration-150 active:scale-[0.97] disabled:opacity-50 motion-reduce:active:scale-100"
        >
          Use {peso(b.offer)}
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => act.price(l, b.printed)}
          className="h-7 rounded-md px-2.5 text-xs font-medium text-muted-foreground tabular-nums transition-[background-color,color,scale] duration-150 pointer-fine:hover:bg-muted pointer-fine:hover:text-foreground active:scale-[0.97] disabled:opacity-50 motion-reduce:active:scale-100"
        >
          Keep {peso(b.printed)}
        </button>
      </span>
    );
  }
  return (
    <Button size="sm" variant="ghost" disabled={pending} onClick={() => act.clear(l)}>
      Clear
    </Button>
  );
}

/** A remark on a check, inline under its row. It never changes the count. */
function RemarkEditor({open, l, act, onClose}: {open: boolean; l: FlagLine; act: Act; onClose: () => void}) {
  const [text, setText] = useState(l.note ?? '');
  const [err, setErr] = useState<string | null>(null);
  const [saving, start] = useTransition();
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open) ref.current?.focus();
  }, [open]);
  const save = () =>
    start(async () => {
      const e = await act.remark(l, text);
      setErr(e);
      if (!e) onClose();
    });
  return (
    <div className={cn('grid grid-cols-[minmax(0,1fr)] transition-[grid-template-rows] duration-200 motion-reduce:transition-none', EASE, open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]')} inert={!open}>
      <div className="min-h-0 overflow-hidden">
        <form
          className="flex flex-col gap-2 px-5 pb-4 sm:px-6"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={ref}
              value={text}
              maxLength={500}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => e.key === 'Escape' && onClose()}
              placeholder="What you found, for the next person"
              aria-label="Remark"
              className="h-9 min-w-0 flex-1 rounded-lg border border-border bg-background px-3 text-sm outline-none transition-[border-color] duration-150 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40"
            />
            <Button size="sm" type="submit" disabled={saving || !text.trim()}>
              Save remark
            </Button>
            <Button size="sm" type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
          </div>
          <p className={cn('text-xs', err ? 'text-destructive' : 'text-muted-foreground')}>{err ?? 'The flag still counts against the BA.'}</p>
        </form>
      </div>
    </div>
  );
}

/** One toast at a time, bottom centre, with Undo when the action can be taken back. */
function ToastBar({toast, onDone}: {toast: Toast | null; onDone: () => void}): ReactNode {
  const [shown, setShown] = useState<Toast | null>(toast);
  useEffect(() => {
    if (toast) setShown(toast);
    if (!toast) return;
    const t = window.setTimeout(onDone, 5000);
    return () => window.clearTimeout(t);
  }, [toast, onDone]);
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        'fixed bottom-[max(1.5rem,env(safe-area-inset-bottom))] left-1/2 z-50 flex -translate-x-1/2 items-center gap-5 rounded-xl bg-foreground px-4 py-3 text-sm text-background shadow-[0_12px_32px_-12px_color-mix(in_oklab,var(--foreground)_45%,transparent)]',
        'transition-[opacity,translate] duration-200 motion-reduce:transition-opacity',
        EASE,
        toast ? 'translate-y-0 opacity-100' : 'pointer-events-none translate-y-2 opacity-0',
      )}
    >
      <span>{shown?.text}</span>
      {shown?.undo && (
        <button type="button" onClick={shown.undo} className="font-semibold underline underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-background/60">
          Undo
        </button>
      )}
    </div>
  );
}
