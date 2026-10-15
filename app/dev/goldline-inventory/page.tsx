// DEV-ONLY preview of the Goldline Inventory board on synthetic counts. 404 in production.
// ?store=1..5 for one store (default: all stores).
import {notFound} from 'next/navigation';
import type {InventoryRowIn} from '@/src/goldline-inventory';
import {storeMovement, type Count} from '@/src/goldline-movement';
import {countedSoldByMonth} from '@/src/goldline-product';
import {boardSummary, buildBoard, type CatalogItem, type Shipment, type StoreBlock, type SupplyConfig} from '@/src/goldline-supply';
import {GoldlineInventoryBoard} from '@/components/analyst/goldline-inventory-board';

const PRODUCTS: Array<[string, string, string, number, number]> = [
  // code, line, shade, price, base sold per half-month
  ['TWC01152', 'Two Way Cake (21 Grams)', 'Natural', 185, 18],
  ['TWC01153', 'Two Way Cake (21 Grams)', 'Ivory', 185, 9],
  ['MPML01', 'Mineral Powder Matte Lipstick with Collagen Booster', 'Love On Fire', 299, 26],
  ['MPML02', 'Mineral Powder Matte Lipstick with Collagen Booster', 'Rosy Nude', 299, 14],
  ['USML03', 'Ultra Stay Matte Liquid Lip Color', 'Brick', 249, 11],
  ['IPSL01', 'Icy Pout Serum Lip Stain', 'Cherry', 229, 7],
  ['TCES17311', 'True Colors Eye Shadow', 'Cocoa Pearl', 168, 4],
  ['TCPB01', 'True Colors Powder Blush', 'Peach Pop', 160, 6],
  ['BB03N', 'BB Cream', '03 Natural', 238, 12],
  ['TLGL4452', 'Trulashes - Glamour Lashes', 'Glamour', 150, 20],
  ['HSGCC', 'HD Serum Gel Concealer', 'Cashmere', 268, 5],
  ['TSP01202', 'Translucent Setting Powder', 'Ivory Glow', 240, 3],
  ['MKO01', 'Mineral Kohl - Onyx', 'Onyx', 120, 0],
  ['24/7SEPMM', '24/7 Stylo Eyeliner Pen', 'Matte Black', 199, 8],
];
const STORES: Array<[string, string, number]> = [
  ['1', 'CUBAO', 1.4],
  ['2', 'MAKATI', 1],
  ['3', 'QUEZON CITY', 0.8],
  ['4', 'CEBU', 0.6],
  ['5', 'DAVAO', 0.4],
];
const HALVES = ['2026-06-15', '2026-06-30', '2026-07-15', '2026-07-31', '2026-08-15', '2026-08-31', '2026-09-15', '2026-09-30', '2026-10-15'];

function counts(store: number, mult: number): Count[] {
  const onHand = new Map<string, number>();
  return HALVES.map((end, k) => {
    const start = end.endsWith('-15') ? `${end.slice(0, 8)}01` : `${end.slice(0, 8)}16`;
    const rows: InventoryRowIn[] = PRODUCTS.map(([code, , , , base], p) => {
      const sold = Math.round(base * mult * (0.8 + ((p * 7 + k * 3 + store) % 5) / 10));
      let oh = onHand.get(code) ?? Math.round(base * mult * 3 + 10);
      const delivery = oh - sold < base * mult && (p + k + store) % 3 !== 0 ? Math.round(base * mult * 3) : 0;
      oh = Math.max(0, oh + delivery - sold);
      onHand.set(code, oh);
      const display = Math.min(oh, 6);
      return {item_code: code, stockroom: Math.max(0, oh - display - 2), drawer: Math.min(2, Math.max(0, oh - display)), selling_area: display, delivery, ending_on_hand: null};
    });
    return {period_start: start, period_end: end, rows};
  });
}

export default async function Page(props: {searchParams: Promise<{store?: string}>}) {
  if (process.env.NODE_ENV === 'production') notFound();
  const {store: requested} = await props.searchParams;
  const today = '2026-10-20';
  const stores: StoreBlock[] = STORES.map(([code, name, mult], i) => {
    const cs = counts(i + 1, mult);
    const mv = storeMovement(cs);
    const latest = new Map(cs[cs.length - 1].rows.map((r) => [r.item_code, r]));
    return {
      storeCode: code,
      storeName: name,
      latestEnd: mv.latest?.period_end ?? null,
      cycleDays: mv.cycleDays,
      items: mv.items.map((m) => ({
        itemCode: m.item_code,
        movement: m,
        row: latest.get(m.item_code) ?? null,
        monthly: countedSoldByMonth(cs.map((c) => ({...(c.rows.find((r) => r.item_code === m.item_code) as InventoryRowIn), period_start: c.period_start, period_end: c.period_end}))),
      })),
    };
  });
  const catalog: Record<string, CatalogItem> = Object.fromEntries(
    PRODUCTS.map(([code, line, shade, price], p) => [code, {name: shade, productLine: line, price, bestseller: p % 4 === 0, hidden: code === 'TSP01202'}]),
  );
  const warehouse: Record<string, number> = Object.fromEntries(PRODUCTS.map(([code, , , , base], p) => [code, p % 5 === 2 ? 20 : base * 12 + (p % 3) * 40]));
  const config: SupplyConfig = {
    defaultProductionDays: 30,
    defaultTransitDays: 3,
    lineProductionDays: {'Mineral Powder Matte Lipstick with Collagen Booster': 30, 'Trulashes - Glamour Lashes': 45, 'Two Way Cake (21 Grams)': 21},
    storeTransitDays: {'1': 2, '2': 2, '3': 2, '4': 6, '5': 8},
    isSample: true,
  };
  const shipments: Shipment[] = [
    {id: '00000000-0000-0000-0000-000000000001', storeCode: '1', itemCode: 'MPML01', qty: 40, shippedOn: '2026-10-18', arrivesOn: '2026-10-20'},
    {id: '00000000-0000-0000-0000-000000000002', storeCode: '4', itemCode: 'TWC01152', qty: 25, shippedOn: '2026-10-19', arrivesOn: '2026-10-25'},
  ];
  const store = STORES.some(([c]) => c === requested) ? (requested as string) : null;
  const rows = buildBoard({stores, catalog, warehouse, config, shipments, currentMonth: '2026-10', today, store});
  return (
    <GoldlineInventoryBoard
      data={{
        company: 'goldline',
        canEdit: true,
        storeScoped: false,
        stores: STORES.map(([code, name]) => ({code, name})),
        store,
        rows,
        summary: boardSummary(rows, today),
        config,
        productLines: [...new Set(PRODUCTS.map((p) => p[1]))].sort(),
        warehouse,
        shipments: shipments.filter((s) => !store || s.storeCode === store),
        today,
        currentMonth: '2026-10',
        count: store ? {latestEnd: '2026-10-15', consultant: 'M. Santos', committedAt: null, sources: [1, 2, 3, 4].map((n) => ({uploadId: `u${n}`, filename: `${n}.pdf`, page: n})), missingPages: [5]} : null,
        pendingReview: 2,
      }}
    />
  );
}
