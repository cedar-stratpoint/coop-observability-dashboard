import {getDigests} from '@/src/data';
import {getBrief} from '@/src/salesSignals';
import {pickIndex} from '@/src/week';
import {getPosBundles} from '@/src/pos-data';
import {getInventoryPageData} from '@/src/pos-inventory-data';
import {getLocationStock} from '@/src/pos-location-data';
import {getFreeTasteSummary} from '@/src/pos-free-taste-data';
import {getBoxmeInventoryPageData} from '@/src/boxme-inventory-data';
import {InventoryTab} from '@/components/analyst/tabs';
import {InventoryView} from '@/components/analyst/inventory-view';
import {BoxmeInventoryView} from '@/components/analyst/boxme-inventory-view';

export const dynamic = 'force-dynamic';

// D12: the URL param stays `channel`; `offline`/`stratpoint`/`all` alias the merged
// Stratpoint (Offline) catalog (the default), and `online`/`boxme` the BoxMe/online
// scope. This keeps the low-stock email CTA and the Offline Sales "View all"
// snapshot (both deep-linking `?channel=offline`) working with no cross-repo change.
function isOnline(channel: string | undefined): boolean {
  return channel === 'online' || channel === 'boxme';
}

export default async function Page(
  props: {searchParams: Promise<{channel?: string; tab?: string; venue?: string; week?: string}>}
) {
  const searchParams = await props.searchParams;
  if (isOnline(searchParams.channel)) {
    return <OnlineInventory week={searchParams.week} />;
  }
  const tab = searchParams.tab === 'summary' ? 'summary' : searchParams.tab === 'bundles' ? 'bundles' : 'all';
  const venue = searchParams.venue ?? 'all';
  const [data, bundles, locations, sampling] = await Promise.all([
    getInventoryPageData(venue),
    getPosBundles(),
    getLocationStock().catch(() => []),
    getFreeTasteSummary().catch(() => ({windowDays: 30, totalUnits: 0, totalCount: 0, oversoldCount: 0, byProduct: [], recent: []})),
  ]);
  return <InventoryView data={data} bundles={bundles} tab={tab} channel="offline" venue={data.activeVenue} locations={locations} sampling={sampling} />;
}

// D13: the Online scope KEEPS the existing marketplace analytics (digest-driven
// InventoryTab) and puts live BoxMe warehouse stock above it. BoxMe stock comes
// from the boxme_* tables the zoomy-observability boxme-sync job writes daily.
async function OnlineInventory({week}: {week?: string}) {
  const [boxme, digests] = await Promise.all([getBoxmeInventoryPageData(), getDigests()]);
  const row = digests[pickIndex(digests, week)];
  return (
    <div className="pb-8">
      <BoxmeInventoryView data={boxme} />
      <section aria-labelledby="marketplace-analytics" className="mt-10 border-t pt-2">
        <div className="mx-auto max-w-6xl px-6 pt-6 md:px-10 max-md:px-4">
          <h2 id="marketplace-analytics" className="text-lg font-semibold tracking-tight">Marketplace analytics</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">Shopee and Lazada listings from the weekly digest. Separate from BoxMe warehouse stock above.</p>
        </div>
        {row ? <InventoryTab brief={getBrief()} row={row} /> : <div className="mx-auto max-w-5xl px-6 py-6 text-muted-foreground md:px-10">No marketplace digest archived yet.</div>}
      </section>
    </div>
  );
}
