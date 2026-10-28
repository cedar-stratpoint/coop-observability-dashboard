import {getPosOrdersPage, getPosOrdersRevenue, getPosOrdersPriceBounds} from '@/src/pos-sales';
import {getPosProducts, getPosBundles, usingPosMock} from '@/src/pos-data';
import {parseOrdersFilter, parsePage} from '@/src/pos-sales-compute';
import {OfflineOrdersView} from '@/components/analyst/offline-orders';
import {getOrdersWithPrizes} from '@/src/pos-prize-data';
import type {PosCatalogItem, PosBundleDef} from '@/src/pos-sales-types';

export const dynamic = 'force-dynamic';

type SearchParams = {page?: string; method?: string; range?: string; min?: string; max?: string};

export default async function Page(props: {searchParams: Promise<SearchParams>}) {
  const searchParams = await props.searchParams;
  const filter = parseOrdersFilter(searchParams);
  const [{orders, pageInfo}, revenue, bounds, products, bundleRows, prizeOrderUuids] = await Promise.all([
    getPosOrdersPage(parsePage(searchParams.page), filter),
    getPosOrdersRevenue(filter),
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
      filter={filter}
      bounds={bounds}
      catalog={catalog}
      bundles={bundles}
      prizeOrderUuids={prizeOrderUuids}
      usingMock={usingPosMock()}
      fetchedAt={new Date().toISOString()}
    />
  );
}
