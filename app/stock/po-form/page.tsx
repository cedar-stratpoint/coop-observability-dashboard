import {getDataContext} from '@/src/active-context';
import {canEditData} from '@/src/company';
import {poFormView} from '@/src/goldline-po-form-data';
import {PoFormPage} from '@/components/analyst/po-form';

export const dynamic = 'force-dynamic';

// The PO form (NICH-17, PO leg): upload Nichido's PURCHASE ORDER FORM, review what was
// read, and make it the list of active products.
export default async function Page(props: {searchParams: Promise<{form?: string}>}) {
  const ctx = await getDataContext();
  if (!ctx || !ctx.companyId) {
    return (
      <div className="mx-auto flex min-h-[50vh] max-w-md flex-col items-center justify-center gap-2 text-center">
        <h1 className="font-heading text-lg font-semibold">No company in view</h1>
        <p className="text-sm text-muted-foreground">The PO form is scoped to a company. Pick one you belong to.</p>
      </div>
    );
  }
  const sp = await props.searchParams;
  const form = sp.form && /^[0-9a-f-]{36}$/i.test(sp.form) ? sp.form : null;
  const data = await poFormView(ctx.companyId, form);
  const canEdit = canEditData(ctx.role) && !ctx.storeScope;
  return <PoFormPage data={data} company={ctx.companyId} canEdit={canEdit} />;
}
