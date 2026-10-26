import 'server-only';
import {nichidoConfigured, nichidoDb} from './nichido-client';
import {fetchAllRows} from './pos-fetch-paginate';
import {getGlCatalog, getGlStores} from './goldline-ref-data';
import {monthCoverage, type FlagStatus, type MonthCoverage} from './goldline-checks-data';
import type {AdjustmentReason} from './goldline-flags-writes';
import {basOf, baTags, type BaMonth, type FlagCause, type FlagKind} from './goldline-checks';
import {itemDisplayName} from './goldline-item-name';

// Reads for the flag queue (F7) and adjustments (F5). Flags are written by the checks
// (src/goldline-checks-data.ts); admin writes are in src/goldline-flags-writes.ts.
// Store-scoped roles only see their own stores.
//
// The queue is one tile per store, BA and month (Oct 26): the BA's points, tag and
// category. Opening a tile reads that form page by page (getFormPages) with every
// flagged cell attached, so the screen can box it the way the paper form looks.

const db = nichidoDb;

export type {AdjustmentReason};
export type FlagRow = {
  id: string;
  kind: FlagKind;
  cause: FlagCause;
  hint: string | null;
  status: FlagStatus;
  storeCode: string;
  storeName: string | null;
  itemCode: string;
  itemName: string | null;
  price: number | null;
  periodStart: string;
  periodEnd: string;
  consultant: string | null;
  sourceUploadId: string | null;
  details: Record<string, unknown>;
  remark: string | null;
  remarkBy: string | null;
  remarkedAt: string | null;
  resolvedAt: string | null;
  createdAt: string;
};
export type AdjustmentRow = {
  id: string;
  storeCode: string;
  storeName: string | null;
  itemCode: string;
  itemName: string | null;
  periodStart: string;
  periodEnd: string;
  reason: AdjustmentReason;
  qty: number;
  note: string | null;
  sourceFlagId: string | null;
  createdBy: string | null;
  createdAt: string;
};
export type BaTile = BaMonth & {storeName: string | null};
export type FlagsData = {
  flags: FlagRow[];
  tiles: BaTile[];
  adjustments: AdjustmentRow[];
  coverage: MonthCoverage[];
  stores: Array<{code: string; name: string}>;
  items: Array<{code: string; name: string}>;
};

const itemName = (p: {product_line: string | null; variant: string | null} | undefined) => (p ? itemDisplayName(p.product_line, p.variant) || null : null);

