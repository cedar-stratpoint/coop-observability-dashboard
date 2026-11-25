import 'server-only';
import {nichidoConfigured, nichidoDb} from './nichido-client';
import {fetchAllRows} from './pos-fetch-paginate';
import {
  ALL_PAGE,
  ALL_STORES,
  AUDIT_SORTS,
  auditCell,
  auditRows,
  auditSummary,
  isAuditState,
  isRecoLetter,
  isWhy,
  openingState,
  productRollup,
  type AuditCell,
  type AuditInput,
  type AuditQuery,
  type AuditSort,
  type AuditSummary,
  type ProductRollup,
} from './goldline-audit';
import {inventoryAnswer, type FormCount} from './goldline-audit-form';
import {onHandOf} from './goldline-inventory';
import {itemDisplayName} from './goldline-item-name';
import {getGlCatalog} from './goldline-ref-data';
import {forecastHistory, forecastMonths} from './goldline-forecast-data';
import {addMonthKey, manilaDate} from './goldline-supply';
import {getActivePoSet, shadeOf} from './goldline-po-form-data';

// The reconciliation matrix reader (NICH-17). For a month, cross-references three legs: the
// committed inventory forms (latest row per store and item), Watsons POS sales (net units
// per store and linked product) and the active PO form (catalog-wide). One store at a time,
// or every store. A role limited to some stores only ever sees those stores.
// Server-only, Nichido project. Mock fallback so the pages render with no DB.

export type AuditRow = AuditCell & {store: string; storeName: string | null; product: string | null; shade: string | null; line: string | null; retired: boolean};

export type PoLeg = {source: 'form'; fileName: string; activatedAt: string | null; onPo: number} | {source: 'none'};

/** `loaded`: Watsons sales for the whole month are in. `counted`: stores with a form. */
export type AuditMonth = {month: string; loaded: boolean; counted: number};

/** What the month's data can and can't answer, for the note above the tiles. */
export type AuditCoverage = {loaded: boolean; storesSold: number; storesCounted: number; unlinkedUnits: number};

export type AuditResult = {
  configured: boolean;
  mock: boolean;
  /** `counted`: the store has a committed form this month (sorted first in the picker). */
  stores: Array<{code: string; name: string | null; counted: boolean}>;
  months: AuditMonth[];
  /** code is ALL_STORES for the every-store view. */
  selected: {code: string; name: string | null; month: string} | null;
  /** One store: every row. Every store: the query's page only. */
  rows: AuditRow[];
  /** Rows the query matches (every store). */
  total: number;
  query: AuditQuery;
  summary: AuditSummary;
  coverage: AuditCoverage;
  po: PoLeg;
};

export type ProductAuditRow = ProductRollup & {product: string; shade: string | null; line: string | null; retired: boolean};

export type ProductAuditResult = {
  configured: boolean;
  mock: boolean;
  months: AuditMonth[];
  month: string | null;
  storeCount: number;
  rows: ProductAuditRow[];
  summary: AuditSummary;
  coverage: AuditCoverage;
  po: PoLeg;
};

export type AuditParams = {store?: string | null; month?: string | null; state?: string | null; why?: string | null; reco?: string | null; q?: string | null; sort?: string | null; dir?: string | null; page?: string | null};

const firstOf = (month: string) => `${month}-01`;
const byCode = (a: string, b: string) => a.localeCompare(b, undefined, {numeric: true});

/** Read the URL's query, falling back to the summary's opening state. Never trusts input. */
export function parseAuditQuery(p: AuditParams, summary: AuditSummary): AuditQuery {
  const page = Number(p.page);
  return {
    state: isAuditState(p.state) ? p.state : openingState(summary),
    why: isWhy(p.why) ? p.why : null,
    reco: isRecoLetter(p.reco) ? p.reco : null,
    q: (p.q ?? '').slice(0, 80),
    sort: AUDIT_SORTS.includes(p.sort as AuditSort) ? (p.sort as AuditSort) : 'reco',
    dir: p.dir === 'desc' ? 'desc' : 'asc',
    page: Number.isInteger(page) && page > 0 ? page : 0,
  };
}

