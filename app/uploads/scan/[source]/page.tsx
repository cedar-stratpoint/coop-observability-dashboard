import Link from 'next/link';
import {LayoutGrid, Users, List, X} from 'lucide-react';
import {BackButton} from '@/components/analyst/back-button';
import {getDataContext} from '@/src/active-context';
import {canEditData} from '@/src/company';
import {listStores, listUploads} from '@/src/goldline-data';
import {getCurrentBas} from '@/src/goldline-ba-data';
import {withCanonicalBa} from '@/src/goldline-ba-reconcile';
import {triageBoard} from '@/src/goldline-triage-data';
import {VERSION_COLOR, VERSION_LABEL} from '@/src/goldline-triage-format';
import type {FormVersion} from '@/src/goldline-extract';
import {uploadSource} from '@/src/goldline-upload-groups';
import {GL_PAGE} from '@/src/goldline-ui';
import {TriageBoard} from '@/components/analyst/triage-board';
import {BaCards, ScanFileList} from '@/components/analyst/scan-views';
import {DeleteScanDialog} from '@/components/analyst/delete-scan-dialog';

export const dynamic = 'force-dynamic';

type View = 'store' | 'ba' | 'file';
const VIEWS: Array<{key: View; label: string; Icon: typeof LayoutGrid}> = [
  {key: 'store', label: 'Per store', Icon: LayoutGrid},
  {key: 'ba', label: 'Per BA', Icon: Users},
  {key: 'file', label: 'Per file', Icon: List},
];

// Oldest form layout first; only versions actually present in the scan get a card.
const VERSION_ORDER: FormVersion[] = ['legacy', 'v1', 'v2', 'unknown'];
const isVersion = (v: string | undefined): v is FormVersion => !!v && (VERSION_ORDER as string[]).includes(v);

/** Build a scan URL, keeping the params that still apply. */
function scanHref(source: string, p: {view: View; ba?: string | null; version?: FormVersion | null}) {
  const qs = new URLSearchParams({view: p.view});
  if (p.ba) qs.set('ba', p.ba);
  if (p.version) qs.set('version', p.version);
  return `/uploads/scan/${encodeURIComponent(source)}?${qs.toString()}`;
}

