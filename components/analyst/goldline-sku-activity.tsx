'use client';

import {useMemo, useState} from 'react';
import Link from 'next/link';
import {useSearchParams} from 'next/navigation';
import {Archive, ArchiveRestore, ArrowLeft, Check, ChevronRight, History, Link2, MessageSquare, NotebookPen, RotateCcw, Search, Unlink, X} from 'lucide-react';
import type {ActivityEvent, ActivityKind} from '@/src/goldline-sku-activity';
import {GL_PAGE} from '@/src/goldline-ui';
import {cn} from '@/lib/utils';

// SKU linking activity (Oct 29). "Recent activity" sits beside the cards and numbers table
// with the 5 latest changes; "See all" opens the whole trail on its own page
// (/stock/skus/activity, grouped by day, searchable) with a way back. Clicking an entry
// goes to that SKU or item on SKU linking, in the view it is in now.

const ICON: Record<ActivityKind, typeof Check> = {
  approved: Check,
  rejected: X,
  linked: Link2,
  unlinked: Unlink,
  remark: MessageSquare,
  decommissioned: Archive,
  restored: ArchiveRestore,
  note: NotebookPen,
  note_removed: NotebookPen,
  undo: RotateCcw,
};
const TONE: Record<ActivityKind, string> = {
  approved: 'var(--status-good)',
  linked: 'var(--status-good)',
  restored: 'var(--status-good)',
  rejected: 'var(--status-crit)',
  unlinked: 'var(--status-crit)',
  decommissioned: 'var(--muted-foreground)',
  remark: 'var(--muted-foreground)',
  note: 'var(--status-warn)',
  note_removed: 'var(--muted-foreground)',
  undo: 'var(--muted-foreground)',
};

// Manila time (UTC+8, no daylight saving), formatted by hand so server and browser agree.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const manila = (iso: string) => new Date(Date.parse(iso) + 8 * 3_600_000);
const dayOf = (iso: string) => {
  const d = manila(iso);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
};
const timeOf = (iso: string) => {
  const d = manila(iso);
  const h = d.getUTCHours();
  return `${h % 12 || 12}:${String(d.getUTCMinutes()).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
};

const ENTRY = 'flex w-full items-start gap-3 rounded-lg px-2 py-2 text-left outline-none transition-colors duration-150 hover:bg-muted/50 focus-visible:bg-muted/50';

function Entry({e, onJump, href, showDay}: {e: ActivityEvent; onJump?: (e: ActivityEvent) => void; href?: string; showDay: boolean}) {
  const Icon = ICON[e.kind];
  const body = (
    <>
        <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full" style={{color: TONE[e.kind], background: `color-mix(in oklab, ${TONE[e.kind]} 14%, transparent)`}}>
          <Icon className="size-3.5" aria-hidden />
        </span>
        <span className="flex min-w-0 flex-col">
          <span className={cn('text-sm leading-snug', e.kind === 'undo' && 'text-muted-foreground')}>{e.text}</span>
          <span className="text-xs text-muted-foreground tabular-nums">
            {[e.by ?? 'Coop', showDay ? `${dayOf(e.at)}, ${timeOf(e.at)}` : timeOf(e.at)].join(' · ')}
          </span>
        </span>
    </>
  );
  return (
    <li>
      {href ? (
        <Link href={href} className={ENTRY}>
          {body}
        </Link>
      ) : (
        <button type="button" onClick={() => onJump?.(e)} className={ENTRY}>
          {body}
        </button>
      )}
    </li>
  );
}

/** Keeps `?company=` (and nothing else) on links between SKU linking and its activity page. */
function useCompanyQuery(): string {
  const sp = useSearchParams();
  const c = sp.get('company');
  return c ? `company=${encodeURIComponent(c)}` : '';
}

export function RecentActivity({events, onJump}: {events: ActivityEvent[]; onJump: (e: ActivityEvent) => void}) {
  const cq = useCompanyQuery();
  return (
    <section aria-label="Recent activity" className="flex h-full min-w-0 flex-col gap-2 rounded-xl border px-4 py-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-sm font-medium">
          <History className="size-4 text-muted-foreground" aria-hidden /> Recent activity
        </h2>
        {events.length > 0 && (
          <Link
            href={`/stock/skus/activity${cq ? `?${cq}` : ''}`}
            className="inline-flex items-center gap-0.5 rounded-sm text-xs font-medium text-primary outline-none underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring"
          >
            See all {events.length}
            <ChevronRight className="size-3.5" aria-hidden />
          </Link>
        )}
      </div>
      {events.length ? (
        <ul className="-mx-2 flex flex-col">
          {events.slice(0, 5).map((e) => (
            <Entry key={e.id} e={e} onJump={onJump} showDay />
          ))}
        </ul>
      ) : (
        <p className="py-2 text-sm text-muted-foreground">No changes yet. Decisions, remarks, notes and undos show up here.</p>
      )}
    </section>
  );
}

/** The whole trail, its own page, with the way back to SKU linking. */
export function SkuActivityPage({events}: {events: ActivityEvent[]}) {
  const cq = useCompanyQuery();
  const [q, setQ] = useState('');
  const groups = useMemo(() => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const shown = events.filter((e) => words.every((w) => `${e.text} ${e.by ?? ''}`.toLowerCase().includes(w)));
    const g = new Map<string, ActivityEvent[]>();
    for (const e of shown) g.set(dayOf(e.at), [...(g.get(dayOf(e.at)) ?? []), e]);
    return [...g.entries()];
  }, [events, q]);
  const back = `/stock/skus${cq ? `?${cq}` : ''}`;
  const find = (e: ActivityEvent) => `/stock/skus?${[cq, `find=${encodeURIComponent(`${e.target}:${e.key}`)}`].filter(Boolean).join('&')}`;

  return (
    <div className={GL_PAGE}>
      <header className="flex flex-col gap-3">
        <Link href={back} className="inline-flex w-fit items-center gap-1.5 rounded-sm text-sm text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
          <ArrowLeft className="size-4" aria-hidden /> SKU linking
        </Link>
        <div className="flex flex-col gap-1.5">
          <h1 className="font-heading text-2xl font-semibold tracking-tight">Activity</h1>
          <p className="text-sm text-muted-foreground">Every decision, remark, note and undo on SKU linking, newest first. Click one to go to it.</p>
        </div>
      </header>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="relative max-md:w-full">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <input
            value={q}
            onChange={(ev) => setQ(ev.target.value)}
            placeholder="Search by product, code or person"
            aria-label="Search activity"
            className="h-9 w-80 rounded-md border border-border bg-background pr-2.5 pl-8 text-sm outline-none transition-colors hover:border-foreground/25 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40 max-md:w-full"
          />
        </div>
        <p className="text-xs text-muted-foreground tabular-nums">{events.length} changes in all</p>
      </div>
      {groups.length ? (
        <div className="flex flex-col gap-6">
          {groups.map(([day, list]) => (
            <section key={day} aria-label={day} className="flex flex-col gap-1">
              <h2 className="px-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">{day}</h2>
              <ul className="flex flex-col rounded-xl border p-2">
                {list.map((e) => (
                  <Entry key={e.id} e={e} href={find(e)} showDay={false} />
                ))}
              </ul>
            </section>
          ))}
        </div>
      ) : (
        <p className="rounded-xl border border-dashed px-6 py-10 text-center text-sm text-muted-foreground">{events.length ? 'Nothing matches that search.' : 'No changes yet.'}</p>
      )}
    </div>
  );
}
