import {getDataContext} from '@/src/active-context';
import {canEditData} from '@/src/company';
import {goldlineConfigured, listStores, listUploads} from '@/src/goldline-data';
import {UploadsView} from '@/components/analyst/uploads-view';

export const dynamic = 'force-dynamic';

// Uploads home: the per-company ingestion inbox. Scoped by the active company —
// a data-blind Coop Admin or a user with no membership sees the gate, never data.
export default async function Page(props: {searchParams: Promise<{status?: string}>}) {
  const ctx = await getDataContext();
  if (!ctx || !ctx.companyId) {
    return (
      <div className="mx-auto flex min-h-[50vh] max-w-md flex-col items-center justify-center gap-2 text-center">
        <h1 className="font-heading text-lg font-semibold">No company in view</h1>
        <p className="text-sm text-muted-foreground">
          Uploads are scoped to a company. Pick a company you belong to, or ask a Coop Admin for access.
        </p>
      </div>
    );
  }
  const [uploads, stores] = await Promise.all([listUploads(ctx.companyId), listStores(ctx.companyId)]);
  // ?status=needs_review (e.g. from Inventory's "Review" link) pre-sets the filter.
  const {status} = await props.searchParams;
  const STATUSES = ['needs_review', 'committed', 'processing', 'failed', 'rejected'] as const;
  const initialStatus = STATUSES.find((s) => s === status) ?? 'all';
  return (
    <UploadsView
      company={ctx.companyId}
      canEdit={canEditData(ctx.role)}
      configured={goldlineConfigured()}
      uploads={uploads}
      initialStatus={initialStatus}
      stores={stores}
    />
  );
}
