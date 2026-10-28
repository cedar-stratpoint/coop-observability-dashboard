import {getDataContext} from '@/src/active-context';
import {canEditData} from '@/src/company';
import {getFlagsData} from '@/src/goldline-flags-data';
import {GoldlineFlags} from '@/components/analyst/goldline-flags';

export const dynamic = 'force-dynamic';

// Flag queue and adjustments (Goldline · F7, F5). Store-scoped roles see their stores only.
export default async function Page(props: {searchParams: Promise<{open?: string; month?: string}>}) {
  const sp = await props.searchParams;
  const ctx = await getDataContext();
  if (!ctx || !ctx.companyId) {
    return (
      <div className="mx-auto flex min-h-[50vh] max-w-md flex-col items-center justify-center gap-2 text-center">
        <h1 className="font-heading text-lg font-semibold">No company in view</h1>
        <p className="text-sm text-muted-foreground">Pick a company you belong to to see its flags.</p>
      </div>
    );
  }
  const scope = Array.isArray(ctx.storeScope) ? ctx.storeScope : null;
  const data = await getFlagsData(ctx.companyId, scope);
  // Deep link from the BA scorecard: ?open=<store|YYYY-MM|BA> opens that tile.
  const open = typeof sp.open === 'string' && data.tiles.some((t) => t.key === sp.open) ? sp.open : null;
  const month = typeof sp.month === 'string' && /^\d{4}-\d{2}$/.test(sp.month) ? sp.month : (open?.split('|')[1] ?? null);
  return <GoldlineFlags company={ctx.companyId} data={data} canEdit={canEditData(ctx.role)} initialOpen={open} initialMonth={month} />;
}
