import Link from 'next/link';
import {ChevronLeft, LayoutGrid, Users, List, X} from 'lucide-react';
import {getDataContext} from '@/src/active-context';
import {canEditData} from '@/src/company';
import {listStores, listUploads} from '@/src/goldline-data';
import {triageBoard} from '@/src/goldline-triage-data';
import {uploadSource} from '@/src/goldline-upload-groups';
import {GL_PAGE} from '@/src/goldline-ui';
import {TriageBoard} from '@/components/analyst/triage-board';
import {BaCards, ScanFileList} from '@/components/analyst/scan-views';

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

  const [board, stores, uploads] = await Promise.all([
    view === 'file' ? Promise.resolve(null) : triageBoard(companyId, {source}),
    view === 'file' ? Promise.resolve([]) : listStores(companyId),
    view === 'file' ? listUploads(companyId) : Promise.resolve([]),
  ]);
  const files = view === 'file' ? uploads.filter((u) => uploadSource(u.filename) === source) : [];
  // Per-store, filtered to one BA when arriving from a BA card.
  const data = board && ba ? {...board, forms: board.forms.filter((f) => (f.consultant?.trim() || 'No BA on the form') === ba)} : board;

  const href = (v: View) => `/uploads/scan/${encodeURIComponent(source)}?view=${v}`;

  return (
    <div className={GL_PAGE}>
      {/* Breadcrumb */}
      <nav className="flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground" aria-label="Breadcrumb">
        <Link href="/uploads" className="inline-flex items-center gap-1 transition-colors hover:text-foreground">
          <ChevronLeft className="size-4" /> Uploads
        </Link>
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
      </div>

      {view === 'file' ? (
        <ScanFileList files={files} canEdit={canEdit} company={companyId} />
      ) : view === 'ba' ? (
        board && <BaCards data={board} source={source} />
      ) : (
        data && <TriageBoard data={data} company={companyId} scan={source} stores={stores} canEdit={canEdit} embedded />
      )}
    </div>
  );
}
