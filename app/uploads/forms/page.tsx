import {getDataContext} from '@/src/active-context';
import {BackButton} from '@/components/analyst/back-button';
import {canEditData} from '@/src/company';
import {listStores} from '@/src/goldline-data';
import {getCurrentBas} from '@/src/goldline-ba-data';
import {withCanonicalBa} from '@/src/goldline-ba-reconcile';
import {triageBoard} from '@/src/goldline-triage-data';
import {GL_PAGE} from '@/src/goldline-ui';
import {TriageBoard} from '@/components/analyst/triage-board';

export const dynamic = 'force-dynamic';

// All forms: every uploaded inventory page across all scans, sorted into store forms, the
// ones that need you first. Company-scoped like the rest of /uploads.
export default async function Page() {
  const ctx = await getDataContext();
  if (!ctx || !ctx.companyId) {
    return (
      <div className="mx-auto flex min-h-[50vh] max-w-md flex-col items-center justify-center gap-2 text-center">
        <h1 className="font-heading text-lg font-semibold">No company in view</h1>
        <p className="text-sm text-muted-foreground">
          Forms are scoped to a company. Pick a company you belong to, or ask a Coop Admin for access.
        </p>
      </div>
    );
  }
  const [board, stores, baReg] = await Promise.all([
    triageBoard(ctx.companyId),
    listStores(ctx.companyId),
    getCurrentBas(ctx.companyId),
  ]);
  // One canonical spelling per BA across every card (see withCanonicalBa).
  const data = withCanonicalBa(board, baReg.names);
  return (
    <div className={GL_PAGE}>
      <nav className="flex items-center gap-1.5 text-sm text-muted-foreground" aria-label="Breadcrumb">
        <BackButton fallback="/uploads" label="Uploads" />
        <span aria-hidden>·</span>
        <span className="font-medium text-foreground">All forms</span>
      </nav>
      <TriageBoard data={data} company={ctx.companyId} stores={stores} canEdit={canEditData(ctx.role)} embedded />
    </div>
  );
}
