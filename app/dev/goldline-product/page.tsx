// DEV-ONLY preview of the Goldline product page on synthetic counts. 404 in production.
// ?view=single (default) · all · one (a single count) · none (never counted)
import {notFound} from 'next/navigation';
import {productView, type ItemCount, type ProductInfo, type StoreInput} from '@/src/goldline-product';
import {GoldlineProductView} from '@/components/analyst/goldline-product-view';

const INFO: ProductInfo = {itemCode: 'TWC01152', name: 'Natural', productLine: 'Two Way Cake', price: 185, bestseller: true, skuLinked: false};
const SEASON: Record<number, number> = {1: 0.7, 2: 0.8, 3: 0.9, 4: 1, 5: 1, 6: 0.9, 7: 0.9, 8: 1, 9: 1.1, 10: 1, 11: 1.2, 12: 1.5};

/** Half-month counts from `from` to Oct 15 2026: steady selling, restocked when low. */
function history(from: string, perHalf: number, start: number, restock: number): ItemCount[] {
  const out: ItemCount[] = [];
  let onHand = start;
  let [y, m] = from.split('-').map(Number);
  let half = 1;
  for (;;) {
    const mm = String(m).padStart(2, '0');
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const period_start = `${y}-${mm}-${half === 1 ? '01' : '16'}`;
    const period_end = `${y}-${mm}-${half === 1 ? '15' : String(last)}`;
    const sold = Math.round(perHalf * SEASON[m]);
    const delivery = onHand - sold < perHalf ? restock : 0;
    onHand = Math.max(0, onHand + delivery - sold);
    const sell = Math.min(onHand, 6);
    out.push({item_code: INFO.itemCode, period_start, period_end, stockroom: onHand - sell, drawer: 0, selling_area: sell, delivery, ending_on_hand: null});
    if (period_end === '2026-10-15') break;
    if (half === 2) {
      half = 1;
      m += 1;
      if (m === 13) {
        m = 1;
        y += 1;
      }
    } else half = 2;
  }
  return out;
}

export default async function Page(props: {searchParams: Promise<{view?: string; store?: string}>}) {
  if (process.env.NODE_ENV === 'production') notFound();
  const {view = 'single', store} = await props.searchParams;
  const NOW = new Date('2026-10-20T00:00:00Z');
  const stores: StoreInput[] = [
    {storeCode: '1', storeName: 'CUBAO', counts: history('2025-07', 20, 60, 60), sales: null},
    {storeCode: '2', storeName: 'MAKATI', counts: history('2026-06', 3, 30, 20), sales: null},
    {storeCode: '3', storeName: 'QUEZON CITY', counts: history('2026-07', 2, 26, 10), sales: null},
    {storeCode: '4', storeName: 'CEBU', counts: history('2026-08', 5, 12, 0), sales: null},
    {storeCode: '5', storeName: 'DAVAO', counts: history('2026-09', 0, 17, 0), sales: null},
  ];
  const data =
    view === 'none'
      ? productView(INFO, [], null, NOW)
      : view === 'one'
        ? productView(INFO, [{storeCode: '1', storeName: 'CUBAO', counts: history('2026-10', 20, 20, 0).slice(-1), sales: null}], '1', NOW)
        : productView(INFO, stores, view === 'all' ? store ?? null : (store ?? '1'), NOW);
  return <GoldlineProductView data={data} />;
}
