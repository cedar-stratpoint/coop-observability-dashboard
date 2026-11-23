import Link from 'next/link';
import {X} from 'lucide-react';
import {BackButton} from '@/components/analyst/back-button';
import {getDataContext} from '@/src/active-context';
import {canEditData} from '@/src/company';
import {listStores, listUploads, reconcileStaleReads} from '@/src/goldline-data';
import {getCurrentBas} from '@/src/goldline-ba-data';
import {withCanonicalBa} from '@/src/goldline-ba-reconcile';
import {triageBoard} from '@/src/goldline-triage-data';
import {VERSION_COLOR, VERSION_LABEL} from '@/src/goldline-triage-format';
import {VersionPreviewButton} from '@/components/analyst/version-preview';
import {formVersionPreview} from '@/src/goldline-form-versions';
import type {FormVersion} from '@/src/goldline-extract';
import {uploadSource} from '@/src/goldline-upload-groups';
import {GL_PAGE} from '@/src/goldline-ui';
import {TriageBoard} from '@/components/analyst/triage-board';
import {BaCards, ScanFileList} from '@/components/analyst/scan-views';
import {DeleteScanDialog} from '@/components/analyst/delete-scan-dialog';
import {ScanReadingCard} from '@/components/analyst/scan-reading';
import {ScanViewTabs, type ScanView} from '@/components/analyst/scan-view-tabs';

export const dynamic = 'force-dynamic';

type View = ScanView;

// Oldest form layout first; only versions actually present in the scan get a card.
const VERSION_ORDER: FormVersion[] = ['legacy', 'v1', 'v2', 'unknown'];
const isVersion = (v: string | undefined): v is FormVersion => !!v && (VERSION_ORDER as string[]).includes(v);

/** Build a scan URL, keeping the params that still apply. `batch` pins the view to one upload
 *  drop (so re-uploads of the same file don't aggregate); it is preserved across every link. */
function scanHref(source: string, p: {view: View; ba?: string | null; version?: FormVersion | null; batch?: string | null}) {
  const qs = new URLSearchParams({view: p.view});
  if (p.batch) qs.set('batch', p.batch);
  if (p.ba) qs.set('ba', p.ba);
  if (p.version) qs.set('version', p.version);
  return `/uploads/scan/${encodeURIComponent(source)}?${qs.toString()}`;
}

