import 'server-only';
import {nichidoConfigured, nichidoDb} from './nichido-client';
import {fetchAllRows} from './pos-fetch-paginate';
import {salesUnits} from './goldline-sales-units';
import {auditMatrix, auditSummary, productRollup, type AuditCell, type AuditSummary, type ProductRollup} from './goldline-audit';
import {itemDisplayName} from './goldline-item-name';
import {getGlCatalog} from './goldline-ref-data';
import {getActivePoSet, shadeOf} from './goldline-po-form-data';

// The reconciliation matrix reader (NICH-17). For a month, cross-references three legs:
// the committed inventory form (on hand per store and item), Watsons POS sales (units per
// store and Watsons SKU, mapped to items via the product SKU links), and the active PO
// form (catalog-wide). Two views: one store (per SKU) and per product (stores per state).
// Server-only, Nichido project. Mock fallback so the pages render with no DB.

export type AuditRow = AuditCell & {product: string | null; shade: string | null; line: string | null; retired: boolean};

export type AuditStore = {code: string; name: string | null; month: string};

export type PoLeg = {source: 'form'; fileName: string; activatedAt: string | null; onPo: number} | {source: 'none'};

export type AuditResult = {
  configured: boolean;
  mock: boolean;
  /** Stores that have a committed inventory count in the selected month. */
  stores: Array<{code: string; name: string | null}>;
  /** Months (YYYY-MM) that have a committed count, newest first. */
  months: string[];
  selected: AuditStore | null;
  rows: AuditRow[];
  summary: AuditSummary;
  po: PoLeg;
};

export type ProductAuditRow = ProductRollup & {product: string; shade: string | null; line: string | null; retired: boolean; storeList: Array<{code: string; name: string | null; state: AuditCell['state']}>};

export type ProductAuditResult = {
  configured: boolean;
  mock: boolean;
  months: string[];
  month: string | null;
  storeCount: number;
  rows: ProductAuditRow[];
  summary: AuditSummary;
  po: PoLeg;
};

type Catalog = Awaited<ReturnType<typeof getGlCatalog>>;

/** Last day of a YYYY-MM month (YYYY-MM-DD). */
const monthEnd = (m: string) => {
  const [y, mo] = m.split('-').map(Number);
  return new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10);
};

/** The month-level inputs both views share. */
async function monthInputs(companyId: string, month: string, stores: string[]) {
  const supa = nichidoDb();
  const [catalog, po, counts, sales] = await Promise.all([
    getGlCatalog(companyId),
    getActivePoSet(companyId),
    fetchAllRows('inventory', (from, to) =>
      supa
        .from('inventory')
        .select('store_code,item_code,ending_on_hand,period_end')
        .eq('company_id', companyId)
        .in('store_code', stores)
        .gte('period_end', `${month}-01`)
        .lte('period_end', monthEnd(month))
        .order('id')
        .range(from, to),
    ) as unknown as Promise<Array<{store_code: string; item_code: string; ending_on_hand: number | null; period_end: string}>>,
    salesUnits(companyId, {fromStart: `${month}-01`, fromEnd: monthEnd(month), stores}),
  ]);
  const visible = catalog.filter((p) => !p.hidden);
  // No PO form yet: every product that isn't retired counts as on the PO, so the active
  // rows still read sensibly. The page says so.
  const onPo = (p: Catalog[number]) => (po ? po.items.has(p.item_code) : !p.retired_at);

  // Form: on hand per store|item. Two forms in one month (1st and 2nd half): the later wins.
  const latest = new Map<string, {end: string; onHand: number | null}>();
  for (const c of counts) {
    if (c.period_end.slice(0, 7) !== month) continue;
    const k = `${c.store_code}|${c.item_code}`;
    const prev = latest.get(k);
    if (!prev || prev.end <= c.period_end) latest.set(k, {end: c.period_end, onHand: c.ending_on_hand});
  }
  // Watsons: units per store|item (via SKU links). Unlinked SKUs can't enter the matrix.
  const itemBySku = new Map(catalog.filter((p) => p.sku_code?.trim()).map((p) => [p.sku_code!.trim(), p.item_code]));
  const sold = new Map<string, number>();
  for (const s of sales) {
    if (s.period_start.slice(0, 7) !== month) continue;
    const item = itemBySku.get(s.sku_code);
    if (!item) continue;
    const k = `${s.store_code}|${item}`;
    sold.set(k, (sold.get(k) ?? 0) + (Number(s.units) || 0));
  }

  const cellsFor = (store: string): AuditCell[] =>
    auditMatrix(
      visible.map((p) => {
        const k = `${store}|${p.item_code}`;
        const f = latest.get(k);
        return {item_code: p.item_code, units: sold.get(k) ?? 0, onHand: f?.onHand ?? null, onForm: Boolean(f), onPo: onPo(p)};
      }),
    );

  const poLeg: PoLeg = po ? {source: 'form', fileName: po.fileName, activatedAt: po.activatedAt, onPo: visible.filter(onPo).length} : {source: 'none'};
  return {catalog, cellsFor, poLeg};
}

