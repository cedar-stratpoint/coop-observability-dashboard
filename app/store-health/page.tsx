import {getDataContext} from '@/src/active-context';
import {canEditData} from '@/src/company';
import {getOpsData} from '@/src/goldline-ops-data';
import {GoldlineHealthView} from '@/components/analyst/goldline-health-view';

export const dynamic = 'force-dynamic';

// Goldline store & stock health. Zoomy's /health (QRR) is Zoomy-only; Goldline has no
// orders or acquisition cost, so its health is scored from stock and form data.
// Company + store-scope fenced in getOpsData.
export default async function Page() {
  const ctx = await getDataContext();
  if (!ctx || !ctx.companyId) {
    return (
      <div className="mx-auto flex min-h-[50vh] max-w-md flex-col items-center justify-center gap-2 text-center">
        <h1 className="font-heading text-lg font-semibold">No company in view</h1>
        <p className="text-sm text-muted-foreground">Pick a company you belong to to see its store health.</p>
      </div>
    );
  }
  const ops = await getOpsData(ctx.companyId, ctx.storeScope ?? null);
  return (
    <GoldlineHealthView
      rows={ops.stores.map((s) => ({storeCode: s.storeCode, storeName: s.storeName, health: s.health}))}
      period={ops.currentPeriod}
      canEdit={canEditData(ctx.role)}
    />
  );
}