// ── Reads ─────────────────────────────────────────────────────────────────────────────

/** Months with a committed form or a whole month of Watsons sales, newest first. */
async function monthIndex(companyId: string, scope: Set<string> | null): Promise<{months: AuditMonth[]; countedIn: Map<string, string[]>}> {
  const now = manilaDate().slice(0, 7);
  const recent = Array.from({length: 13}, (_, i) => addMonthKey(now, -i));
  const [index, status] = await Promise.all([
    // pagination-ok: one jsonb value ({month: [stores]}).
    nichidoDb().rpc('audit_count_index', {p_company: companyId}),
    forecastMonths(companyId, recent.map(firstOf)),
  ]);
  if (index.error) throw new Error(`audit_count_index failed: ${index.error.message}`);
  const countedIn = new Map<string, string[]>();
  for (const [m, codes] of Object.entries((index.data ?? {}) as Record<string, string[]>)) {
    const mine = scope ? codes.filter((c) => scope.has(c)) : codes;
    if (mine.length) countedIn.set(m, mine);
  }
  const loaded = new Set(status.filter((s) => s.loaded).map((s) => String(s.month).slice(0, 7)));
  const months = [...new Set([...countedIn.keys(), ...loaded])]
    .sort()
    .reverse()
    .map((month) => ({month, loaded: loaded.has(month), counted: countedIn.get(month)?.length ?? 0}));
  return {months, countedIn};
}

/** The newest month with both sales and counts, else the newest with a count, else the newest. */
function pickMonth(months: AuditMonth[], asked: string | null | undefined): string | null {
  if (asked && months.some((m) => m.month === asked)) return asked;
  return (months.find((m) => m.loaded && m.counted) ?? months.find((m) => m.counted) ?? months[0])?.month ?? null;
}

async function storeNames(companyId: string, codes: string[]): Promise<Map<string, string | null>> {
  if (!codes.length) return new Map();
  const rows = (await fetchAllRows('stores', (from, to) =>
    nichidoDb().from('stores').select('store_code,name').eq('company_id', companyId).order('store_code').range(from, to),
  )) as unknown as Array<{store_code: string; name: string | null}>;
  const want = new Set(codes);
  return new Map(rows.filter((r) => want.has(r.store_code)).map((r) => [r.store_code, r.name]));
}

