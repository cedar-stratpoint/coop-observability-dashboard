'use client';

import Link from 'next/link';
import {useEffect, useMemo, useState} from 'react';
import {useRouter, useSearchParams} from 'next/navigation';
import {AlertDialog} from '@base-ui/react/alert-dialog';
import {AlertTriangle, Check, ChevronDown, Loader2, RotateCcw, Search, Trash2, UserPen} from 'lucide-react';
import {cn} from '@/lib/utils';
import {toneText} from '@/src/review-confidence';
import {scanPageLabel, scanPosition} from '@/src/upload-batch';
import {STATUS_FILTER_ORDER, TYPE_ORDER, VERSION_FILTER_ORDER, fileReviewQuery, groupFiles, matchesFilter, pageType, parseFileFilter, type PageType} from '@/src/scan-file-nav';
import {baSlug, reconcileBaNames} from '@/src/goldline-ba-reconcile';
import {fmtTriagePeriod, VERSION_LABEL, VERSION_COLOR} from '@/src/goldline-triage-format';
import type {FormVersion} from '@/src/goldline-extract';
import {VersionPill} from '@/components/analyst/version-pill';
import type {UploadRow, UploadStatus} from '@/src/goldline-data';
import type {TriageForm, TriageResult} from '@/src/goldline-triage-data';
import {assignFormBaAction} from '@/app/uploads/actions';
import {sendReread} from '@/src/upload-transport';
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

// Each page carries two independent facets, filtered on their own rows so they never share a
// chip: its TYPE (what the page is) and its STATUS (where it sits in review). Keeping them
// apart is what fixes the old "Show" row, which mixed the two and repeated "Set aside" and
// "Couldn't read" as both a kind and a status.
const TYPE_LABEL: Record<PageType, string> = {inventory: 'Inventory form', sales: 'Sales report', blank: 'Blank page'};
// Ordering, best attempt, pageType and the filter predicate live in src/scan-file-nav.ts,
// shared with the one-page review's arrows so both read the same list.
// The review workflow state, its own facet. "Set aside" is the one home for a parked page
// (a rejected form, or any sales/blank sheet); "Failed" is the one home for an unread page.
const STATUS_LABEL: Record<UploadStatus, string> = {queued: 'Queued', needs_review: 'Needs review', processing: 'Processing', failed: 'Failed', rejected: 'Set aside', committed: 'Committed'};
const STATUS_DOT: Record<UploadStatus, string> = {
  queued: 'var(--muted-foreground)',
  needs_review: 'var(--status-warn)',
  processing: 'var(--muted-foreground)',
  failed: 'var(--status-crit)',
  rejected: 'var(--version-legacy, #6d4c9a)',
  committed: 'var(--status-good)',
};

/** The scan's pages as a plain list — "Page 10 of 98", in page order, each opening its
 *  review. One row per page: the current (best) attempt, with the older tries folded
 *  behind an "N earlier attempts" toggle so repeated retries/re-uploads don't pile up. */
