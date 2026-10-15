import {getDataContext} from '@/src/active-context';
import {canEditData} from '@/src/company';
import {getOpsData} from '@/src/goldline-ops-data';
import {buildActions} from '@/src/goldline-actions';
import {GoldlineActionsView, type FeedAction} from '@/components/analyst/goldline-actions-view';

export const dynamic = 'force-dynamic';

// Goldline Action Feed (plan §07h). All stores by default (each card tagged with its
// store), or one store via ?store=. Company + store-scope fenced in getOpsData.
export default async function Page(props: {searchParams: Promise<{store?: string}>}) {
  const ctx = await getDataContext();
  if (!ctx || !ctx.companyId) {
    return (
      <div className="mx-auto flex min-h-[50vh] max-w-md flex-col items-center justify-center gap-2 text-center">
        <h1 className="font-heading text-lg font-semibold">No company in view</h1>
        <p className="text-sm text-muted-foreground">Pick a company you belong to to see its action feed.</p>
      </div>
    );
  }
  const {store: requested} = await props.searchParams;
  const ops = await getOpsData(ctx.companyId, ctx.storeScope ?? null);
  const store = ops.stores.some((s) => s.storeCode === requested) ? (requested as string) : null;
  const catalog = Object.fromEntries(Object.entries(ops.catalog).map(([code, c]) => [code, {name: c.name, price: c.price}]));

  const actions: FeedAction[] = ops.stores
    .filter((s) => !store || s.storeCode === store)
    .flatMap((s) =>
      buildActions({
        storeCode: s.storeCode,
        items: s.movement.items,
        catalog,
        countedCurrent: s.countedCurrent,
        currentPeriod: ops.currentPeriod,
        lastCountEnd: s.movement.latest?.period_end ?? null,
      }).map((a) => ({...a, storeCode: s.storeCode, storeName: s.storeName})),
    )
    // Across stores: same ranking as within one (severity, then pesos at stake).
    .sort(
      (a, b) =>
        ({critical: 0, warn: 1, info: 2})[a.severity] - ({critical: 0, warn: 1, info: 2})[b.severity] ||
        b.impact - a.impact ||
        `${a.storeCode}-${a.id}`.localeCompare(`${b.storeCode}-${b.id}`),
    );

  return (
    <GoldlineActionsView
      actions={actions}
      stores={ops.stores.map((s) => ({code: s.storeCode, name: s.storeName}))}
      store={store}
      period={ops.currentPeriod}
      hasCounts={Boolean(ops.currentPeriod)}
      canEdit={canEditData(ctx.role)}
    />
  );
}