// One scan drop: its pages sorted into store forms, grouped by BA, or listed as plain
// files — one toggle, all on this route so Back returns here. Company-scoped like the
// rest of /uploads.
export default async function Page({params, searchParams}: {params: Promise<{source: string}>; searchParams: Promise<{view?: string; ba?: string; version?: string; batch?: string}>}) {
  const {source: raw} = await params;
  const {view: viewRaw, ba: baRaw, version: versionRaw, batch: batchRaw} = await searchParams;
  const source = decodeURIComponent(raw);
  // Per file is the default view (the plain page list reviewers start from); Per store and
  // Per BA are a tab away.
  const view: View = viewRaw === 'ba' || viewRaw === 'store' ? viewRaw : 'file';
  const ba = typeof baRaw === 'string' ? baRaw : null;
  const version = isVersion(versionRaw) ? versionRaw : null;
  // One upload drop of this scan (set by the Uploads list tile). Without it, the page keeps its
  // legacy behavior: every upload whose filename shares this source name.
  const batchId = typeof batchRaw === 'string' && batchRaw ? batchRaw : null;

  const ctx = await getDataContext();
  if (!ctx || !ctx.companyId) {
    return (
      <div className="mx-auto flex min-h-[50vh] max-w-md flex-col items-center justify-center gap-2 text-center">
        <h1 className="font-heading text-lg font-semibold">No company in view</h1>
        <p className="text-sm text-muted-foreground">This scan is scoped to a company. Pick a company you belong to, or ask a Coop Admin for access.</p>
      </div>
    );
  }
  const companyId = ctx.companyId;
  const canEdit = canEditData(ctx.role);

  // Reset this scan's orphaned reads (stuck 'processing' past the read window) to 'failed'
  // before showing it, so a page is never frozen on the spinner and can be re-read.
  if (canEdit) await reconcileStaleReads(companyId, {source});

  // The board is read in every view (not just store/BA) so the version summary can count
  // forms per layout even on the file view; stores/BAs are only needed off the file view.
  const needBas = view !== 'file';
  const [rawBoard, stores, uploads, baReg] = await Promise.all([
    triageBoard(companyId, {source, batchId: batchId ?? undefined}),
    view === 'file' ? Promise.resolve([]) : listStores(companyId),
    // Always listed (cached, shared with the Uploads page) so every view can read the
    // optional upload name the user gave this scan; `files` below still only uses it on the file view.
    listUploads(companyId),
    needBas ? getCurrentBas(companyId) : Promise.resolve({byStore: {}, names: [] as string[]}),
  ]);

  // The name the user typed for this drop (same on every page of the batch), shown as the
  // scan's title with the file name as a quiet subtitle. Null when they named nothing.
  const scanName = uploads.find((u) => uploadSource(u.filename) === source && (!batchId || u.batch_id === batchId) && u.batch_name?.trim())?.batch_name?.trim() ?? null;

  // How many forms of each layout are in this scan — the summary cards, and a filter.
  const versionCounts = rawBoard.forms.reduce((m, f) => ((m[f.version] = (m[f.version] ?? 0) + 1), m), {} as Partial<Record<FormVersion, number>>);
  const totalForms = rawBoard.forms.length;

  const files =
    view === 'file'
      ? uploads.filter((u) => uploadSource(u.filename) === source && (!batchId || u.batch_id === batchId) && (!version || (u.form_version ?? 'unknown') === version))
      : [];
  // The same person is written many ways; reconcile to one canonical BA (a registry name
  // when known) so every card reads it the same way and a BA card groups all their forms.
  const board = view === 'file' ? null : withCanonicalBa(rawBoard, baReg.names, {foldFirstName: true});
  const baOf = (c: string | null) => (c?.trim() ? c.trim() : 'No BA on the form');
  // Per-store/BA, narrowed to one BA (arriving from a BA card) and/or one form version
  // (a summary card). Labels are already canonical.
  const data =
    board && (ba || version)
      ? {...board, forms: board.forms.filter((f) => (!ba || baOf(f.consultant) === ba) && (!version || f.version === version))}
      : board;

  const href = (v: View) => scanHref(source, {view: v, version, batch: batchId});

  return (
    <div className={GL_PAGE}>
      {/* Header: back to Uploads, the scan's name as the title (file name beneath when the user
          named it), and the whole-scan action on the right. */}
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex min-w-0 flex-col gap-1.5">
          <nav aria-label="Breadcrumb" className="text-sm text-muted-foreground">
            <BackButton fallback="/uploads" label="Uploads" className="-ml-1 inline-flex items-center gap-0.5 rounded-md px-1 py-0.5 transition-colors hover:text-foreground" />
          </nav>
          <h1 className="min-w-0 truncate font-heading text-2xl font-semibold tracking-tight" title={scanName ?? source}>
            {scanName ?? source}
          </h1>
          {scanName && (
            <p className="truncate font-mono text-xs text-muted-foreground/80" title={source}>
              {source}
            </p>
          )}
        </div>
        {canEdit && (
          <div className="-mr-2 sm:shrink-0">
            <DeleteScanDialog company={companyId} source={source} batchId={batchId} />
          </div>
        )}
      </header>

      {/* Still reading on the server: appears (and survives a refresh) while this scan's pages
          are being read, so a store manager knows more forms are coming and there is nothing
          to act on yet. Scoped to this scan; self-hides once it settles. */}
      <ScanReadingCard scan={source} />

      {/* Form-version summary: one panel of segments (how many forms of each layout, a one-click
          filter) over a thin bar showing the scan's version mix. */}
      {totalForms > 0 && (
        <div className="flex w-full flex-col gap-2 rounded-2xl border border-border bg-card p-1.5 sm:w-fit" role="group" aria-label="Filter by form version">
          <div className="flex flex-wrap gap-1">
            <VersionCard href={scanHref(source, {view, ba, version: null, batch: batchId})} label="All forms" count={totalForms} color={null} active={!version} />
            {VERSION_ORDER.filter((v) => (versionCounts[v] ?? 0) > 0).map((v) => (
              <VersionCard
                key={v}
                href={scanHref(source, {view, ba, version: version === v ? null : v, batch: batchId})}
                label={VERSION_LABEL[v]}
                count={versionCounts[v] ?? 0}
                color={VERSION_COLOR[v]}
                active={version === v}
                previewVersion={v}
              />
            ))}
          </div>
          <div className="flex h-1 gap-0.5 overflow-hidden rounded-full px-1.5 pb-0.5" aria-hidden>
            {VERSION_ORDER.filter((v) => (versionCounts[v] ?? 0) > 0).map((v) => (
              <span
                key={v}
                className="h-full rounded-full transition-opacity duration-200"
                style={{flexGrow: versionCounts[v] ?? 0, background: VERSION_COLOR[v], opacity: !version || version === v ? 1 : 0.25}}
              />
            ))}
          </div>
        </div>
      )}

      {/* View switch */}
      <div className="flex flex-wrap items-center gap-3">
        <ScanViewTabs view={view} hrefs={{file: href('file'), store: href('store'), ba: href('ba')}} />
        {ba && view === 'store' && (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-xs font-medium">
            BA · {ba}
            <Link href={href('store')} replace aria-label="Clear BA filter" className="text-muted-foreground hover:text-foreground">
              <X className="size-3" />
            </Link>
          </span>
        )}
      </div>

      {view === 'file' ? (
        <ScanFileList files={files} canEdit={canEdit} company={companyId} version={version} />
      ) : view === 'ba' ? (
        board && <BaCards data={board} source={source} knownBas={baReg.names} canEdit={canEdit} company={companyId} batchId={batchId} />
      ) : (
        data && <TriageBoard data={data} company={companyId} scan={source} stores={stores} canEdit={canEdit} embedded baScope={ba} />
      )}
    </div>
  );
}

