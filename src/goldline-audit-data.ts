import 'server-only';
import {nichidoConfigured, nichidoDb} from './nichido-client';
import {fetchAllRows} from './pos-fetch-paginate';
import {salesUnits} from './goldline-sales-units';
import {auditMatrix, auditSummary, type AuditCell} from './goldline-audit';
import {itemDisplayName} from './goldline-item-name';

// Phase 4 — the per-SKU-per-store audit matrix reader (NICH-17). For a store and month,
// cross-references the committed inventory form (which SKUs were counted, and the ending
// on hand) with Watsons POS sales (which SKUs sold, via the product SKU links). The PO
// leg is not built, so this is the inventory × Watsons subset. Server-only, Nichido
// project. Mock fallback so the page renders with the Supabase env unset.

export type AuditRow = AuditCell & {product: string | null};

export type AuditStore = {code: string; name: string | null; month: string};

export type AuditResult = {
  configured: boolean;
  mock: boolean;
  /** Stores that have a committed inventory count (the pickable set). */
  stores: Array<{code: string; name: string | null}>;
  /** Months (YYYY-MM) that have a committed count, newest first. */
  months: string[];
  /** The selected store + month, or null when nothing is pickable. */
  selected: AuditStore | null;
  rows: AuditRow[];
  summary: {matched: number; no_sales: number; not_counted: number; total: number};
};

/**
 * Build the audit matrix. `store` / `month` pick the view; when omitted, the newest
 * month and its first store are used. `onlyMismatches` keeps just the rows that need
 * attention (the default on the page).
 */
export async function auditData(
  companyId: string,
  opts: {store?: string | null; month?: string | null} = {},
): Promise<AuditResult> {
  if (!nichidoConfigured()) return mockAudit(opts);
  const supa = nichidoDb();

  // Stores + months that have a committed inventory count — the pickable universe.
  const invKeys = (await fetchAllRows('inventory', (from, to) =>
    supa.from('inventory').select('store_code,period_end').eq('company_id', companyId).order('id').range(from, to),
  )) as unknown as Array<{store_code: string; period_end: string}>;
  if (!invKeys.length) {
    return {configured: true, mock: false, stores: [], months: [], selected: null, rows: [], summary: zero()};
  }
  const months = [...new Set(invKeys.map((r) => r.period_end.slice(0, 7)))].sort().reverse();
  const month = opts.month && months.includes(opts.month) ? opts.month : months[0];
  const storesInMonth = [...new Set(invKeys.filter((r) => r.period_end.slice(0, 7) === month).map((r) => r.store_code))].sort();
  const store = opts.store && storesInMonth.includes(opts.store) ? opts.store : storesInMonth[0];

  const [names, products] = await Promise.all([
    storeNames(supa, companyId, storesInMonth),
    fetchAllRows('products', (from, to) =>
      supa.from('products').select('item_code,sku_code,product_line,variant').eq('company_id', companyId).order('item_code').range(from, to),
    ) as unknown as Promise<Array<{item_code: string; sku_code: string | null; product_line: string | null; variant: string | null}>>,
  ]);

  // The form side: items counted for this store/month (ending on hand).
  const counts = (await fetchAllRows('inventory', (from, to) =>
    supa
      .from('inventory')
      .select('item_code,ending_on_hand,period_end')
      .eq('company_id', companyId)
      .eq('store_code', store)
      .order('id')
      .range(from, to),
  )) as unknown as Array<{item_code: string; ending_on_hand: number | null; period_end: string}>;
  const formOnHand = new Map<string, number | null>();
  for (const c of counts) if (c.period_end.slice(0, 7) === month) formOnHand.set(c.item_code, c.ending_on_hand);

  // The Watsons side: units this store sold this month, mapped to item codes via links.
  const itemBySku = new Map(products.filter((p) => p.sku_code?.trim()).map((p) => [p.sku_code!.trim(), p.item_code]));
  const nameByItem = new Map(products.map((p) => [p.item_code, itemDisplayName(p.product_line, p.variant, p.item_code)]));
  const sales = await salesUnits(companyId, {fromStart: `${month}-01`, stores: [store]});
  const soldUnits = new Map<string, number>();
  for (const s of sales) {
    if (s.period_start.slice(0, 7) !== month) continue;
    const item = itemBySku.get(s.sku_code);
    if (!item) continue; // unlinked SKUs don't enter the matrix
    soldUnits.set(item, (soldUnits.get(item) ?? 0) + (Number(s.units) || 0));
  }

  const items = new Set<string>([...formOnHand.keys(), ...soldUnits.keys()]);
  const cells = auditMatrix(
    [...items].map((item_code) => ({
      item_code,
      inForm: formOnHand.has(item_code),
      inWatsons: soldUnits.has(item_code),
      units: soldUnits.get(item_code) ?? 0,
      onHand: formOnHand.get(item_code) ?? null,
    })),
  );
  const rows: AuditRow[] = cells.map((c) => ({...c, product: nameByItem.get(c.item_code) ?? null}));

  return {
    configured: true,
    mock: false,
    stores: storesInMonth.map((code) => ({code, name: names.get(code) ?? null})),
    months,
    selected: {code: store, name: names.get(store) ?? null, month},
    rows,
    summary: auditSummary(cells),
  };
}

async function storeNames(supa: ReturnType<typeof nichidoDb>, companyId: string, codes: string[]): Promise<Map<string, string | null>> {
  if (!codes.length) return new Map();
  const rows = (await fetchAllRows('stores', (from, to) =>
    supa.from('stores').select('store_code,name').eq('company_id', companyId).in('store_code', codes).order('store_code').range(from, to),
  )) as unknown as Array<{store_code: string; name: string | null}>;
  return new Map(rows.map((r) => [r.store_code, r.name]));
}

function zero() {
  return {matched: 0, no_sales: 0, not_counted: 0, total: 0};
}

// ── Mock: a believable store/month so the matrix renders with no DB ─────────────────
function mockAudit(opts: {store?: string | null; month?: string | null}): AuditResult {
  const month = opts.month ?? '2026-09';
  const rows: AuditRow[] = auditMatrix([
    {item_code: 'FBPP02', inForm: true, inWatsons: true, onHand: 26, units: 18},
    {item_code: 'TSP01202', inForm: true, inWatsons: true, onHand: 25, units: 9},
    {item_code: 'MPMLSCB03', inForm: true, inWatsons: false, onHand: 14}, // counted, no sale
    {item_code: 'CDSBLB01', inForm: true, inWatsons: false, onHand: 7},
    {item_code: 'USMLLC08', inForm: false, inWatsons: true, units: 11}, // sold, not counted
    {item_code: 'IPSLS05', inForm: false, inWatsons: true, units: 4},
  ]).map((c) => ({...c, product: c.item_code}));
  return {
    configured: false,
    mock: true,
    stores: [{code: '473', name: 'Watsons SM San Pablo'}, {code: '5300', name: 'SM Sta Rosa'}],
    months: ['2026-10', '2026-09'],
    selected: {code: opts.store ?? '473', name: 'Watsons SM San Pablo', month},
    rows,
    summary: auditSummary(rows),
  };
}
