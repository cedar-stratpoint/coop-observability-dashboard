'use client';

import Link from 'next/link';
import {useEffect, useMemo, useState} from 'react';
import {useRouter} from 'next/navigation';
import {AlertDialog} from '@base-ui/react/alert-dialog';
import {AlertTriangle, Check, ChevronDown, Loader2, Search, Trash2, UserPen} from 'lucide-react';
import {cn} from '@/lib/utils';
import {toneText} from '@/src/review-confidence';
import {scanPageLabel} from '@/src/upload-batch';
import {baSlug, reconcileBaNames} from '@/src/goldline-ba-reconcile';
import {fmtTriagePeriod} from '@/src/goldline-triage-format';
import type {UploadRow} from '@/src/goldline-data';
import type {TriageForm, TriageResult} from '@/src/goldline-triage-data';
import {assignFormBaAction} from '@/app/uploads/actions';
import {Button} from '@/components/ui/button';
import {Pagination} from '@/components/analyst/pagination';
import {FileTypeBadge} from '@/components/analyst/file-type-badge';
import {DeleteUploadDialog} from '@/components/analyst/delete-upload-dialog';
import {KIND_LABEL, StatusPill, fmtWhen} from '@/components/analyst/uploads-view';

const PAGE_SIZES = [5, 10, 20, 50] as const;
type PageSize = (typeof PAGE_SIZES)[number];
const SIZE_KEY = 'coop.scanfiles.perPage';

const TONE = {good: 'var(--status-good)', warn: 'var(--status-warn)', crit: 'var(--status-crit)'} as const;
function tint(t: keyof typeof TONE) {
  return {color: toneText(TONE[t]), background: `color-mix(in oklab, ${TONE[t]} 14%, transparent)`};
}

// The best outcome wins when a page was tried several times: a committed or read page
// beats one still processing, which beats a set-aside, which beats a failure; newest
// breaks a tie. Retries and re-uploads each make a fresh row, so a page can have many.
const STATUS_RANK: Record<string, number> = {committed: 5, needs_review: 4, processing: 3, rejected: 2, failed: 1};

/** The scan's pages as a plain list — "Page 10 of 98", in page order, each opening its
 *  review. One row per page: the current (best) attempt, with the older tries folded
 *  behind an "N earlier attempts" toggle so repeated retries/re-uploads don't pile up. */