/** One segment of the form-version panel: the layout, its form count, and a one-click filter for
 *  the view below. The active segment is tinted in the version's own colour. */
function VersionCard({href, label, count, color, active, previewVersion}: {href: string; label: string; count: number; color: string | null; active: boolean; previewVersion?: string}) {
  const accent = color ?? 'var(--foreground)';
  const preview = previewVersion ? formVersionPreview(previewVersion) : null;
  const link = (
    <Link
      href={href}
      replace
      aria-pressed={active}
      className={
        'flex min-w-[7.5rem] flex-1 flex-col gap-1 rounded-xl px-4 py-3 transition-[background-color,box-shadow,transform] duration-150 ease-out active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 motion-reduce:transition-none sm:flex-none ' +
        (active ? '' : 'hover:bg-muted/60')
      }
      style={active ? {background: `color-mix(in oklab, ${accent} 12%, transparent)`, boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${accent} 38%, transparent)`} : undefined}
    >
      <span className="flex items-center gap-1.5 pr-6 text-xs font-medium text-muted-foreground">
        {color && <span aria-hidden className="size-2 rounded-full" style={{background: color}} />}
        {label}
      </span>
      <span className="flex items-baseline gap-1.5">
        <span className="font-heading text-2xl leading-none font-semibold tracking-tight tabular-nums" style={active && color ? {color: accent} : undefined}>
          {count}
        </span>
        <span className="text-xs text-muted-foreground">{count === 1 ? 'form' : 'forms'}</span>
      </span>
    </Link>
  );
  if (!preview) return link;
  // A small Preview affordance on the segment (sibling to the filter Link, not nested), opening a
  // modal with that version's reference form pages.
  return (
    <div className="relative flex flex-1 sm:flex-none">
      {link}
      <VersionPreviewButton version={previewVersion!} className="absolute top-2 right-2 z-10 size-6 border-transparent bg-transparent backdrop-blur-none" />
    </div>
  );
}
