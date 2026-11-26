'use client';

// All flags (Flags hub P0, Nov 26): every check, reader and reviewer flag for the company in
// one place, laid out so the eye knows where to start. Plan:
// knowledge/tasks/2026-11-26-nichido-flags-hub.md.
//
// - Needs you is the only tinted surface (Von Restorff): an unanswered band price or an
//   unreadable cell on a page still in review. Answer it here.
// - Then Open, grouped by kind, five lines a group until "Show all" (Hick's law); then the
//   quiet tiers, For your information and Cleared, collapsed.
// - Each line shows at most one contextual action and Open page. Checks take a remark, never
//   a clear: they always count against the BA (Oct 26). Review flags never do.
// - Filters live in the URL (replaceState, no server round trip per keystroke), so a view can
//   be shared and the CSV takes the same filters.

import {useEffect, useMemo, useRef, useState, useTransition} from 'react';
import type {ReactNode} from 'react';
import Link from 'next/link';
import {useRouter} from 'next/navigation';
import {
  ArrowLeftRight,
  ArrowUpRight,
  Calculator,
  ChevronDown,
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
import {FLAG_SOURCES, SOURCE_LABEL, filterLines, type FlagFilter, type FlagLine} from '@/src/goldline-flag-lines';
import type {FlagLinesData} from '@/src/goldline-flag-lines-data';
import {clearableIds, hubView, kindKey, lineTitle, visibleKinds, type HubGroup} from '@/src/goldline-flag-hub';
import {peso} from '@/src/band-prices';
import {remarkFlagAction} from '@/app/flags/actions';
import {clearMarkAction, reopenMarkAction, setMarksAction} from '@/app/uploads/review-marks-actions';
import {setBandPriceAction} from '@/app/uploads/actions';
import {explain} from '@/components/analyst/goldline-flags';
import type {FlagRow} from '@/src/goldline-flags-data';

const GROUP_PEEK = 5;
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
const iconOf = (l: FlagLine) => ICON[kindKey(l)] ?? Flag;

const monthName = (m: string) => {
  const [y, mo] = m.split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1, 1)).toLocaleDateString('en-US', {month: 'long', year: 'numeric', timeZone: 'UTC'});
};
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

function toQuery(f: FlagFilter, kind: string | null): string {
  const sp = new URLSearchParams();
  if (f.store) sp.set('store', f.store);
  if (f.month) sp.set('month', f.month);
  if (f.source) sp.set('source', f.source);
  if (f.q) sp.set('q', f.q);
  if (kind) sp.set('kind', kind);
  return sp.toString();
}

type Toast = {id: number; text: string; undo?: () => void};