/** Stores and months that have a committed count (the pickable universe). */
async function countedUniverse(companyId: string) {
  const supa = nichidoDb();
  const keys = (await fetchAllRows('inventory', (from, to) =>
    supa.from('inventory').select('store_code,period_end').eq('company_id', companyId).order('id').range(from, to),
  )) as unknown as Array<{store_code: string; period_end: string}>;
  const months = [...new Set(keys.map((r) => r.period_end.slice(0, 7)))].sort().reverse();
  const storesIn = (m: string) => [...new Set(keys.filter((r) => r.period_end.slice(0, 7) === m).map((r) => r.store_code))].sort((a, b) => a.localeCompare(b, undefined, {numeric: true}));
  return {months, storesIn};
}

async function storeNames(companyId: string, codes: string[]): Promise<Map<string, string | null>> {
  if (!codes.length) return new Map();
  const rows = (await fetchAllRows('stores', (from, to) =>
    nichidoDb().from('stores').select('store_code,name').eq('company_id', companyId).in('store_code', codes).order('store_code').range(from, to),
  )) as unknown as Array<{store_code: string; name: string | null}>;
  return new Map(rows.map((r) => [r.store_code, r.name]));
}

const naming = (catalog: Catalog) =>
  new Map(catalog.map((p) => [p.item_code, {name: itemDisplayName(p.product_line, p.variant, p.item_code), shade: shadeOf(p.product_line, p.variant), line: p.product_line, retired: Boolean(p.retired_at)}]));

/** One store's matrix for a month. Defaults: the newest month and its first store. */
export async function auditData(companyId: string, opts: {store?: string | null; month?: string | null} = {}): Promise<AuditResult> {
  if (!nichidoConfigured()) return mockAudit(opts);
  const {months, storesIn} = await countedUniverse(companyId);
  if (!months.length) return {configured: true, mock: false, stores: [], months: [], selected: null, rows: [], summary: auditSummary([]), po: {source: 'none'}};
  const month = opts.month && months.includes(opts.month) ? opts.month : months[0];
  const storeCodes = storesIn(month);
  const store = opts.store && storeCodes.includes(opts.store) ? opts.store : storeCodes[0];

  const [names, inputs] = await Promise.all([storeNames(companyId, storeCodes), monthInputs(companyId, month, [store])]);
  const nm = naming(inputs.catalog);
  const cells = inputs.cellsFor(store);
  const rows: AuditRow[] = cells.map((c) => ({...c, product: nm.get(c.item_code)?.name ?? null, shade: nm.get(c.item_code)?.shade || null, line: nm.get(c.item_code)?.line ?? null, retired: nm.get(c.item_code)?.retired ?? false}));
  return {
    configured: true,
    mock: false,
    stores: storeCodes.map((code) => ({code, name: names.get(code) ?? null})),
    months,
    selected: {code: store, name: names.get(store) ?? null, month},
    rows,
    summary: auditSummary(cells),
    po: inputs.poLeg,
  };
}

/** Every counted store in a month, rolled up per product. */
export async function productAuditData(companyId: string, opts: {month?: string | null} = {}): Promise<ProductAuditResult> {
  if (!nichidoConfigured()) return mockProductAudit(opts);
  const {months, storesIn} = await countedUniverse(companyId);
  if (!months.length) return {configured: true, mock: false, months: [], month: null, storeCount: 0, rows: [], summary: auditSummary([]), po: {source: 'none'}};
  const month = opts.month && months.includes(opts.month) ? opts.month : months[0];
  const storeCodes = storesIn(month);
  const [names, inputs] = await Promise.all([storeNames(companyId, storeCodes), monthInputs(companyId, month, storeCodes)]);
  const nm = naming(inputs.catalog);
  const all = storeCodes.flatMap((store) => inputs.cellsFor(store).map((c) => ({...c, store})));
  const storesByItem = new Map<string, ProductAuditRow['storeList']>();
  for (const c of all) {
    const list = storesByItem.get(c.item_code) ?? [];
    list.push({code: c.store, name: names.get(c.store) ?? null, state: c.state});
    storesByItem.set(c.item_code, list);
  }
  const rows: ProductAuditRow[] = productRollup(all).map((r) => ({
    ...r,
    product: nm.get(r.item_code)?.name ?? r.item_code,
    shade: nm.get(r.item_code)?.shade || null,
    line: nm.get(r.item_code)?.line ?? null,
    retired: nm.get(r.item_code)?.retired ?? false,
    storeList: storesByItem.get(r.item_code) ?? [],
  }));
  return {configured: true, mock: false, months, month, storeCount: storeCodes.length, rows, summary: auditSummary(all), po: inputs.poLeg};
}