export function ScanFileList({files, canEdit, company, version = null}: {files: UploadRow[]; canEdit: boolean; company: string; version?: FormVersion | null}) {
  const router = useRouter();
  const params = useSearchParams();
  const [deleteTarget, setDeleteTarget] = useState<UploadRow | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set());
  // The filters and list page live in the URL (type / status / fv / lp), so browser Back from
  // a page review lands on exactly the list the reviewer left, not a reset one.
  const filters = parseFileFilter({type: params.get('type'), status: params.get('status'), fv: params.get('fv')});
  const {type: typeFilter, status: statusFilter, fv: versionFilter} = filters;
  const page = Math.max(1, Number(params.get('lp')) || 1);
  const [size, setSize] = useState<PageSize>(20);
  // replaceState (Next syncs it into useSearchParams): a filter change is not a step to go
  // Back through, and it needs no server round trip.
  const setQuery = (next: Record<string, string | null>) => {
    const qs = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(next)) {
      if (v == null) qs.delete(k);
      else qs.set(k, v);
    }
    window.history.replaceState(null, '', `?${qs.toString()}`);
  };
  const setPage = (n: number) => setQuery({lp: n > 1 ? String(n) : null});
  const chooseType = (t: PageType | 'all') => setQuery({type: t === 'all' ? null : t, lp: null});
  const chooseVersion = (v: 'all' | FormVersion) => setQuery({fv: v === 'all' ? null : v, lp: null});
  const chooseStatus = (s: 'all' | UploadStatus) => setQuery({status: s === 'all' ? null : s, lp: null});
  const reviewQuery = fileReviewQuery(filters, version);
  // Pages being read again from the stored file (a failed page, retried in place).
  const [rereading, setRereading] = useState<Set<string>>(() => new Set());
  // Per-page read progress (0..100), driven by the real read stages streamed back from the
  // upload route (detect → read → save) plus the 12s heartbeat that ticks while the long read
  // runs — so the bar tracks the actual process, not a fixed animation.
  const [rereadPct, setRereadPct] = useState<Map<string, number>>(() => new Map());
  const bumpPct = (id: string, to: (prev: number) => number) =>
    setRereadPct((m) => {
      const n = new Map(m);
      n.set(id, Math.max(0, Math.min(100, to(n.get(id) ?? 0))));
      return n;
    });
  const reread = (id: string) => {
    setRereading((s) => new Set(s).add(id));
    bumpPct(id, () => 6);
    // Stream through the upload route (heartbeat-kept-alive) so a long read resolves here for
    // real; map each stage to a share of the bar and creep on each heartbeat while reading.
    sendReread({
      company,
      uploadId: id,
      onStage: (s) => {
        if (s.stage === 'detecting') bumpPct(id, (p) => Math.max(p, 24));
        else if (s.stage === 'reading') bumpPct(id, (p) => (p < 52 ? 52 : Math.min(92, p + 6)));
        else if (s.stage === 'saving') bumpPct(id, (p) => Math.max(p, 96));
      },
    })
      .promise.then(() => bumpPct(id, () => 100)) // finished → fill the bar
      .catch(() => {}) // failed / stalled → leave the bar where it got to
      .finally(() => {
        // Hold the final width a beat, then clear and refresh to the new status.
        setTimeout(() => {
          setRereading((s) => {
            const n = new Set(s);
            n.delete(id);
            return n;
          });
          setRereadPct((m) => {
            const n = new Map(m);
            n.delete(id);
            return n;
          });
          router.refresh();
        }, 400);
      });
  };
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
  const groups = useMemo(() => groupFiles(files), [files]);

  // Scan outcome recap (one per page, its best attempt), read straight from review status:
  // "read" = a form in review or committed; "set aside" = a parked page (rejected form, or a
  // sales/blank sheet); "failed" = couldn't be read. A sentence, not a filter.
  const summary = useMemo(() => {
    const c = {read: 0, setAside: 0, failed: 0, processing: 0};
    for (const g of groups) {
      const s = g.best.status;
      if (s === 'needs_review' || s === 'committed') c.read++;
      else if (s === 'rejected') c.setAside++;
      else if (s === 'failed') c.failed++;
      else if (s === 'processing') c.processing++;
    }
    return c;
  }, [groups]);

  // Facet 1 — page TYPE (what the page is). A page Coop couldn't read has no type and no chip
  // here; it is found under Status. So these counts are a subset of the total, not a partition.
  const typeCounts = useMemo(() => {
    const c = {} as Record<string, number>;
    for (const g of groups) {
      const t = pageType(g.best);
      if (t) c[t] = (c[t] ?? 0) + 1;
    }
    return c;
  }, [groups]);
  const typesPresent = TYPE_ORDER.filter((t) => (typeCounts[t] ?? 0) > 0);

  // Facet 2 — review STATUS.
  const statusCounts = useMemo(() => {
    const c = {} as Record<string, number>;
    for (const g of groups) c[g.best.status] = (c[g.best.status] ?? 0) + 1;
    return c;
  }, [groups]);
  const statusesPresent = STATUS_FILTER_ORDER.filter((s) => (statusCounts[s] ?? 0) > 0);

  // Facet 3 — form VERSION, a sub-filter of inventory forms (only they carry a version).
  const versionCounts = useMemo(() => {
    const c = {} as Record<string, number>;
    for (const g of groups) if (pageType(g.best) === 'inventory' && g.best.form_version && g.best.form_version !== 'unknown') c[g.best.form_version] = (c[g.best.form_version] ?? 0) + 1;
    return c;
  }, [groups]);
  const versionsPresent = VERSION_FILTER_ORDER.filter((v) => (versionCounts[v] ?? 0) > 0);

  // The three facets combine with AND; Version applies only to inventory forms.
  const shown = groups.filter((g) => matchesFilter(g.best, filters));
  const total = shown.length;
  const pageCount = Math.max(1, Math.ceil(total / size));
  const safePage = Math.min(page, pageCount);
  const from = (safePage - 1) * size;
  const pageGroups = shown.slice(from, from + size);

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
      {/* Scan outcome, the same way the uploader showed it — so this stays the one place to
          come back to a scan and see what read, what was set aside, and what failed. */}
      <div className="flex flex-col gap-3">
        <p className="text-sm text-muted-foreground tabular-nums">
          <span className="font-medium text-foreground">{summary.read}</span> of {groups.length} read
          {summary.setAside > 0 && <> · {summary.setAside} set aside</>}
          {summary.processing > 0 && <> · {summary.processing} reading</>}
          {summary.failed > 0 && (
            <>
              {' · '}
              <span className="font-medium text-[color:var(--status-crit)]">{summary.failed}</span> failed
            </>
          )}
        </p>
        {typesPresent.length >= 2 && (
          <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filter pages by type">
            <span className="w-14 shrink-0 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">Type</span>
            <FilterChip active={typeFilter === 'all'} onClick={() => chooseType('all')}>
              All <span className="tabular-nums opacity-70">{groups.length}</span>
            </FilterChip>
            {typesPresent.map((t) => (
              <FilterChip key={t} active={typeFilter === t} onClick={() => chooseType(t)}>
                {TYPE_LABEL[t]} <span className="tabular-nums opacity-70">{typeCounts[t]}</span>
              </FilterChip>
            ))}
          </div>
        )}
        {statusesPresent.length >= 2 && (
          <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filter pages by review status">
            <span className="w-14 shrink-0 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">Status</span>
            <FilterChip active={statusFilter === 'all'} onClick={() => chooseStatus('all')}>
              All <span className="tabular-nums opacity-70">{statusesPresent.reduce((a, s) => a + (statusCounts[s] ?? 0), 0)}</span>
            </FilterChip>
            {statusesPresent.map((s) => (
              <FilterChip key={s} active={statusFilter === s} dotColor={STATUS_DOT[s]} onClick={() => chooseStatus(s)}>
                {STATUS_LABEL[s]} <span className="tabular-nums opacity-70">{statusCounts[s]}</span>
              </FilterChip>
            ))}
          </div>
        )}
        {versionsPresent.length >= 2 && (
          <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filter pages by form version">
            <span className="w-14 shrink-0 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">Version</span>
            <FilterChip active={versionFilter === 'all'} onClick={() => chooseVersion('all')}>
              All <span className="tabular-nums opacity-70">{versionsPresent.reduce((a, v) => a + (versionCounts[v] ?? 0), 0)}</span>
            </FilterChip>
            {versionsPresent.map((v) => (
              <FilterChip key={v} active={versionFilter === v} dotColor={VERSION_COLOR[v]} onClick={() => chooseVersion(v)}>
                {VERSION_LABEL[v]} <span className="tabular-nums opacity-70">{versionCounts[v]}</span>
              </FilterChip>
            ))}
          </div>
        )}
      </div>

      {shown.length === 0 ? (
        <p className="rounded-xl border border-border bg-card py-10 text-center text-sm text-muted-foreground">
          No pages in this filter.
        </p>
      ) : (
      <div className="overflow-hidden rounded-xl border border-border bg-card">
      <ul role="list" className="flex flex-col divide-y divide-border">
        {pageGroups.map(({idx, best: u, others}) => {
          const label = scanPageLabel(u.filename);
          const open = expanded.has(idx);
          // The source scan name, shown as a quiet pill beside "Page N of M"; and, for a
          // read inventory page, the detected form version (Legacy / V1 / V2).
          const src = scanPosition(u.filename)?.source ?? null;
          const ver = pageType(u) === 'inventory' && u.form_version && u.form_version !== 'unknown' ? VERSION_LABEL[u.form_version as FormVersion] : null;
          return (
            <li key={idx} className="flex flex-col">
              <div className="relative flex items-center gap-3.5 px-4 py-4 transition-colors hover:bg-muted/40">
                <FileTypeBadge filename={u.filename} />
                <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                  <span className="flex min-w-0 items-baseline gap-2">
                    <Link
                      href={`/uploads/${u.id}?${reviewQuery}`}
                      className="truncate text-[0.9375rem] font-semibold tracking-tight outline-none after:absolute after:inset-0 after:content-[''] focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset"
                      title={u.filename}
                    >
                      {label.title}
                    </Link>
                    {src && (
                      <span
                        className="max-w-[14rem] shrink-0 truncate rounded-full bg-muted px-2 py-0.5 font-mono text-[10px] text-muted-foreground"
                        title={u.filename}
                      >
                        {src}
                      </span>
                    )}
                  </span>
                  {rereading.has(u.id) ? (
                    <span className="flex flex-col gap-1">
                      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-[color:var(--primary)]">
                        <Loader2 className="size-3 animate-spin" aria-hidden /> Re-reading the page…
                      </span>
                      <span
                        role="progressbar"
                        aria-label="Re-reading the page"
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={Math.round(rereadPct.get(u.id) ?? 0)}
                        className="block h-1.5 w-full max-w-[260px] overflow-hidden rounded-full bg-primary/15"
                      >
                        <span
                          className="gl-progress-fill block h-full min-w-[0.375rem] rounded-full transition-[width] duration-500 ease-out"
                          style={{width: `${rereadPct.get(u.id) ?? 0}%`}}
                        />
                      </span>
                    </span>
                  ) : (
                    u.status === 'failed' &&
                    u.reject_reason && (
                      <span className="truncate text-xs text-[color:var(--status-crit)]" title={u.reject_reason}>
                        {u.reject_reason}
                      </span>
                    )
                  )}
                  <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
                    {ver && <VersionPill version={u.form_version} />}
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
                {canEdit && u.status === 'failed' && (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Re-read ${label.title}`}
                    disabled={rereading.has(u.id)}
                    className="relative z-10 shrink-0 text-muted-foreground hover:text-foreground"
                    onClick={() => reread(u.id)}
                  >
                    {rereading.has(u.id) ? <Loader2 className="size-3.5 animate-spin" /> : <RotateCcw className="size-3.5" />}
                  </Button>
                )}
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
      )}

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

/** A rounded filter chip used across the Type, Status, and Version rows. A leading dot colors
 *  a facet value (version or status); the crit tone tints a chip that must never blend in. */
function FilterChip({active, onClick, tone = 'default', dotColor, children}: {active: boolean; onClick: () => void; tone?: 'default' | 'crit'; dotColor?: string; children: React.ReactNode}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors',
        tone === 'crit'
          ? active
            ? 'border-[color:var(--status-crit)] bg-[color:var(--status-crit)]/15 text-[color:var(--status-crit)]'
            : 'border-[color:var(--status-crit)]/40 bg-[color:var(--status-crit)]/5 text-[color:var(--status-crit)] hover:bg-[color:var(--status-crit)]/12'
          : active
            ? 'border-primary bg-primary/15 text-foreground'
            : 'border-border bg-background text-muted-foreground hover:border-foreground/30 hover:text-foreground',
      )}
    >
      {dotColor && <span aria-hidden className="size-1.5 shrink-0 rounded-full" style={{background: dotColor}} />}
      {children}
    </button>
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
    const canon = reconcileBaNames(data.forms.map((f) => f.consultant), knownBas, {foldFirstName: true});
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
                    replace
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
