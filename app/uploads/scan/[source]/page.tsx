import Link from 'next/link';
import {LayoutGrid, Users, List, X} from 'lucide-react';
import {BackButton} from '@/components/analyst/back-button';
import {getDataContext} from '@/src/active-context';
import {canEditData} from '@/src/company';
import {listStores, listUploads} from '@/src/goldline-data';
import {getCurrentBas} from '@/src/goldline-ba-data';
import {withCanonicalBa} from '@/src/goldline-ba-reconcile';
import {triageBoard} from '@/src/goldline-triage-data';
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

// One scan drop: its pages sorted into store forms, grouped by BA, or listed as plain
// files — one toggle, all on this route so Back returns here. Company-scoped like the
// rest of /uploads.
export default async function Page({params, searchParams}: {params: Promise<{source: string}>; searchParams: Promise<{view?: string; ba?: string}>}) {
  const {source: raw} = await params;
  const {view: viewRaw, ba: baRaw} = await searchParams;
  const source = decodeURIComponent(raw);
  const view: View = viewRaw === 'ba' || viewRaw === 'file' ? viewRaw : 'store';
  const ba = typeof baRaw === 'string' ? baRaw : null;

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

  const needBas = view !== 'file';
  const [rawBoard, stores, uploads, baReg] = await Promise.all([
    view === 'file' ? Promise.resolve(null) : triageBoard(companyId, {source}),
    view === 'file' ? Promise.resolve([]) : listStores(companyId),
    view === 'file' ? listUploads(companyId) : Promise.resolve([]),
    needBas ? getCurrentBas(companyId) : Promise.resolve({byStore: {}, names: [] as string[]}),
  ]);
  const files = view === 'file' ? uploads.filter((u) => uploadSource(u.filename) === source) : [];
  // The same person is written many ways; reconcile to one canonical BA (a registry name
  // when known) so every card reads it the same way and a BA card groups all their forms.
  const board = rawBoard ? withCanonicalBa(rawBoard, baReg.names) : rawBoard;
  const baOf = (c: string | null) => (c?.trim() ? c.trim() : 'No BA on the form');
  // Per-store, filtered to one BA when arriving from a BA card (labels already canonical).
  const data = board && ba ? {...board, forms: board.forms.filter((f) => baOf(f.consultant) === ba)} : board;

  const href = (v: View) => `/uploads/scan/${encodeURIComponent(source)}?view=${v}`;

  return (
    <div className={GL_PAGE}>
      {/* Breadcrumb — the chevron steps back to where you came from, not a fixed page. */}
      <nav className="flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground" aria-label="Breadcrumb">
        <BackButton fallback="/uploads" label="Uploads" />
        <span aria-hidden>·</span>
        <span className="min-w-0 truncate font-medium text-foreground" title={source}>{source}</span>
      </nav>

      {/* Toggle */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="inline-flex rounded-lg border border-border p-0.5" role="tablist" aria-label="View this scan by">
          {VIEWS.map(({key, label, Icon}) => {
            const active = view === key;
            return (
              <Link
                key={key}
                href={href(key)}
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
            <Link href={href('store')} aria-label="Clear BA filter" className="text-muted-foreground hover:text-foreground">
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
        <ScanFileList files={files} canEdit={canEdit} company={companyId} />
      ) : view === 'ba' ? (
        board && <BaCards data={board} source={source} knownBas={baReg.names} canEdit={canEdit} company={companyId} />
      ) : (
        data && <TriageBoard data={data} company={companyId} scan={source} stores={stores} canEdit={canEdit} embedded />
      )}
    </div>
  );
}
