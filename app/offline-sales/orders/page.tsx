import {getPosOrdersPage, getPosOrdersRevenue, getPosOrdersPriceBounds, getPosEvents} from '@/src/pos-sales';
import {getPosProducts, getPosBundles, usingPosMock} from '@/src/pos-data';
import {parseOrdersFilter, parsePage, eventFilterScope, manilaDayKey} from '@/src/pos-sales-compute';
import {OfflineOrdersView} from '@/components/analyst/offline-orders';
import {getOrdersWithPrizes} from '@/src/pos-prize-data';
import type {PosCatalogItem, PosBundleDef} from '@/src/pos-sales-types';

export const dynamic = 'force-dynamic';

type SearchParams = {page?: string; method?: string; status?: string; event?: string; from?: string; to?: string; min?: string; max?: string};

export default async function Page(props: {searchParams: Promise<SearchParams>}) {
  const searchParams = await props.searchParams;
  const filter = parseOrdersFilter(searchParams);
  // Event filter: shown only when the current scope has 2+ events (today's live
  // events by default, or the selected day/range's events). Resolve this BEFORE the
  // order query: when the control is hidden, drop any lingering event param so a
  // stale selection can't keep silently narrowing the list (it has no visible
  // control to clear it). The reassign badge lists every event, so fetch them all.
  const events = await getPosEvents();
  const todayKey = manilaDayKey(new Date().toISOString());
  const eventOptions = eventFilterScope(events, filter, todayKey);
  const showEventFilter = eventOptions.length >= 2;
  const effectiveFilter = showEventFilter ? filter : {...filter, event: 'all'};
  const [{orders, pageInfo}, revenue, bounds, products, bundleRows, prizeOrderUuids] = await Promise.all([
    getPosOrdersPage(parsePage(searchParams.page), effectiveFilter),
    getPosOrdersRevenue(effectiveFilter),
    getPosOrdersPriceBounds(),
    getPosProducts(),
    getPosBundles(),
    getOrdersWithPrizes().catch(() => [] as string[]),
  ]);
  // Slim catalog for the edit-order product picker (listed products only), with
  // category so the editor can restrict a bundle's picks to eligible lines.
  const catalog: PosCatalogItem[] = products
    .filter((p) => p.active)
    .map((p) => ({product_id: p.product_id, name: p.name, price: p.price, category: p.category}));
  // Active bundle definitions for the editor's rules + "add bundle".
  const bundles: PosBundleDef[] = bundleRows
    .filter((b) => b.active)
    .map((b) => ({
      bundle_id: b.bundle_id, name: b.name, price: b.price, bundle_type: b.bundle_type,
      pick_count: b.pick_count, line_categories: b.line_categories, items: b.items,
    }));
  return (
    <OfflineOrdersView
      orders={orders}
      pageInfo={pageInfo}
      revenue={revenue}
      filter={effectiveFilter}
      bounds={bounds}
      catalog={catalog}
      bundles={bundles}
      prizeOrderUuids={prizeOrderUuids}
      events={events}
      eventOptions={eventOptions}
      showEventFilter={showEventFilter}
      usingMock={usingPosMock()}
      fetchedAt={new Date().toISOString()}
    />
  );
}