export function FlagsHub({data, initial, initialKind, company, canEdit}: {data: FlagLinesData; initial: FlagFilter; initialKind: string | null; company: string; canEdit: boolean}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [f, setF] = useState<FlagFilter>({...initial, open: 'all'});
  const [kind, setKind] = useState<string | null>(initialKind);
  const [allKinds, setAllKinds] = useState(false);
  // Lines on their way out (fading) and gone (removed until the server agrees).
  const [leaving, setLeaving] = useState<Set<string>>(new Set());
  const [gone, setGone] = useState<Set<string>>(new Set());
  const [toast, setToast] = useState<Toast | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const q = toQuery(f, kind);
    window.history.replaceState(null, '', `/flags${q ? `?${q}` : ''}`);
  }, [f, kind]);

  // A server refresh brings lines back in their real state; forget the local removals.
  useEffect(() => {
    setGone(new Set());
    setLeaving(new Set());
  }, [data]);

  const filtered = useMemo(() => filterLines(data.lines, f).filter((l) => !gone.has(l.key)), [data.lines, f, gone]);
  const view = useMemo(() => hubView(filtered, kind), [filtered, kind]);
  const chips = visibleKinds(view.kinds, kind, 5);
  const openTotal = view.kinds.reduce((s, k) => s + k.count, 0);

  const say = (text: string, undo?: () => void) => setToast({id: Date.now(), text, undo});
  const fail = (text: string) => {
    setError(text);
    setToast(null);
  };

  /** Fade lines out, then drop them; the action runs alongside. */
  const remove = (keys: string[]) => {
    setLeaving((s) => new Set([...s, ...keys]));
    window.setTimeout(() => setGone((s) => new Set([...s, ...keys])), 200);
  };
  const restore = (keys: string[]) => {
    setGone((s) => new Set([...s].filter((k) => !keys.includes(k))));
    setLeaving((s) => new Set([...s].filter((k) => !keys.includes(k))));
  };

  const act = {
    clear(l: FlagLine) {
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
    reopen(l: FlagLine) {
      if (!l.id) return;
      setToast(null);
      restore([l.key]);
      start(async () => {
        const res = await reopenMarkAction({company, id: l.id as string});
        if (!res.ok) return fail(res.error);
        router.refresh();
      });
    },
    clearAll(g: HubGroup) {
      const lines = g.lines.filter((l) => l.open && l.source !== 'check' && l.id);
      const ids = clearableIds(lines);
      if (!ids.length) return;
      setError(null);
      remove(lines.map((l) => l.key));
      start(async () => {
        const res = await setMarksAction({company, ids, open: false});
        if (!res.ok) {
          restore(lines.map((l) => l.key));
          return fail(res.error);
        }
        say(`${plural(res.count, 'flag')} cleared`, () => {
          setToast(null);
          restore(lines.map((l) => l.key));
          start(async () => {
            const back = await setMarksAction({company, ids, open: true});
            if (!back.ok) return fail(back.error);
            router.refresh();
          });
        });
        router.refresh();
      });
    },
    price(l: FlagLine, price: number) {
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
    async remark(l: FlagLine, remark: string): Promise<string | null> {
      if (!l.id) return 'That flag could not be found.';
      const res = await remarkFlagAction({company, id: l.id, remark});
      if (!res.ok) return res.error;
      say('Remark saved. The flag still counts against the BA.');
      router.refresh();
      return null;
    },
  };

  const filtersOn = Boolean(f.store || f.month || f.source || f.q || kind);
  const reset = () => {
    setF({store: null, month: null, source: null, open: 'all', q: ''});
    setKind(null);
  };
  const csv = toQuery(f, null);

  const monthOpts: Array<FilterOption<string>> = [{value: 'all', label: 'Every month'}, ...data.months.map((m) => ({value: m, label: monthName(m)}))];
  const storeOpts: Array<FilterOption<string>> = [{value: 'all', label: 'Every store'}, ...data.stores.map((s) => ({value: s.code, label: s.name ? `${s.name} · ${s.code}` : s.code}))];
  const sourceOpts: Array<FilterOption<string>> = [{value: 'all', label: 'Checks and review flags'}, ...FLAG_SOURCES.map((s) => ({value: s, label: SOURCE_LABEL[s]}))];

  if (!data.configured) return <p className="py-16 text-center text-sm text-muted-foreground">Connect the database to see flags.</p>;

  return (
    <div className="flex w-full max-w-[76rem] min-w-0 flex-col gap-12">
      {/* Filters: three pills and a search (Hick's law); the CSV takes the same filters. */}
      <div className="flex flex-col gap-5">
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

        {view.kinds.length > 0 && (
          <div
            role="group"
            aria-label="Kind of flag"
            className="flex flex-wrap items-center gap-2 max-md:-mx-4 max-md:flex-nowrap max-md:overflow-x-auto max-md:px-4 max-md:pb-1 max-md:[scrollbar-width:none] max-md:[&::-webkit-scrollbar]:hidden max-md:[&>button]:shrink-0"
          >
            <KindChip label="All open" count={openTotal} on={!kind} onClick={() => setKind(null)} />
            {(allKinds ? view.kinds : chips.shown).map((k) => (
              <KindChip key={k.key} label={k.label} count={k.count} on={kind === k.key} onClick={() => setKind(kind === k.key ? null : k.key)} />
            ))}
            {!allKinds && chips.more > 0 && (
              <button type="button" onClick={() => setAllKinds(true)} className="h-8 rounded-full px-3 text-xs font-medium text-muted-foreground transition-colors duration-150 pointer-fine:hover:text-foreground">
                +{chips.more} more
              </button>
            )}
          </div>
        )}
      </div>

      {error && (
        <p role="alert" className="-mt-6 text-sm text-destructive">
          {error}
        </p>
      )}

      <NeedsYou lines={view.needs} canEdit={canEdit} pending={pending} leaving={leaving} act={act} filtersOn={filtersOn} />

      {view.counts.open > 0 && (
        <section aria-labelledby="hub-open" className="flex flex-col gap-8">
          <TierHead id="hub-open" title="Open" count={view.counts.open} sub="Coop’s checks count against the BA and can take a remark. Review flags never count." />
          {view.open.map((g) => (
            <Group key={g.key} g={g} canEdit={canEdit} pending={pending} leaving={leaving} act={act} />
          ))}
        </section>
      )}

      {view.counts.fyi > 0 && (
        <Disclosure title="For your information" count={view.counts.fyi} sub="Notes, relabelled columns and products written in. Worth knowing, nothing to fix." defaultOpen={kind != null}>
          {view.fyi.map((g) => (
            <Group key={g.key} g={g} canEdit={canEdit} pending={pending} leaving={leaving} act={act} />
          ))}
        </Disclosure>
      )}

      {view.counts.cleared > 0 && (
        <Disclosure title="Cleared and resolved" count={view.counts.cleared} sub="A resolved check still counts against the BA; the form was wrong when written.">
          <Peek lines={view.cleared} canEdit={canEdit} pending={pending} leaving={leaving} act={act} />
        </Disclosure>
      )}

      {filtered.length === 0 && (
        <div className="flex flex-col items-center gap-3 py-16 text-center">
          <p className="text-sm text-muted-foreground">{filtersOn ? 'No flags match these filters.' : 'No flags yet. They show here once forms are read and checked.'}</p>
          {filtersOn && (
            <Button size="sm" variant="outline" onClick={reset}>
              Show every flag
            </Button>
          )}
        </div>
      )}

      <ToastBar toast={toast} onDone={() => setToast(null)} />
    </div>
  );
}

type Act = {
  clear: (l: FlagLine) => void;
  reopen: (l: FlagLine) => void;
  clearAll: (g: HubGroup) => void;
  price: (l: FlagLine, price: number) => void;
  remark: (l: FlagLine, remark: string) => Promise<string | null>;
};
type LineProps = {canEdit: boolean; pending: boolean; leaving: Set<string>; act: Act; /** Inside a kind group the kind is the heading, so the line leads with its reason. */ grouped?: boolean};

function KindChip({label, count, on, onClick}: {label: string; count: number; on: boolean; onClick: () => void}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={cn(
        'inline-flex h-8 items-center gap-2 rounded-full border px-3.5 text-xs font-medium outline-none transition-[background-color,border-color,color,scale] duration-150 active:scale-[0.97] motion-reduce:active:scale-100',
        'focus-visible:ring-3 focus-visible:ring-ring/40',
        on ? 'border-foreground bg-foreground text-background' : 'border-border text-foreground pointer-fine:hover:border-foreground/30',
      )}
    >
      {label}
      <span className={cn('tabular-nums', on ? 'opacity-70' : 'text-muted-foreground')}>{count.toLocaleString('en-US')}</span>
    </button>
  );
}