// ── Mock: a believable month so both views render with no DB ─────────────────────────
const MOCK_ITEMS: Array<{item_code: string; product: string; line: string; onPo: boolean; units: number; onHand: number | null; onForm: boolean}> = [
  {item_code: 'FBPP02', product: 'Flawless Beauty Pressed Powder Golden Tan', line: 'Flawless Beauty Pressed Powder', onPo: true, units: 18, onHand: 26, onForm: true},
  {item_code: 'TSP01202', product: 'Translucent Setting Powder Ivory Glow', line: 'Translucent Setting Powder', onPo: true, units: 9, onHand: 25, onForm: true},
  {item_code: 'USMLLC08', product: 'Ultra Stay Matte Liquid Lip Color Iconic Red', line: 'Ultra Stay Matte Liquid Lip Color', onPo: true, units: 11, onHand: null, onForm: false},
  {item_code: 'MPMLSCB03', product: 'Mineral Powder Matte Lipstick Heart to Heart', line: 'Mineral Powder Matte Lipstick', onPo: true, units: 0, onHand: 14, onForm: true},
  {item_code: 'IPSLS05', product: 'Icy Pout Serum Lip Stain Spiced Candy', line: 'Icy Pout Serum Lip Stain', onPo: true, units: 0, onHand: 0, onForm: true},
  {item_code: 'TCES1734', product: 'True Colors Eye Shadow Raisin Wine', line: 'True Colors Eye Shadow', onPo: false, units: 3, onHand: 6, onForm: true},
  {item_code: 'FCPP01131', product: 'Fancy Colors Natural', line: 'Fancy Colors', onPo: false, units: 4, onHand: null, onForm: false},
  {item_code: 'BGPL01', product: 'Body Glimmer Powder Pink Lite', line: 'Body Glimmer Powder', onPo: false, units: 0, onHand: 7, onForm: true},
  {item_code: 'EFTT1064', product: 'Elise Futuristic Lashes B1064', line: 'Elise Futuristic Lashes', onPo: false, units: 0, onHand: 0, onForm: true},
];
const MOCK_PO: PoLeg = {source: 'form', fileName: 'PO FILE PAGE 1-2.xlsx', activatedAt: '2026-11-23T08:00:00Z', onPo: 242};

function mockAudit(opts: {store?: string | null; month?: string | null}): AuditResult {
  const month = opts.month ?? '2026-10';
  const cells = auditMatrix(MOCK_ITEMS);
  const meta = new Map(MOCK_ITEMS.map((m) => [m.item_code, m]));
  return {
    configured: false,
    mock: true,
    stores: [{code: '473', name: 'Watsons SM San Pablo'}, {code: '5300', name: 'SM Sta Rosa'}],
    months: ['2026-10', '2026-09'],
    selected: {code: opts.store ?? '473', name: 'Watsons SM San Pablo', month},
    rows: cells.map((c) => ({...c, product: meta.get(c.item_code)!.product, shade: null, line: meta.get(c.item_code)!.line, retired: false})),
    summary: auditSummary(cells),
    po: MOCK_PO,
  };
}

function mockProductAudit(opts: {month?: string | null}): ProductAuditResult {
  const stores = [
    {code: '473', name: 'Watsons SM San Pablo'},
    {code: '5300', name: 'SM Sta Rosa'},
    {code: '118', name: 'Watsons Cubao'},
  ];
  const all = stores.flatMap((s, si) =>
    auditMatrix(MOCK_ITEMS.map((m, i) => ({...m, units: (i + si) % 3 === 0 ? 0 : m.units, onForm: (i + si) % 4 === 0 ? false : m.onForm}))).map((c) => ({...c, store: s})),
  );
  const meta = new Map(MOCK_ITEMS.map((m) => [m.item_code, m]));
  const rows = productRollup(all).map((r) => ({
    ...r,
    product: meta.get(r.item_code)!.product,
    shade: null,
    line: meta.get(r.item_code)!.line,
    retired: false,
    storeList: all.filter((c) => c.item_code === r.item_code).map((c) => ({code: c.store.code, name: c.store.name, state: c.state})),
  }));
  return {configured: false, mock: true, months: ['2026-10', '2026-09'], month: opts.month ?? '2026-10', storeCount: stores.length, rows, summary: auditSummary(all), po: MOCK_PO};
}