/** Everything one month's matrix needs: one store's, or every store's in scope. */
async function readMonth(companyId: string, month: string, loaded: boolean, countedIn: string[], scope: Set<string> | null, asked: string | null) {
  const [catalog, po, history, status] = await Promise.all([
    getGlCatalog(companyId),
    getActivePoSet(companyId),
    loaded ? forecastHistory(companyId, [firstOf(month)], null) : Promise.resolve({} as Record<string, Record<string, number[]>>),
    forecastMonths(companyId, [firstOf(month)]),
  ]);
  const sold = new Map(Object.entries(history).filter(([code]) => !scope || scope.has(code)));
  const stores = [...new Set([...countedIn, ...sold.keys()])].sort(byCode);
  // Every store unless one in scope is asked for (Nov 25: All stores is the default).
  const only = asked && asked !== ALL_STORES && stores.includes(asked) ? asked : null;
  const pick = only ? [only] : stores;

  const counts = new Map<string, Map<string, FormCount>>();
  const want = pick.filter((s) => countedIn.includes(s));
  if (want.length) {
    // pagination-ok: one jsonb value ({store: {item: [ending, stockroom, drawer, selling area, form version]}}).
    const res = await nichidoDb().rpc('audit_counts', {p_company: companyId, p_month: firstOf(month), p_stores: want});
    if (res.error) throw new Error(`audit_counts failed: ${res.error.message}`);
    type Part = number | null;
    for (const [store, items] of Object.entries((res.data ?? {}) as Record<string, Record<string, [Part, Part, Part, Part, string | null]>>)) {
      // On hand is the app's one rule (onHandOf): the written ending, else the shelf counts.
      const row = ([item_code, [ending_on_hand, stockroom, drawer, selling_area, version]]: [string, [Part, Part, Part, Part, string | null]]): [string, FormCount] => [
        item_code,
        {onHand: onHandOf({item_code, ending_on_hand, stockroom, drawer, selling_area, delivery: null}).onHand, version},
      ];
      counts.set(store, new Map(Object.entries(items).map(row)));
    }
  }

  const visible = catalog.filter((p) => !p.hidden);
  const names = new Map(
    visible.map((p) => [p.item_code, {product: itemDisplayName(p.product_line, p.variant, p.item_code), shade: shadeOf(p.product_line, p.variant) || null, line: p.product_line, retired: Boolean(p.retired_at)}]),
  );
  const cells = (store: string): AuditCell[] => {
    const form = counts.get(store) ?? null;
    const units = sold.get(store);
    return visible.flatMap((p) => {
      const watsons: AuditInput['watsons'] = !loaded ? 'month_not_loaded' : !p.sku_code?.trim() ? 'not_linked' : !units ? 'store_not_in_file' : Number(units[p.item_code]?.[0] ?? 0);
      const cell = auditCell({
        item_code: p.item_code,
        watsons,
        inventory: inventoryAnswer(form, p.item_code),
        po: po ? po.items.has(p.item_code) : 'no_po_form',
        onForm: Boolean(form?.has(p.item_code)),
        retired: Boolean(p.retired_at),
      });
      return cell ? [cell] : [];
    });
  };
  const coverage: AuditCoverage = {
    loaded,
    storesSold: sold.size,
    storesCounted: countedIn.length,
    // A company-wide total, so a store-limited role doesn't see it.
    unlinkedUnits: loaded && !scope ? Math.max(0, Number(status[0]?.unlinked_units ?? 0)) : 0,
  };
  const poLeg: PoLeg = po ? {source: 'form', fileName: po.fileName, activatedAt: po.activatedAt, onPo: visible.filter((p) => po.items.has(p.item_code)).length} : {source: 'none'};
  return {stores, only, pick, cells, names, coverage, poLeg};
}

type Loaded = {months: AuditMonth[]; month: string; code: string; stores: string[]; counted: Set<string>; storeName: Map<string, string | null>; rows: AuditRow[]; summary: AuditSummary; coverage: AuditCoverage; poLeg: PoLeg};

/** Every row for one store, or for every store in scope. No `rows` when there is no data yet. */
async function loadRows(companyId: string, p: AuditParams, storeScope: string[] | null): Promise<Loaded | {months: AuditMonth[]}> {
  // A store-limited role with no stores assigned sees nothing (never "every store").
  if (storeScope && storeScope.length === 0) return {months: []};
  const scope = storeScope ? new Set(storeScope) : null;
  const {months, countedIn} = await monthIndex(companyId, scope);
  const month = pickMonth(months, p.month);
  if (!month) return {months};
  const m = await readMonth(companyId, month, months.find((x) => x.month === month)!.loaded, countedIn.get(month) ?? [], scope, p.store ?? null);
  if (!m.stores.length) return {months};
  const storeName = await storeNames(companyId, m.stores);
  const rows: AuditRow[] = m.pick.flatMap((store) =>
    m.cells(store).map((c) => {
      const n = m.names.get(c.item_code);
      return {...c, store, storeName: storeName.get(store) ?? null, product: n?.product ?? null, shade: n?.shade ?? null, line: n?.line ?? null, retired: n?.retired ?? false};
    }),
  );
  return {months, month, code: m.only ?? ALL_STORES, stores: m.stores, counted: new Set(countedIn.get(month) ?? []), storeName, rows, summary: auditSummary(rows), coverage: m.coverage, poLeg: m.poLeg};
}

const NO_COVERAGE: AuditCoverage = {loaded: false, storesSold: 0, storesCounted: 0, unlinkedUnits: 0};