export function ScanFileList({files, canEdit, company}: {files: UploadRow[]; canEdit: boolean; company: string}) {
  const router = useRouter();
  const [deleteTarget, setDeleteTarget] = useState<UploadRow | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set());
  const [page, setPage] = useState(1);
  const [size, setSize] = useState<PageSize>(20);
  // Pages per view is a per-viewer convenience: remembered in this browser only.
  useEffect(() => {
    try {
      const v = Number(localStorage.getItem(SIZE_KEY));
      if ((PAGE_SIZES as readonly number[]).includes(v)) setSize(v as PageSize);
    } catch {}
  }, []);
  const changeSize = (v: PageSize) => {
    setSize(v);
    setPage(1);
    try {
      localStorage.setItem(SIZE_KEY, String(v));
    } catch {}
  };
  const groups = useMemo(() => {
    const byPage = new Map<number, UploadRow[]>();
    for (const f of files) {
      const idx = scanPageLabel(f.filename).index;
      const arr = byPage.get(idx) ?? [];
      arr.push(f);
      byPage.set(idx, arr);
    }
    return [...byPage.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([idx, rows]) => {
        const sorted = [...rows].sort(
          (a, b) => (STATUS_RANK[b.status] ?? 0) - (STATUS_RANK[a.status] ?? 0) || b.created_at.localeCompare(a.created_at),
        );
        return {idx, best: sorted[0], others: sorted.slice(1)};
      });
  }, [files]);

  const total = groups.length;
  const pageCount = Math.max(1, Math.ceil(total / size));
  const safePage = Math.min(page, pageCount);
  const from = (safePage - 1) * size;
  const pageGroups = groups.slice(from, from + size);

  if (files.length === 0) {
    return <p className="py-10 text-center text-sm text-muted-foreground">No files in this scan.</p>;
  }

  const toggle = (idx: number) =>
    setExpanded((s) => {
      const n = new Set(s);
      n.has(idx) ? n.delete(idx) : n.add(idx);
      return n;
    });

  return (
    <div className="flex flex-col gap-4">
      <div className="overflow-hidden rounded-xl border border-border bg-card">
      <ul role="list" className="flex flex-col divide-y divide-border">
        {pageGroups.map(({idx, best: u, others}) => {
          const label = scanPageLabel(u.filename);
          const open = expanded.has(idx);
          return (
            <li key={idx} className="flex flex-col">
              <div className="relative flex items-center gap-3 px-4 py-3.5 transition-colors hover:bg-muted/40">
                <FileTypeBadge filename={u.filename} />
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <Link
                    href={`/uploads/${u.id}`}
                    className="truncate font-medium outline-none after:absolute after:inset-0 after:content-[''] focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset"
                    title={u.filename}
                  >
                    {label.title}
                  </Link>
                  {label.sub && <span className="truncate font-mono text-[11px] text-muted-foreground">{label.sub}</span>}
                  <span className="flex min-w-0 flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                    <span className="truncate">{KIND_LABEL[u.kind] ?? 'File'} · {fmtWhen(u.created_at)}</span>
                    {others.length > 0 && (
                      <button
                        type="button"
                        onClick={() => toggle(idx)}
                        aria-expanded={open}
                        className="relative z-10 inline-flex shrink-0 items-center gap-0.5 rounded px-1 text-[11px] font-medium text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"
                      >
                        <ChevronDown className={cn('size-3 transition-transform', open && 'rotate-180')} />
                        {others.length} earlier {others.length === 1 ? 'attempt' : 'attempts'}
                      </button>
                    )}
                  </span>
                </div>
                <StatusPill status={u.status} />
                {canEdit && (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Delete ${label.title}`}
                    className="relative z-10 shrink-0 text-muted-foreground hover:text-destructive"
                    onClick={() => setDeleteTarget(u)}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                )}
              </div>
              {open && others.length > 0 && (
                <ul className="flex flex-col divide-y divide-border border-t border-border bg-muted/20 pl-[4.25rem]">
                  {others.map((o) => (
                    <li key={o.id} className="flex items-center gap-3 px-4 py-2.5">
                      <Link href={`/uploads/${o.id}`} className="min-w-0 flex-1 truncate text-xs text-muted-foreground hover:text-foreground" title={o.filename}>
                        {KIND_LABEL[o.kind] ?? 'File'} · {fmtWhen(o.created_at)}
                      </Link>
                      <StatusPill status={o.status} />
                      {canEdit && (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Delete this earlier attempt of ${label.title}`}
                          className="shrink-0 text-muted-foreground hover:text-destructive"
                          onClick={() => setDeleteTarget(o)}
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
      </div>

      {total > PAGE_SIZES[0] && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <p className="text-xs text-muted-foreground tabular-nums">
              {from + 1} to {Math.min(total, from + size)} of {total} {total === 1 ? 'page' : 'pages'}
            </p>
            <RowsPerPage value={size} onChange={changeSize} />
          </div>
          <Pagination page={safePage} pageCount={pageCount} onPage={setPage} label="Scan pages" />
        </div>
      )}

      <DeleteUploadDialog
        company={company}
        upload={deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onDeleted={() => {
          setDeleteTarget(null);
          router.refresh();
        }}
      />
    </div>
  );
}

function RowsPerPage({value, onChange}: {value: PageSize; onChange: (v: PageSize) => void}) {
  return (
    <div role="group" aria-label="Pages per view" className="flex items-center gap-2 text-xs text-muted-foreground">
      <span>Per page</span>
      <div className="flex rounded-md bg-muted/60 p-0.5">
        {PAGE_SIZES.map((s) => (
          <button
            key={s}
            type="button"
            aria-pressed={value === s}
            onClick={() => onChange(s)}
            className={cn(
              'h-6 min-w-8 rounded px-2 tabular-nums transition-colors duration-150',
              value === s ? 'bg-background font-medium text-foreground shadow-sm' : 'hover:text-foreground',
            )}
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

type BaGroup = {name: string; hasName: boolean; forms: number; stores: number; needsStore: number; incomplete: number; ready: number; committed: number; items: TriageForm[]};

/** One card per Beauty Assistant: how many forms and stores are theirs in this scan, and
 *  what still needs doing. Near-duplicate spellings of one name are reconciled into a
 *  single BA (preferring a registry name). Opens that BA's forms (the store view, filtered).
 *  A "Change BA" control re-points a whole card's forms at one person, the same way the
 *  per-store view confirms a store for a group. */
export function BaCards({
  data,
  source,
  knownBas = [],
  canEdit = false,
  company,
}: {
  data: TriageResult;
  source: string;
  knownBas?: string[];
  canEdit?: boolean;
  company: string;
}) {
  const [editCard, setEditCard] = useState<{name: string; items: TriageForm[]} | null>(null);
  const groups = useMemo(() => {
    const canon = reconcileBaNames(data.forms.map((f) => f.consultant), knownBas);
    const nameOf = (c: string | null) => (c?.trim() ? canon.get(c.trim()) ?? c.trim() : 'No BA on the form');
    const by = new Map<string, BaGroup>();
    const storesByName = new Map<string, Set<string>>();
    for (const f of data.forms) {
      const hasName = Boolean(f.consultant?.trim());
      const name = nameOf(f.consultant);
      const g = by.get(name) ?? {name, hasName, forms: 0, stores: 0, needsStore: 0, incomplete: 0, ready: 0, committed: 0, items: []};
      g.forms++;
      g.items.push(f);
      const done = f.committed > 0 && f.needsReview === 0;
      if (done) g.committed++;
      else if (!f.storeCode || f.flags.includes('store-unmatched')) g.needsStore++;
      else if (f.missing.length > 0) g.incomplete++;
      else g.ready++;
      by.set(name, g);
      const set = storesByName.get(name) ?? new Set<string>();
      if (f.storeCode) set.add(f.storeCode);
      storesByName.set(name, set);
    }
    for (const g of by.values()) g.stores = storesByName.get(g.name)?.size ?? 0;
    // BAs who still need you first, then by form count.
    return [...by.values()].sort((a, b) => b.needsStore + b.incomplete - (a.needsStore + a.incomplete) || b.forms - a.forms);
  }, [data.forms, knownBas]);

  if (groups.length === 0) {
    return <p className="py-10 text-center text-sm text-muted-foreground">No forms with a BA in this scan yet.</p>;
  }

  return (
    <>
      <div className="grid grid-cols-1 items-start gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {groups.map((g) => {
          const attention = g.needsStore + g.incomplete;
          const initials = g.name
            .split(/\s+/)
            .filter((w) => /[a-z]/i.test(w))
            .slice(0, 2)
            .map((w) => w[0]?.toUpperCase())
            .join('');
          return (
            <div
              key={g.name}
              className="group relative flex flex-col gap-3.5 rounded-xl border border-border bg-card p-4 shadow-sm transition-all hover:-translate-y-0.5 hover:border-foreground/20 hover:shadow-md"
            >
              <div className="flex items-center gap-2.5">
                <span className="grid size-9 shrink-0 place-items-center rounded-full bg-muted font-mono text-[11px] font-semibold text-muted-foreground">
                  {initials || '?'}
                </span>
                <div className="min-w-0">
                  <Link
                    href={`/uploads/scan/${encodeURIComponent(source)}?view=store&ba=${encodeURIComponent(g.name)}`}
                    className="block truncate font-heading text-[15px] font-semibold tracking-tight outline-none after:absolute after:inset-0 after:rounded-xl after:content-[''] focus-visible:after:ring-3 focus-visible:after:ring-ring/40"
                    title={g.name}
                  >
                    {g.name}
                  </Link>
                  <div className="font-mono text-[11.5px] text-muted-foreground tabular-nums">
                    {g.forms} {g.forms === 1 ? 'form' : 'forms'} · {g.stores} {g.stores === 1 ? 'store' : 'stores'}
                  </div>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                {g.needsStore > 0 && <Pill tone="crit" n={g.needsStore} label="need a store" />}
                {g.incomplete > 0 && <Pill tone="warn" n={g.incomplete} label="incomplete" />}
                {g.ready > 0 && <Pill tone="good" n={g.ready} label="ready" />}
                {g.committed > 0 && (
                  <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground tabular-nums">{g.committed} done</span>
                )}
              </div>
              <div className="flex items-center justify-between gap-2">
                {canEdit && g.hasName ? (
                  <button
                    type="button"
                    onClick={() => setEditCard({name: g.name, items: g.items})}
                    className="relative z-10 inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  >
                    <UserPen className="size-3" /> Change BA
                  </button>
                ) : (
                  <span />
                )}
                <span className="text-[11px] font-medium text-[color:var(--primary)] opacity-0 transition-opacity group-hover:opacity-100">
                  {attention > 0 ? 'Open forms →' : 'View forms →'}
                </span>
              </div>
            </div>
          );
        })}
      </div>
      {editCard && (
        <BaAssignDialog
          company={company}
          card={editCard}
          knownBas={knownBas}
          scanBas={groups.filter((g) => g.hasName).map((g) => g.name)}
          onClose={() => setEditCard(null)}
        />
      )}
    </>
  );
}

/** Rough check: the read BA name shares no meaningful word with the chosen BA, so it is
 *  probably a different person wrongly folded into this card. Used only to hint. */
function baLooksDifferent(readName: string | null, baName: string): boolean {
  const words = (s: string) => new Set(baSlug(s ?? '').split(' ').filter((w) => w.length >= 3));
  const a = words(readName ?? '');
  if (a.size === 0) return false;
  const b = words(baName);
  for (const w of a) if (b.has(w)) return false;
  return true;
}

/** Confirm or change the BA for a whole card at once. Coop suggests the registry BA that
 *  matches the card's name; the user keeps it or picks another and ticks which forms to
 *  point at it, so a form read as a different person can be left out. Mirrors the per-store
 *  "Confirm store" dialog, applied to the consultant instead of the store. */
function BaAssignDialog({company, card, knownBas, scanBas, onClose}: {company: string; card: {name: string; items: TriageForm[]}; knownBas: string[]; scanBas: string[]; onClose: () => void}) {
  const router = useRouter();
  const [q, setQ] = useState('');
  const cardSlug = baSlug(card.name);
  // Candidates are the registry's BAs plus every BA already read in this scan (minus this
  // card), so you can fold a look-alike into the person who already has most of the forms.
  const candidates = useMemo(() => [...new Set([...knownBas, ...scanBas])].filter((b) => b.trim() && b !== card.name), [knownBas, scanBas, card.name]);
  const suggested = useMemo(() => knownBas.find((b) => baSlug(b) === cardSlug) ?? null, [knownBas, cardSlug]);
  const [picked, setPicked] = useState<string | null>(suggested ?? (cardSlug ? card.name : null));
  const [selected, setSelected] = useState<Set<string>>(() => new Set(card.items.map((f) => f.key)));
  const [pending, setPending] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const trimmed = q.trim();
  const matches = useMemo(() => {
    const t = trimmed.toLowerCase();
    return candidates.filter((b) => !t || b.toLowerCase().includes(t)).slice(0, 6);
  }, [trimmed, candidates]);
  // Let the user type a canonical name neither the registry nor the scan has yet (BAs are
  // learned from forms, unlike the fixed store list), offered as an explicit custom pick.
  const custom = trimmed && ![...candidates, card.name].some((b) => b.toLowerCase() === trimmed.toLowerCase()) ? trimmed : null;
  const toggle = (key: string) =>
    setSelected((s) => {
      const n = new Set(s);
      n.has(key) ? n.delete(key) : n.add(key);
      return n;
    });
  async function apply() {
    if (!picked) return setErr('Pick a BA first.');
    const forms = card.items.filter((f) => selected.has(f.key));
    if (!forms.length) return setErr('Tick at least one form.');
    setPending(true);
    setErr(null);
    const results = await Promise.all(forms.map((f) => assignFormBaAction({company, uploadIds: f.uploadIds, baName: picked})));
    setPending(false);
    const bad = results.find((r) => !r.ok);
    if (bad && !bad.ok) return setErr(bad.error);
    onClose();
    router.refresh();
  }

  return (
    <AlertDialog.Root open onOpenChange={(o) => (o ? null : onClose())}>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="fixed inset-0 z-50 bg-black/45 transition-opacity duration-150 ease-out data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
        <AlertDialog.Popup className="fixed top-1/2 left-1/2 z-50 flex w-[min(32rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 rounded-xl border border-border bg-popover p-5 text-popover-foreground shadow-xl outline-none transition-[opacity,transform] duration-150 ease-out data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0">
          <div className="flex items-start gap-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-full bg-primary/10 text-primary">
              <UserPen className="size-4" aria-hidden />
            </span>
            <div className="flex min-w-0 flex-col gap-0.5">
              <AlertDialog.Title className="font-heading text-base font-semibold">Confirm the BA for these forms</AlertDialog.Title>
              <AlertDialog.Description className="text-sm text-muted-foreground">
                Point the ticked forms at one person. Coop suggests the registry match for “{card.name}”.
              </AlertDialog.Description>
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2 rounded-md border border-border px-2">
              <Search className="size-3.5 shrink-0 text-muted-foreground" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search a BA by name…" className="h-8 w-full bg-transparent text-sm outline-none" />
            </div>
            <div className="flex max-h-32 flex-col gap-0.5 overflow-y-auto">
              {matches.length === 0 && !custom ? (
                <span className="px-2 py-1.5 text-xs text-muted-foreground">No BA matches that.</span>
              ) : (
                <>
                  {matches.map((b) => {
                    const on = picked === b;
                    return (
                      <button
                        key={b}
                        type="button"
                        onClick={() => setPicked(b)}
                        className={cn('flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors', on ? 'bg-primary/10' : 'hover:bg-muted')}
                      >
                        <span className="min-w-0 truncate">
                          {b}
                          {suggested === b && <span className="ml-1.5 rounded bg-muted px-1 py-0.5 text-[10px] font-medium text-muted-foreground">suggested</span>}
                        </span>
                        {on && <Check className="size-3.5 shrink-0 text-primary" />}
                      </button>
                    );
                  })}
                  {custom && (
                    <button
                      type="button"
                      onClick={() => setPicked(custom)}
                      className={cn('flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors', picked === custom ? 'bg-primary/10' : 'hover:bg-muted')}
                    >
                      <span className="min-w-0 truncate">
                        Use “{custom}” <span className="text-xs text-muted-foreground">(new BA)</span>
                      </span>
                      {picked === custom && <Check className="size-3.5 shrink-0 text-primary" />}
                    </button>
                  )}
                </>
              )}
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">Apply to these forms</span>
            <ul className="flex max-h-44 flex-col divide-y divide-border overflow-y-auto rounded-lg border border-border">
              {card.items.map((f) => {
                const on = selected.has(f.key);
                const diff = picked ? baLooksDifferent(f.consultant, picked) : false;
                return (
                  <li key={f.key}>
                    <button type="button" onClick={() => toggle(f.key)} className="flex w-full items-center gap-2.5 px-2.5 py-2 text-left transition-colors hover:bg-muted/50">
                      <span className={cn('grid size-4 shrink-0 place-items-center rounded border', on ? 'border-primary bg-primary text-primary-foreground' : 'border-border')}>
                        {on && <Check className="size-3" />}
                      </span>
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-sm">{f.consultant?.trim() || 'No name read'}</span>
                        <span className="truncate font-mono text-[11px] text-muted-foreground tabular-nums">
                          {f.storeName ?? (f.storeCode ? `Store ${f.storeCode}` : 'No store yet')} · {fmtTriagePeriod(f.periodStart, f.periodEnd)}
                        </span>
                      </span>
                      {diff && (
                        <span className="inline-flex shrink-0 items-center gap-1 text-[11px]" style={{color: toneText('var(--status-warn)')}}>
                          <AlertTriangle className="size-3" /> looks different
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>

          {err && <span role="alert" className="text-xs text-[color:var(--status-crit)]">{err}</span>}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="min-w-0 truncate text-xs text-muted-foreground">
              {picked ? <>Pointing to <span className="font-medium text-foreground">{picked}</span></> : 'Pick a BA'}
            </span>
            <div className="flex gap-2">
              <AlertDialog.Close render={<Button variant="ghost" size="sm" />}>Cancel</AlertDialog.Close>
              <Button size="sm" onClick={apply} disabled={pending || !picked || selected.size === 0}>
                {pending ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
                Apply to {selected.size} {selected.size === 1 ? 'form' : 'forms'}
              </Button>
            </div>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

function Pill({tone, n, label}: {tone: keyof typeof TONE; n: number; label: string}) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-medium tabular-nums" style={tint(tone)}>
      <span aria-hidden className="size-1.5 rounded-full" style={{background: TONE[tone]}} />
      <span className="font-semibold">{n}</span> {label}
    </span>
  );
}