// One scan drop: its pages sorted into store forms, grouped by BA, or listed as plain
// files — one toggle, all on this route so Back returns here. Company-scoped like the
// rest of /uploads.
export default async function Page({params, searchParams}: {params: Promise<{source: string}>; searchParams: Promise<{view?: string; ba?: string; version?: string}>}) {
  const {source: raw} = await params;
  const {view: viewRaw, ba: baRaw, version: versionRaw} = await searchParams;
  const source = decodeURIComponent(raw);
  const view: View = viewRaw === 'ba' || viewRaw === 'file' ? viewRaw : 'store';
  const ba = typeof baRaw === 'string' ? baRaw : null;
  const version = isVersion(versionRaw) ? versionRaw : null;

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

  // The board is read in every view (not just store/BA) so the version summary can count
  // forms per layout even on the file view; stores/BAs are only needed off the file view.
  const needBas = view !== 'file';
  const [rawBoard, stores, uploads, baReg] = await Promise.all([
    triageBoard(companyId, {source}),
    view === 'file' ? Promise.resolve([]) : listStores(companyId),
    view === 'file' ? listUploads(companyId) : Promise.resolve([]),
    needBas ? getCurrentBas(companyId) : Promise.resolve({byStore: {}, names: [] as string[]}),
  ]);

  // How many forms of each layout are in this scan — the summary cards, and a filter.
  const versionCounts = rawBoard.forms.reduce((m, f) => ((m[f.version] = (m[f.version] ?? 0) + 1), m), {} as Partial<Record<FormVersion, number>>);
  const totalForms = rawBoard.forms.length;

  const files =
    view === 'file'
      ? uploads.filter((u) => uploadSource(u.filename) === source && (!version || (u.form_version ?? 'unknown') === version))
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

  const href = (v: View) => scanHref(source, {view: v, version});

  return (
    <div className={GL_PAGE}>
      {/* Breadcrumb — the chevron steps back to where you came from, not a fixed page. */}
      <nav className="flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground" aria-label="Breadcrumb">
        <BackButton fallback="/uploads" label="Uploads" />
        <span aria-hidden>·</span>
        <span className="min-w-0 truncate font-medium text-foreground" title={source}>{source}</span>
      </nav>

      {/* Form-version summary: how many forms of each layout, and a one-click filter. */}
      {totalForms > 0 && (
        <div className="flex flex-wrap items-stretch gap-2.5" role="group" aria-label="Filter by form version">
          <VersionCard href={scanHref(source, {view, ba, version: null})} label="All versions" count={totalForms} color={null} active={!version} />
          {VERSION_ORDER.filter((v) => (versionCounts[v] ?? 0) > 0).map((v) => (
            <VersionCard
              key={v}
              href={scanHref(source, {view, ba, version: version === v ? null : v})}
              label={VERSION_LABEL[v]}
              count={versionCounts[v] ?? 0}
              color={VERSION_COLOR[v]}
              active={version === v}
            />
          ))}
        </div>
      )}

      {/* Toggle */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="inline-flex rounded-lg border border-border p-0.5" role="tablist" aria-label="View this scan by">
          {VIEWS.map(({key, label, Icon}) => {
            const active = view === key;
            return (
              <Link
                key={key}
                href={href(key)}
                replace
                role="tab"
                aria-selected={active}
                className={
                  'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ' +
                  (active ? 'bg-primary/10 text-foreground' : 'text-muted-foreground hover:text-foreground')
                }
              >
                <Icon className="size-3.5" /> {label}
              </Link>
            );
          })}
        </div>
        {ba && view === 'store' && (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-xs font-medium">
            BA · {ba}
            <Link href={href('store')} replace aria-label="Clear BA filter" className="text-muted-foreground hover:text-foreground">
              <X className="size-3" />
            </Link>
          </span>
        )}
        {canEdit && (
          <div className="ml-auto">
            <DeleteScanDialog company={companyId} source={source} />
          </div>
        )}
      </div>

      {view === 'file' ? (
        <ScanFileList files={files} canEdit={canEdit} company={companyId} version={version} />
      ) : view === 'ba' ? (
        board && <BaCards data={board} source={source} knownBas={baReg.names} canEdit={canEdit} company={companyId} />
      ) : (
        data && <TriageBoard data={data} company={companyId} scan={source} stores={stores} canEdit={canEdit} embedded />
      )}
    </div>
  );
}

/** A form-version summary card above the view toggle: the layout, its form count, and a
 *  one-click filter for the view below. The active card wears the version's own colour. */
function VersionCard({href, label, count, color, active}: {href: string; label: string; count: number; color: string | null; active: boolean}) {
  const accent = color ?? 'var(--foreground)';
  return (
    <Link
      href={href}
      replace
      aria-pressed={active}
      className="group flex min-w-[108px] flex-col gap-0.5 rounded-xl border px-3.5 py-2.5 transition-[transform,box-shadow,border-color] duration-150 ease-out hover:-translate-y-0.5 hover:shadow-sm focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/35 motion-reduce:transition-none motion-reduce:hover:translate-y-0"
      style={{
        borderColor: active ? `color-mix(in oklab, ${accent} 55%, transparent)` : 'var(--border)',
        background: active ? `color-mix(in oklab, ${accent} 10%, transparent)` : 'transparent',
      }}
    >
      <span className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
        {color && <span aria-hidden className="size-1.5 rounded-full" style={{background: color}} />}
        {label}
      </span>
      <span className="font-heading text-xl font-semibold tabular-nums" style={active ? {color: accent} : undefined}>
        {count}
      </span>
      <span className="text-[11px] text-muted-foreground">{count === 1 ? 'form' : 'forms'}</span>
    </Link>
  );
}