/** The By store page: one store's rows, or one page of every store's. */
export async function auditData(companyId: string, p: AuditParams = {}, storeScope: string[] | null = null): Promise<AuditResult> {
  if (!nichidoConfigured()) return mockAudit(p);
  const d = await loadRows(companyId, p, storeScope);
  if (!('rows' in d)) {
    const summary = auditSummary([]);
    return {configured: true, mock: false, stores: [], months: d.months, selected: null, rows: [], total: 0, query: parseAuditQuery(p, summary), summary, coverage: NO_COVERAGE, po: {source: 'none'}};
  }
  const query = parseAuditQuery(p, d.summary);
  const base = {
    configured: true,
    mock: false,
    stores: d.stores.map((code) => ({code, name: d.storeName.get(code) ?? null, counted: d.counted.has(code)})),
    months: d.months,
    selected: {code: d.code, name: d.code === ALL_STORES ? null : (d.storeName.get(d.code) ?? null), month: d.month},
    summary: d.summary,
    coverage: d.coverage,
    po: d.poLeg,
  };
  if (d.code !== ALL_STORES) return {...base, rows: d.rows, total: d.rows.length, query};
  const hits = auditRows(d.rows, query);
  const page = Math.min(query.page, Math.max(0, Math.ceil(hits.length / ALL_PAGE) - 1));
  return {...base, rows: hits.slice(page * ALL_PAGE, page * ALL_PAGE + ALL_PAGE), total: hits.length, query: {...query, page}};
}

/** Every row a query matches, for the CSV. */
export async function auditExport(companyId: string, p: AuditParams, storeScope: string[] | null): Promise<{rows: AuditRow[]; month: string; code: string} | null> {
  if (!nichidoConfigured()) return null;
  const d = await loadRows(companyId, p, storeScope);
  return 'rows' in d ? {rows: auditRows(d.rows, parseAuditQuery(p, d.summary)), month: d.month, code: d.code} : null;
}

/** Every store in a month, rolled up per product (counts only; which stores is All stores). */
export async function productAuditData(companyId: string, opts: {month?: string | null} = {}, storeScope: string[] | null = null): Promise<ProductAuditResult> {
  if (!nichidoConfigured()) return mockProductAudit(opts);
  const d = await loadRows(companyId, {month: opts.month, store: ALL_STORES}, storeScope);
  if (!('rows' in d)) return {configured: true, mock: false, months: d.months, month: null, storeCount: 0, rows: [], summary: auditSummary([]), coverage: NO_COVERAGE, po: {source: 'none'}};
  return {configured: true, mock: false, months: d.months, month: d.month, storeCount: d.stores.length, rows: rollup(d.rows), summary: d.summary, coverage: d.coverage, po: d.poLeg};
}

function rollup(rows: AuditRow[]): ProductAuditRow[] {
  const first = new Map<string, AuditRow>();
  for (const r of rows) if (!first.has(r.item_code)) first.set(r.item_code, r);
  return productRollup(rows).map((r) => {
    const n = first.get(r.item_code)!;
    return {...r, product: n.product ?? r.item_code, shade: n.shade, line: n.line, retired: n.retired};
  });
}

