'use client';

import {useEffect, useMemo, useState} from 'react';
import {Archive, ArchiveRestore, Check, History, Link2, MessageSquare, NotebookPen, RotateCcw, Search, Unlink, X} from 'lucide-react';
import type {ActivityEvent, ActivityKind} from '@/src/goldline-sku-activity';
import {Button} from '@/components/ui/button';
import {ModalShell, useModalExit} from './modal-shell';
import {cn} from '@/lib/utils';

// "Recent activity" on SKU linking (Oct 29): the 5 latest changes under the numbers table,
// and "See all" for the whole trail (grouped by day, searchable). Clicking an entry jumps
// to that SKU or item in the list below.

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

function Entry({e, onJump, showDay}: {e: ActivityEvent; onJump: (e: ActivityEvent) => void; showDay: boolean}) {
  const Icon = ICON[e.kind];
  return (
    <li>
      <button
        type="button"
        onClick={() => onJump(e)}
        className="flex w-full items-start gap-3 rounded-lg px-2 py-2 text-left outline-none transition-colors duration-150 hover:bg-muted/50 focus-visible:bg-muted/50"
      >
        <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full" style={{color: TONE[e.kind], background: `color-mix(in oklab, ${TONE[e.kind]} 14%, transparent)`}}>
          <Icon className="size-3.5" aria-hidden />
        </span>
        <span className="flex min-w-0 flex-col">
          <span className={cn('text-sm leading-snug', e.kind === 'undo' && 'text-muted-foreground')}>{e.text}</span>
          <span className="text-xs text-muted-foreground tabular-nums">
            {[e.by ?? 'Coop', showDay ? `${dayOf(e.at)}, ${timeOf(e.at)}` : timeOf(e.at)].join(' · ')}
          </span>
        </span>
      </button>
    </li>
  );
}

export function RecentActivity({events, onJump}: {events: ActivityEvent[]; onJump: (e: ActivityEvent) => void}) {
  const [all, setAll] = useState(false);
  return (
    <section aria-label="Recent activity" className="flex flex-col gap-2 rounded-xl border px-4 py-4 sm:px-6">
      <div className="flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-sm font-medium">
          <History className="size-4 text-muted-foreground" aria-hidden /> Recent activity
        </h2>
        {events.length > 0 && (
          <Button size="sm" variant="ghost" className="text-primary" onClick={() => setAll(true)}>
            See all {events.length}
          </Button>
        )}
      </div>
      {events.length ? (
        <ul className="flex flex-col">
          {events.slice(0, 5).map((e) => (
            <Entry key={e.id} e={e} onJump={onJump} showDay />
          ))}
        </ul>
      ) : (
        <p className="py-2 text-sm text-muted-foreground">No changes yet. Decisions, remarks, notes and undos show up here.</p>
      )}
      {all && <ActivityDialog events={events} onJump={onJump} onClosed={() => setAll(false)} />}
    </section>
  );
}

function ActivityDialog({events, onJump, onClosed}: {events: ActivityEvent[]; onJump: (e: ActivityEvent) => void; onClosed: () => void}) {
  const {closing, close} = useModalExit(onClosed);
  const [q, setQ] = useState('');
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);
  const groups = useMemo(() => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const shown = events.filter((e) => words.every((w) => `${e.text} ${e.by ?? ''}`.toLowerCase().includes(w)));
    const g = new Map<string, ActivityEvent[]>();
    for (const e of shown) g.set(dayOf(e.at), [...(g.get(dayOf(e.at)) ?? []), e]);
    return [...g.entries()];
  }, [events, q]);

  return (
    <ModalShell closing={closing} onBackdropClick={close} labelledBy="activity-title" panelClassName="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-xl border bg-popover shadow-lg">
      <div className="flex flex-col gap-3 border-b px-6 pt-5 pb-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex flex-col gap-0.5">
            <h2 id="activity-title" className="font-heading text-lg font-semibold tracking-tight">
              Activity on SKU linking
            </h2>
            <p className="text-sm text-muted-foreground">Every decision, remark, note and undo, newest first. Click one to go to it.</p>
          </div>
          <Button size="icon-sm" variant="ghost" onClick={close} aria-label="Close">
            <X className="size-4" />
          </Button>
        </div>
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            autoFocus
            placeholder="Search by product, code or person"
            aria-label="Search activity"
            className="h-9 w-full rounded-md border border-border bg-background pr-2.5 pl-8 text-sm outline-none transition-colors hover:border-foreground/25 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40"
          />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {groups.length ? (
          groups.map(([day, list]) => (
            <div key={day} className="flex flex-col gap-1 pb-3">
              <p className="sticky top-0 z-10 bg-popover px-2 py-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">{day}</p>
              <ul className="flex flex-col">
                {list.map((e) => (
                  <Entry
                    key={e.id}
                    e={e}
                    showDay={false}
                    onJump={(x) => {
                      onJump(x);
                      close();
                    }}
                  />
                ))}
              </ul>
            </div>
          ))
        ) : (
          <p className="px-2 py-6 text-center text-sm text-muted-foreground">Nothing matches that search.</p>
        )}
      </div>
    </ModalShell>
  );
}
