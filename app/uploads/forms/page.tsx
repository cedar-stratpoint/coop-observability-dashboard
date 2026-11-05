import Link from 'next/link';
import {ChevronLeft} from 'lucide-react';
import {getDataContext} from '@/src/active-context';
import {canEditData} from '@/src/company';
import {listStores} from '@/src/goldline-data';
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
  const [data, stores] = await Promise.all([triageBoard(ctx.companyId), listStores(ctx.companyId)]);
  return (
    <div className={GL_PAGE}>
      <nav className="flex items-center gap-1.5 text-sm text-muted-foreground" aria-label="Breadcrumb">
        <Link href="/uploads" className="inline-flex items-center gap-1 transition-colors hover:text-foreground">
          <ChevronLeft className="size-4" /> Uploads
        </Link>
        <span aria-hidden>·</span>
        <span className="font-medium text-foreground">All forms</span>
      </nav>
      <TriageBoard data={data} company={ctx.companyId} stores={stores} canEdit={canEditData(ctx.role)} embedded />
    </div>
  );
}