export async function getFlagsData(companyId: string, scope: string[] | null): Promise<FlagsData> {
  const empty: FlagsData = {flags: [], tiles: [], adjustments: [], coverage: [], stores: [], items: []};
  if (!nichidoConfigured()) return empty;
  const supa = db();
  const [catalog, stores, flags, adjustments, coverage, forms] = await Promise.all([
    getGlCatalog(companyId),
    getGlStores(companyId),
    fetchAllRows('flags', (from, to) => {
      let q = supa.from('flags').select('*').eq('company_id', companyId); // pagination-ok: paged by fetchAllRows (.range below)
      if (scope) q = q.in('store_code', scope);
      return q.order('created_at', {ascending: false}).order('id').range(from, to);
    }) as unknown as Promise<Array<Record<string, unknown>>>,
    fetchAllRows('adjustments', (from, to) => {
      let q = supa.from('adjustments').select('*').eq('company_id', companyId); // pagination-ok: paged by fetchAllRows (.range below)
      if (scope) q = q.in('store_code', scope);
      return q.order('created_at', {ascending: false}).order('id').range(from, to);
    }) as unknown as Promise<Array<Record<string, unknown>>>,
    scope ? Promise.resolve([] as MonthCoverage[]) : monthCoverage(companyId),
    // One row per store and cycle with the BA on the form, so a clean form shows as Clear.
    fetchAllRows('inventory_snapshots', (from, to) => {
      let q = supa.from('inventory_snapshots').select('store_code,period_end,consultant').eq('company_id', companyId); // pagination-ok: paged by fetchAllRows (.range below)
      if (scope) q = q.in('store_code', scope);
      return q.order('period_end', {ascending: false}).order('store_code').range(from, to);
    }) as unknown as Promise<Array<{store_code: string; period_end: string; consultant: string | null}>>,
  ]);
  const prod = new Map(catalog.map((p) => [p.item_code, p]));
  const storeName = new Map(stores.map((s) => [s.store_code, s.name]));
  const tiles = baTags(
    // Every flag counts, resolved ones too (Oct 26: no admin step, the form was wrong when written).
    flags.map((f) => ({store_code: f.store_code as string, period_end: f.period_end as string, consultant: (f.consultant as string | null) ?? null, cause: f.cause as FlagCause})),
    forms.map((r) => ({store_code: r.store_code, month: r.period_end.slice(0, 7), consultant: r.consultant})),
  ).map((t) => ({...t, storeName: storeName.get(t.store_code) ?? null}));
  // Item names lead everywhere (item codes repeat on the form); the code only tells two
  // items with the same name apart.
  const items = catalog.filter((p) => !p.hidden).map((p) => ({code: p.item_code, name: itemName(p) ?? p.item_code}));
  const nameCount = new Map<string, number>();
  for (const i of items) nameCount.set(i.name, (nameCount.get(i.name) ?? 0) + 1);
  const visibleStores = stores.filter((s) => s.status !== 'closed' && (!scope || scope.includes(s.store_code)));
  return {
    flags: flags.map((f) => ({
      id: f.id as string,
      kind: f.kind as FlagKind,
      cause: f.cause as FlagCause,
      hint: (f.hint as string | null) ?? null,
      status: f.status as FlagStatus,
      storeCode: f.store_code as string,
      storeName: storeName.get(f.store_code as string) ?? null,
      itemCode: f.item_code as string,
      itemName: itemName(prod.get(f.item_code as string)),
      price: prod.get(f.item_code as string)?.unit_price == null ? null : Number(prod.get(f.item_code as string)!.unit_price),
      periodStart: f.period_start as string,
      periodEnd: f.period_end as string,
      consultant: (f.consultant as string | null) ?? null,
      sourceUploadId: (f.source_upload_id as string | null) ?? null,
      details: (f.details as Record<string, unknown>) ?? {},
      remark: (f.remark as string | null) ?? null,
      remarkBy: (f.remark_by as string | null) ?? null,
      remarkedAt: (f.remarked_at as string | null) ?? null,
      resolvedAt: f.status === 'resolved' ? ((f.closed_at as string | null) ?? null) : null,
      createdAt: f.created_at as string,
    })),
    adjustments: adjustments.map((a) => ({
      id: a.id as string,
      storeCode: a.store_code as string,
      storeName: storeName.get(a.store_code as string) ?? null,
      itemCode: a.item_code as string,
      itemName: itemName(prod.get(a.item_code as string)),
      periodStart: a.period_start as string,
      periodEnd: a.period_end as string,
      reason: a.reason as AdjustmentReason,
      qty: Number(a.qty),
      note: (a.note as string | null) ?? null,
      sourceFlagId: (a.source_flag_id as string | null) ?? null,
      createdBy: (a.created_by as string | null) ?? null,
      createdAt: a.created_at as string,
    })),
    tiles,
    coverage,
    stores: visibleStores.map((s) => ({code: s.store_code, name: s.name})).sort((a, b) => a.code.localeCompare(b.code, undefined, {numeric: true})),
    items: items
      .map((i) => (nameCount.get(i.name)! > 1 ? {...i, name: `${i.name} (${i.code})`} : i))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

// ── One form, page by page (the tile's drill-down) ──────────────────────────────────

export type FormCell = 'stockroom' | 'drawer' | 'selling_area' | 'delivery' | 'ending_on_hand';
export type FormRow = {
  itemCode: string;
  name: string;
  stockroom: number | null;
  drawer: number | null;
  selling_area: number | null;
  delivery: number | null;
  ending_on_hand: number | null;
  flagIds: string[];
};
export type FormPage = {page: number | null; uploadId: string | null; rows: FormRow[]};
export type FormCycle = {periodStart: string; periodEnd: string; ba: string | null; pages: FormPage[]};

/**
 * The store's committed forms for one month, as pages (each page is its own upload),
 * filtered to one BA's cycles when given (null = forms with no BA name). Rows keep the
 * form's order; each lists the flags on it (row checks for that cycle, and the month's
 * sales gap on the month's last cycle).
 */
export async function getFormPages(companyId: string, scope: string[] | null, input: {store: string; month: string; ba: string | null}): Promise<FormCycle[]> {
  if (!nichidoConfigured()) return [];
  if (scope && !scope.includes(input.store)) return [];
  const supa = db();
  const [y, m] = input.month.split('-').map(Number);
  const start = `${input.month}-01`;
  const end = `${input.month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
  const [catalog, rows, flags] = await Promise.all([
    getGlCatalog(companyId),
    fetchAllRows('inventory', (from, to) =>
      supa
        .from('inventory') // pagination-ok: paged by fetchAllRows (.range below)
        .select('id,item_code,period_start,period_end,stockroom,drawer,selling_area,delivery,ending_on_hand,consultant,source_upload_id')
        .eq('company_id', companyId)
        .eq('store_code', input.store)
        .gte('period_end', start)
        .lte('period_end', end)
        .order('id')
        .range(from, to),
    ) as unknown as Promise<
      Array<{
        id: number;
        item_code: string;
        period_start: string;
        period_end: string;
        stockroom: number | null;
        drawer: number | null;
        selling_area: number | null;
        delivery: number | null;
        ending_on_hand: number | null;
        consultant: string | null;
        source_upload_id: string | null;
      }>
    >,
    fetchAllRows('flags', (from, to) =>
      supa
        .from('flags') // pagination-ok: paged by fetchAllRows (.range below)
        .select('id,kind,item_code,period_start,period_end,status')
        .eq('company_id', companyId)
        .eq('store_code', input.store)
        .gte('period_end', start)
        .lte('period_end', end)
        .order('id')
        .range(from, to),
    ) as unknown as Promise<Array<{id: string; kind: string; item_code: string; period_start: string; period_end: string}>>,
  ]);
  const mine = rows.filter((r) => (input.ba == null ? !r.consultant?.trim() : basOf(r.consultant).includes(input.ba)));
  const uploadIds = [...new Set(mine.map((r) => r.source_upload_id).filter((u): u is string => !!u))];
  const pageOf = new Map<string, number>();
  for (let i = 0; i < uploadIds.length; i += 100) {
    const res = await supa.from('extractions').select('upload_id,page').eq('company_id', companyId).in('upload_id', uploadIds.slice(i, i + 100)); // pagination-ok: one row per page upload, ≤100 per chunk
    if (res.error) throw new Error(res.error.message);
    for (const e of res.data ?? []) if (e.page != null) pageOf.set(e.upload_id as string, Number(e.page));
  }
  const prod = new Map(catalog.map((p) => [p.item_code, p]));
  const lastEnd = mine.reduce((a, r) => (r.period_end > a ? r.period_end : a), '');
  const cycles = new Map<string, FormCycle & {byUpload: Map<string, FormPage>}>();
  for (const r of mine) {
    const ck = `${r.period_start}|${r.period_end}`;
    let c = cycles.get(ck);
    if (!c) {
      c = {periodStart: r.period_start, periodEnd: r.period_end, ba: r.consultant?.trim() || null, pages: [], byUpload: new Map()};
      cycles.set(ck, c);
    }
    const uk = r.source_upload_id ?? '';
    let pg = c.byUpload.get(uk);
    if (!pg) {
      pg = {page: r.source_upload_id ? (pageOf.get(r.source_upload_id) ?? null) : null, uploadId: r.source_upload_id, rows: []};
      c.byUpload.set(uk, pg);
      c.pages.push(pg);
    }
    const onRow = flags.filter(
      (f) =>
        f.item_code === r.item_code &&
        (f.kind === 'sales_gap' ? r.period_end === lastEnd : f.period_start === r.period_start && f.period_end === r.period_end),
    );
    pg.rows.push({
      itemCode: r.item_code,
      name: itemName(prod.get(r.item_code)) ?? r.item_code,
      stockroom: r.stockroom,
      drawer: r.drawer,
      selling_area: r.selling_area,
      delivery: r.delivery,
      ending_on_hand: r.ending_on_hand,
      flagIds: onRow.map((f) => f.id),
    });
  }
  return [...cycles.values()]
    .sort((a, b) => a.periodEnd.localeCompare(b.periodEnd))
    .map(({byUpload: _drop, ...c}) => ({...c, pages: c.pages.sort((a, b) => (a.page ?? 1e9) - (b.page ?? 1e9))}));
}