function TierHead({id, title, count, sub}: {id: string; title: string; count: number; sub: string}) {
  return (
    <div className="flex flex-col gap-1.5">
      <h2 id={id} className="flex items-baseline gap-3 font-heading text-lg font-semibold tracking-tight">
        {title}
        <span className="font-sans text-sm font-normal text-muted-foreground tabular-nums">{count.toLocaleString('en-US')}</span>
      </h2>
      <p className="text-sm text-muted-foreground">{sub}</p>
    </div>
  );
}

/** The one highlighted surface. Quiet and reassuring when empty. */
function NeedsYou({lines, filtersOn, ...rest}: {lines: FlagLine[]; filtersOn: boolean} & LineProps) {
  if (!lines.length) {
    return (
      <p className="-mt-4 flex items-center gap-2.5 text-sm text-muted-foreground">
        <CircleCheck aria-hidden className="size-4 shrink-0 text-[var(--status-good)]" />
        {filtersOn ? 'Nothing in these filters needs you.' : 'Nothing needs you. Every band price and unreadable cell on pages in review is answered.'}
      </p>
    );
  }
  return (
    <section
      aria-labelledby="hub-needs"
      className="flex flex-col gap-6 rounded-2xl border border-[color-mix(in_oklab,var(--status-warn)_30%,transparent)] bg-[color-mix(in_oklab,var(--status-warn)_8%,var(--card))] p-5 sm:p-7"
    >
      <div className="flex flex-col gap-1.5">
        <h2 id="hub-needs" className="flex items-center gap-2.5 font-heading text-lg font-semibold tracking-tight">
          <OctagonAlert aria-hidden className="size-[1.125rem] text-[var(--status-crit)]" />
          Needs you
          <span className="font-sans text-sm font-normal text-[color-mix(in_oklab,var(--foreground)_70%,var(--status-warn))] tabular-nums">{lines.length.toLocaleString('en-US')}</span>
        </h2>
        <p className="text-sm text-[color-mix(in_oklab,var(--foreground)_72%,var(--status-warn))]">
          Answer these before the pages are committed, or the form is valued and checked on a guess.
        </p>
      </div>
      <Peek lines={lines} {...rest} />
    </section>
  );
}

