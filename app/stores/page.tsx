import {getDataContext} from '@/src/active-context';
import {getGoldlineAnalytics} from '@/src/goldline-analytics';
import {getStoreScope} from '@/src/goldline-ref-data';
import {canEditData} from '@/src/company';
import {GoldlineStoresView} from '@/components/analyst/goldline-stores-view';

export const dynamic = 'force-dynamic';

// Store leaderboard, scoped to the active company's sales. Not behind the
// Zoomy guard — it shows whichever company is active (Zoomy has no Goldline data, so
// it renders empty there; the nav only surfaces it for non-Zoomy companies).
const SORTS = new Set(['gross', 'units', 'net', 'name'] as const);

// ?sort=gross|units|net|name picks the starting sort, so an Overview tile opens the
// leaderboard ranked by the figure that was clicked.
export default async function Page(props: {searchParams: Promise<{sort?: string}>}) {
  const ctx = await getDataContext();
  if (!ctx || !ctx.companyId) {
    return (
      <div className="mx-auto flex min-h-[50vh] max-w-md flex-col items-center justify-center gap-2 text-center">
        <h1 className="font-heading text-lg font-semibold">No company in view</h1>
        <p className="text-sm text-muted-foreground">Pick a company you belong to to see its stores.</p>
      </div>
    );
  }
  const {sort} = await props.searchParams;
  const initialSort = sort && SORTS.has(sort as 'gross') ? (sort as 'gross' | 'units' | 'net' | 'name') : undefined;
  const [{byStore, summary}, scope] = await Promise.all([getGoldlineAnalytics(ctx.companyId), getStoreScope(ctx.companyId).catch(() => [])]);
  return (
    <GoldlineStoresView
      company={ctx.companyId}
      stores={byStore}
      summary={summary}
      scope={scope}
      canEditScope={canEditData(ctx.role) && !ctx.storeScope}
      initialSort={initialSort}
    />
  );
}