// ── Mock: a believable month so the views render with no DB ───────────────────────────
type MockItem = AuditInput & {product: string; line: string};
const MOCK_ITEMS: MockItem[] = [
  {item_code: 'FBPP02', product: 'Flawless Beauty Pressed Powder Golden Tan', line: 'Flawless Beauty Pressed Powder', po: true, watsons: 18, inventory: 26, onForm: true},
  {item_code: 'USMLLC08', product: 'Ultra Stay Matte Liquid Lip Color Iconic Red', line: 'Ultra Stay Matte Liquid Lip Color', po: true, watsons: 11, inventory: 'absent', onForm: false},
  {item_code: 'TSP01202', product: 'Translucent Setting Powder Ivory Glow', line: 'Translucent Setting Powder', po: true, watsons: 9, inventory: 0, onForm: true},
  {item_code: 'MPMLSCB03', product: 'Mineral Powder Matte Lipstick Heart to Heart', line: 'Mineral Powder Matte Lipstick', po: true, watsons: 0, inventory: 14, onForm: true},
  {item_code: 'IPSLS05', product: 'Icy Pout Serum Lip Stain Spiced Candy', line: 'Icy Pout Serum Lip Stain', po: true, watsons: 0, inventory: 0, onForm: true},
  {item_code: 'TCES17314', product: 'True Colors Eye Shadow Soft Black', line: 'True Colors Eye Shadow', po: false, watsons: 3, inventory: 6, onForm: true},
  {item_code: 'FCPP01131', product: 'Fancy Colors Natural', line: 'Fancy Colors', po: false, watsons: 4, inventory: 'absent', onForm: false},
  {item_code: 'BGPL01', product: 'Body Glimmer Powder Pink Lite', line: 'Body Glimmer Powder', po: false, watsons: 0, inventory: 7, onForm: true},
  {item_code: 'EFTT1064', product: 'Elise Futuristic Lashes B1064', line: 'Elise Futuristic Lashes', po: false, watsons: 0, inventory: 0, onForm: true},
  {item_code: 'TCES1734', product: 'True Colors Eye Shadow Raisin Wine', line: 'True Colors Eye Shadow', po: false, watsons: 'not_linked', inventory: 5, onForm: true},
  {item_code: 'CPFB', product: 'Cream to Powder Foundation Biscuit', line: 'Cream to Powder Foundation', po: true, watsons: 2, inventory: 'blank', onForm: true},
];
const MOCK_STORES = [
  {code: '473', name: 'Watsons SM San Pablo', counted: true},
  {code: '5300', name: 'SM Sta Rosa', counted: true},
];
const MOCK_PO: PoLeg = {source: 'form', fileName: 'PO FILE PAGE 1-2.xlsx', activatedAt: '2026-11-23T08:00:00Z', onPo: 242};
const MOCK_MONTHS: AuditMonth[] = [
  {month: '2026-09', loaded: true, counted: 2},
  {month: '2026-08', loaded: true, counted: 2},
];
const MOCK_COVERAGE: AuditCoverage = {loaded: true, storesSold: 2, storesCounted: 2, unlinkedUnits: 12};

function mockRows(codes: string[]): AuditRow[] {
  return MOCK_STORES.filter((s) => codes.includes(s.code)).flatMap((s) =>
    MOCK_ITEMS.flatMap((i) => {
      const c = auditCell(i);
      return c ? [{...c, store: s.code, storeName: s.name, product: i.product, shade: null, line: i.line, retired: false}] : [];
    }),
  );
}

function mockAudit(p: AuditParams): AuditResult {
  const store = MOCK_STORES.find((s) => s.code === p.store);
  const all = !store;
  const rows = mockRows(store ? [store.code] : MOCK_STORES.map((s) => s.code));
  const summary = auditSummary(rows);
  const query = parseAuditQuery(p, summary);
  const hits = all ? auditRows(rows, query) : rows;
  return {
    configured: false,
    mock: true,
    stores: MOCK_STORES,
    months: MOCK_MONTHS,
    selected: {code: store?.code ?? ALL_STORES, name: store?.name ?? null, month: p.month === '2026-08' ? '2026-08' : '2026-09'},
    rows: all ? hits.slice(query.page * ALL_PAGE, query.page * ALL_PAGE + ALL_PAGE) : hits,
    total: hits.length,
    query,
    summary,
    coverage: MOCK_COVERAGE,
    po: MOCK_PO,
  };
}

function mockProductAudit(opts: {month?: string | null}): ProductAuditResult {
  const rows = mockRows(MOCK_STORES.map((s) => s.code));
  return {configured: false, mock: true, months: MOCK_MONTHS, month: opts.month ?? '2026-09', storeCount: MOCK_STORES.length, rows: rollup(rows), summary: auditSummary(rows), coverage: MOCK_COVERAGE, po: MOCK_PO};
}
