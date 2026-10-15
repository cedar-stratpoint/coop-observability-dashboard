import {getDataContext} from '@/src/active-context';
import {getGoldlineAnalytics} from '@/src/goldline-analytics';
import {GoldlineStoresView} from '@/components/analyst/goldline-stores-view';

export const dynamic = 'force-dynamic';

// Store leaderboard, scoped to the active company's gl_sales. Not behind the
// Zoomy guard — it shows whichever company is active (Zoomy has no gl_* data, so
// it renders empty there; the nav only surfaces it for non-Zoomy companies).
export default async function Page() {
  const ctx = await getDataContext();
  if (!ctx || !ctx.companyId) {
    return (
      <div className="mx-auto flex min-h-[50vh] max-w-md flex-col items-center justify-center gap-2 text-center">
        <h1 className="font-heading text-lg font-semibold">No company in view</h1>
        <p className="text-sm text-muted-foreground">Pick a company you belong to to see its stores.</p>
      </div>
    );
  }
  const {byStore, summary} = await getGoldlineAnalytics(ctx.companyId);
  return <GoldlineStoresView stores={byStore} summary={summary} />;
}