/** The first five lines, the rest one click away (Hick's law). */
function Peek({lines, ...rest}: {lines: FlagLine[]} & LineProps) {
  const [all, setAll] = useState(false);
  return (
    <div className="flex flex-col gap-3.5">
      <Lines lines={all ? lines : lines.slice(0, GROUP_PEEK)} {...rest} />
      {lines.length > GROUP_PEEK && (
        <button type="button" onClick={() => setAll(!all)} className="w-fit text-xs font-medium text-muted-foreground transition-colors duration-150 pointer-fine:hover:text-foreground">
          {all ? 'Show fewer' : `Show all ${lines.length.toLocaleString('en-US')}`}
        </button>
      )}
    </div>
  );
}

function Group({g, ...rest}: {g: HubGroup} & LineProps) {
  const [confirm, setConfirm] = useState(false);
  const ids = clearableIds(g.lines);
  const Icon = iconOf(g.lines[0]);
  return (
    <div className="flex flex-col gap-3.5">
      <div className="flex min-h-8 flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <h3 className="flex items-center gap-2.5 text-[0.9375rem] font-semibold">
          <Icon aria-hidden className="size-4 text-muted-foreground" />
          {g.label}
          <span className="font-normal text-muted-foreground tabular-nums">{g.lines.length.toLocaleString('en-US')}</span>
        </h3>
        {rest.canEdit && ids.length > 1 &&
          (confirm ? (
            <span className="flex items-center gap-2 text-xs">
              <span className="text-muted-foreground">Clear {plural(ids.length, 'flag')}?</span>
              <Button
                size="sm"
                variant="outline"
                disabled={rest.pending}
                onClick={() => {
                  setConfirm(false);
                  rest.act.clearAll(g);
                }}
              >
                Clear
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirm(false)}>
                Cancel
              </Button>
            </span>
          ) : (
            <button type="button" onClick={() => setConfirm(true)} className="text-xs font-medium text-muted-foreground transition-colors duration-150 pointer-fine:hover:text-foreground">
              Clear all {ids.length.toLocaleString('en-US')}
            </button>
          ))}
      </div>
      <Peek lines={g.lines} {...rest} grouped />
    </div>
  );
}

function Lines({lines, ...rest}: {lines: FlagLine[]} & LineProps) {
  return (
    <ul className="overflow-hidden rounded-xl border border-border bg-card">
      {lines.map((l) => (
        <Line key={l.key} l={l} {...rest} />
      ))}
    </ul>
  );
}

