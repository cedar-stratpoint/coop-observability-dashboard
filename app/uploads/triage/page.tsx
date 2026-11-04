import {getDataContext} from '@/src/active-context';
import {canEditData} from '@/src/company';
import {listStores} from '@/src/goldline-data';
import {triageBoard} from '@/src/goldline-triage-data';
import {TriageBoard} from '@/components/analyst/triage-board';

export const dynamic = 'force-dynamic';

// Scan triage: the uploaded inventory-PDF pages, sorted into store · period · version
// forms (Phase 2). Scoped to the active company like the rest of /uploads — a
// data-blind Coop Admin or a non-member sees the gate, never data.
export default async function Page() {
  const ctx = await getDataContext();
  if (!ctx || !ctx.companyId) {
    return (
      <div className="mx-auto flex min-h-[50vh] max-w-md flex-col items-center justify-center gap-2 text-center">
        <h1 className="font-heading text-lg font-semibold">No company in view</h1>
        <p className="text-sm text-muted-foreground">
          Scan triage is scoped to a company. Pick a company you belong to, or ask a Coop Admin for access.
        </p>
      </div>
    );
  }
  const [data, stores] = await Promise.all([triageBoard(ctx.companyId), listStores(ctx.companyId)]);
  return <TriageBoard data={data} company={ctx.companyId} stores={stores} canEdit={canEditData(ctx.role)} />;
}