function Line({l, canEdit, pending, leaving, act, grouped = false}: {l: FlagLine} & LineProps) {
  const [editing, setEditing] = useState(false);
  const Icon = iconOf(l);
  const out = leaving.has(l.key);
  const isCheck = l.source === 'check';
  const meta = [l.product ?? (l.itemCode ? l.itemCode : null), l.ba ? `BA ${l.ba}` : null, SOURCE_LABEL[l.source], l.file, l.month ? monthName(l.month) : null].filter(Boolean).join(' · ');
  // What Coop saw for a check; the reader's or reviewer's words for a mark.
  const reason = isCheck ? (l.details && l.kind ? explain({kind: l.kind, details: l.details} as unknown as FlagRow) : null) : l.note ? (l.source === 'reviewer' ? `“${l.note}”` : l.note) : null;
  const remark = isCheck && l.note ? `Remark: ${l.note}` : null;
  const lead = grouped ? (reason ?? l.why) : l.why;
  const detail = grouped ? remark : [reason, remark].filter(Boolean).join(' ') || null;
  const status = l.open ? null : isCheck ? 'Resolved, still counts against the BA' : 'Cleared';

  return (
    <li
      data-leaving={out || undefined}
      className={cn(
        'grid grid-cols-[minmax(0,1fr)] border-b border-border/70 transition-[grid-template-rows,opacity] duration-200 last:border-b-0 motion-reduce:transition-none',
        EASE,
        out ? 'grid-rows-[0fr] opacity-0' : 'grid-rows-[1fr]',
      )}
    >
      <div className="min-h-0 min-w-0 overflow-hidden">
        <div className="grid min-h-[4.75rem] grid-cols-1 items-center gap-x-8 gap-y-3 px-5 py-[1.125rem] sm:px-6 md:grid-cols-[minmax(0,1fr)_auto]">
          <div className="flex min-w-0 flex-col gap-1">
            <p className={cn('truncate text-[0.9375rem] font-medium', !l.open && 'text-muted-foreground')} title={lineTitle(l)}>
              {lineTitle(l)}
            </p>
            <p className="flex items-center gap-2 text-sm">
              <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
              <span>{lead}</span>
              {status && <span className="text-muted-foreground">· {status}</span>}
            </p>
            {detail && <p className="text-[0.8125rem] leading-relaxed text-foreground/80">{detail}</p>}
            {meta && <p className="text-[0.8125rem] leading-relaxed text-muted-foreground">{meta}</p>}
          </div>
          <div className="flex flex-wrap items-center gap-2 md:justify-end">
            <Actions l={l} canEdit={canEdit} pending={pending} act={act} editing={editing} setEditing={setEditing} />
            {l.uploadId && (
              <Link
                href={`/uploads/${l.uploadId}`}
                className="inline-flex h-8 items-center gap-1 rounded-md px-2.5 text-xs font-medium text-muted-foreground transition-colors duration-150 pointer-fine:hover:bg-muted pointer-fine:hover:text-foreground"
              >
                Open page <ArrowUpRight aria-hidden className="size-3.5" />
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
      <Button size="sm" variant="outline" aria-expanded={editing} onClick={() => setEditing(!editing)}>
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
      <>
        <Button size="sm" disabled={pending} onClick={() => act.price(l, b.offer)}>
          Use {peso(b.offer)}
        </Button>
        <Button size="sm" variant="outline" disabled={pending} onClick={() => act.price(l, b.printed)}>
          Keep {peso(b.printed)}
        </Button>
      </>
    );
  }
  return (
    <Button size="sm" variant="outline" disabled={pending} onClick={() => act.clear(l)}>
      Clear
    </Button>
  );
}

/** A remark on a check, inline under its line. It never changes the count. */
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
          className="flex flex-col gap-2 px-5 pb-5 sm:px-6"
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

function Disclosure({title, count, sub, defaultOpen = false, children}: {title: string; count: number; sub: string; defaultOpen?: boolean; children: ReactNode}) {
  const [open, setOpen] = useState(defaultOpen);
  useEffect(() => setOpen(defaultOpen), [defaultOpen]);
  return (
    <section className="flex flex-col gap-8 border-t border-border pt-8">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="group flex w-full items-start justify-between gap-6 text-left outline-none focus-visible:rounded-md focus-visible:ring-3 focus-visible:ring-ring/40">
        <span className="flex flex-col gap-1.5">
          <span className="flex items-baseline gap-3 font-heading text-lg font-semibold tracking-tight">
            {title}
            <span className="font-sans text-sm font-normal text-muted-foreground tabular-nums">{count.toLocaleString('en-US')}</span>
          </span>
          <span className="text-sm text-muted-foreground">{sub}</span>
        </span>
        <span className="mt-0.5 inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-border px-3 text-xs font-medium transition-[border-color] duration-150 pointer-fine:group-hover:border-foreground/30">
          {open ? 'Hide' : 'Show'}
          <ChevronDown aria-hidden className={cn('size-3.5 transition-transform duration-200 motion-reduce:transition-none', EASE, open && 'rotate-180')} />
        </span>
      </button>
      {open && <div className="flex flex-col gap-8">{children}</div>}
    </section>
  );
}

/** One toast at a time, bottom centre, with Undo when the action can be taken back. */
function ToastBar({toast, onDone}: {toast: Toast | null; onDone: () => void}) {
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
