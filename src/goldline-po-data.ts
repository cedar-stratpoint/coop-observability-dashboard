import 'server-only';
import {nichidoConfigured, nichidoDb} from './nichido-client';
import {fetchAllRows} from './pos-fetch-paginate';
import {getGlCatalog, getGlStores} from './goldline-ref-data';
import {itemDisplayName} from './goldline-item-name';
import {manilaDate} from './goldline-supply';
import {approvedTotal, lineAmount, poNumber, poStatus, shadeOf, shortBy, type PoStatus} from './goldline-po';

// Server-only reads behind the Orders pages (F12): the list of purchase orders and one
// PO laid out like the paper form, its Line and Remarks columns showing the owner's
// decision on the Restock run (F11). Company-fenced on every query and narrowed to a
// store-scoped role's stores. POs and lines are read fresh (receipts change them); names
// and prices come from the cached catalog and store list.

const db = nichidoDb;

export type PoListRow = {
  id: string;
  poNo: number;
  number: string; // PO-0042
  storeCode: string;
  storeName: string | null;
  cycle: string;
  createdAt: string;
  date: string; // po_date: the day the PO was made, Manila (YYYY-MM-DD); one PO per store per day
  status: PoStatus;
  lines: number;
  receivedLines: number;
  approvedTotal: number;
};

/** What the owner decided on the Restock run (F11), shown in the PO's Line and Remarks columns. */
type RunDecision = {decision: 'approved' | 'edited'; suggested: number | null; remark: string | null; decidedBy: string | null; decidedAt: string | null};

export type PoLine = {
  id: string;
  recommendationId: string;
  itemCode: string;
  name: string; // "Line · shade"
  productLine: string | null;
  shade: string;
  qty: number;
  unitPrice: number | null;
  amount: number | null;
  shipmentId: string;
  shippedOn: string | null;
  arrivesOn: string | null;
  receivedQty: number | null;
  receivedOn: string | null;
  receivedBy: string | null;
  short: number;
} & RunDecision;

/** A line the owner rejected on the run: not on the PO, shown struck through like the mockup. */
export type RejectedLine = {
  recommendationId: string;
  itemCode: string;
  name: string;
  productLine: string | null;
  shade: string;
  suggested: number | null;
  remark: string | null;
};

export type PurchaseOrder = {
  id: string;
  poNo: number;
  number: string;
  storeCode: string;
  storeName: string | null;
  cycle: string;
  runId: string;
  module: string | null;
  consultant: string | null; // the store's BA on the PO date (the paper form's "Beauty Consultant")
  createdAt: string;
  date: string; // the PO's date in Manila (YYYY-MM-DD), the paper form's "Date"
  createdBy: string | null;
  status: PoStatus;
  lines: PoLine[];
  rejected: RejectedLine[];
  approvedTotal: number;
  today: string;
};

type PoRow = {id: string; po_no: number; store_code: string; run_id: string; po_date: string; module: string | null; created_at: string; created_by: string | null; restock_runs: {cycle: string} | null};
type LineRow = {
  id: string;
  po_id: string;
  recommendation_id: string;
  item_code: string;
  qty: number;
  unit_price: string | number | null;
  shipment_id: string;
  received_qty: number | null;
  received_on: string | null;
  received_by: string | null;
  shipments: {shipped_on: string; arrives_on: string} | null;
  recommendations: {decision: 'approved' | 'edited'; suggested: number | null; remark: string | null; decided_by: string | null; decided_at: string | null} | null;
};

const PO_COLS = 'id,po_no,store_code,run_id,po_date,module,created_at,created_by,restock_runs(cycle)';
const LINE_COLS =
  'id,po_id,recommendation_id,item_code,qty,unit_price,shipment_id,received_qty,received_on,received_by,shipments(shipped_on,arrives_on),recommendations(decision,suggested,remark,decided_by,decided_at)';
const num = (v: string | number | null) => (v == null ? null : Number(v));
const one = <T,>(v: T | T[] | null): T | null => (Array.isArray(v) ? v[0] ?? null : v);

async function linesFor(companyId: string, poIds: string[], cols: string): Promise<LineRow[]> {
  const out: LineRow[] = [];
  for (let i = 0; i < poIds.length; i += 100) {
    const chunk = poIds.slice(i, i + 100);
    out.push(
      ...((await fetchAllRows('po_lines', (from, to) =>
        db().from('po_lines').select(cols).eq('company_id', companyId).in('po_id', chunk).order('id').range(from, to), // pagination-ok: paged by fetchAllRows (.range below)
      )) as unknown as LineRow[]),
    );
  }
  return out;
}

/** One tile on the Orders page: a day POs were made, added up in the database (po_dates). */
export type PoDate = {date: string; pos: number; lines: number; received: number; total: number; cycles: string[]};

/** Every day POs were made, newest first, with its totals (one row per date, not per PO). */
export async function getPoDates(companyId: string, storeScope?: string[] | null): Promise<{configured: boolean; dates: PoDate[]}> {
  if (!nichidoConfigured()) return {configured: false, dates: []};
  // pagination-ok: one row per order date (~50 to 70 a year), far under the row cap.
  const {data, error} = await db().rpc('po_dates', {p_company: companyId, p_stores: storeScope ?? null});
  if (error) throw new Error(`po_dates failed: ${error.message}`);
  const rows = (data ?? []) as Array<{po_date: string; pos: number; lines: number; received: number; total: string | number; cycles: string[] | null}>;
  return {configured: true, dates: rows.map((r) => ({date: r.po_date, pos: r.pos, lines: r.lines, received: r.received, total: Number(r.total) || 0, cycles: r.cycles ?? []}))};
}

/** One day's POs (one per store), with their lines added up. */
export async function listPurchaseOrders(companyId: string, date: string, storeScope?: string[] | null): Promise<PoListRow[]> {
  if (!nichidoConfigured()) return [];
  const scope = storeScope ?? null;
  const [pos, stores] = await Promise.all([
    fetchAllRows('purchase_orders', (from, to) => {
      let q = db().from('purchase_orders').select(PO_COLS).eq('company_id', companyId).eq('po_date', date); // pagination-ok: paged by fetchAllRows (.range below)
      if (scope) q = q.in('store_code', scope);
      return q.order('po_no', {ascending: false}).range(from, to);
    }) as unknown as Promise<PoRow[]>,
    getGlStores(companyId),
  ]);
  const lines = await linesFor(companyId, pos.map((p) => p.id), 'id,po_id,qty,unit_price,received_qty');
  const byPo = new Map<string, LineRow[]>();
  for (const l of lines) byPo.set(l.po_id, [...(byPo.get(l.po_id) ?? []), l]);
  const nameOf = new Map(stores.map((s) => [s.store_code, s.name]));

  const rows = pos
    .map((p): PoListRow => {
      const ls = (byPo.get(p.id) ?? []).map((l) => ({qty: l.qty, unitPrice: num(l.unit_price), receivedQty: l.received_qty}));
      return {
        id: p.id,
        poNo: p.po_no,
        number: poNumber(p.po_no),
        storeCode: p.store_code,
        storeName: nameOf.get(p.store_code) ?? null,
        cycle: one(p.restock_runs)?.cycle ?? '',
        createdAt: p.created_at,
        date: p.po_date,
        status: poStatus(ls),
        lines: ls.length,
        receivedLines: ls.filter((l) => l.receivedQty != null).length,
        approvedTotal: approvedTotal(ls),
      };
    })
    .filter((r) => r.lines > 0);
  return rows;
}

/** The store's BA on a date: the directory first (store_bas), else the name on its latest form. */
async function consultantOn(companyId: string, store: string, date: string): Promise<string | null> {
  const supa = db();
  // pagination-ok: one store's assignments on one date, newest first, 1 row.
  const assigned = await supa
    .from('store_bas')
    .select('started_on,bas(name)')
    .eq('company_id', companyId)
    .eq('store_code', store)
    .lte('started_on', date)
    .or(`ended_on.is.null,ended_on.gte.${date}`)
    .order('started_on', {ascending: false})
    .limit(1);
  const name = one((assigned.data?.[0] as {bas: {name: string} | {name: string}[] | null} | undefined)?.bas ?? null)?.name;
  if (name?.trim()) return name.trim();
  // pagination-ok: one store's latest form row with a BA name, 1 row.
  const form = await supa
    .from('inventory')
    .select('consultant')
    .eq('company_id', companyId)
    .eq('store_code', store)
    .lte('period_start', date)
    .not('consultant', 'is', null)
    .neq('consultant', '')
    .order('period_end', {ascending: false})
    .limit(1);
  return (form.data?.[0] as {consultant: string} | undefined)?.consultant?.trim() || null;
}

/** One PO with its lines (null when it isn't this company's or is outside the role's stores). */
export async function getPurchaseOrder(companyId: string, id: string, storeScope?: string[] | null): Promise<PurchaseOrder | null> {
  if (!nichidoConfigured()) return null;
  // pagination-ok: one row by primary key.
  const {data, error} = await db().from('purchase_orders').select(PO_COLS).eq('company_id', companyId).eq('id', id).maybeSingle();
  if (error) throw new Error(`purchase_orders read failed: ${error.message}`);
  const po = data as unknown as PoRow | null;
  if (!po || (storeScope && !storeScope.includes(po.store_code))) return null;

  const [rows, rejectedRows, catalog, stores, consultant] = await Promise.all([
    linesFor(companyId, [po.id], LINE_COLS),
    fetchAllRows('recommendations', (from, to) =>
      db()
        .from('recommendations') // pagination-ok: paged by fetchAllRows (.range below)
        .select('id,item_code,suggested,remark')
        .eq('company_id', companyId)
        .eq('run_id', po.run_id)
        .eq('store_code', po.store_code)
        .eq('decision', 'rejected')
        .order('id')
        .range(from, to),
    ) as unknown as Promise<Array<{id: string; item_code: string; suggested: number | null; remark: string | null}>>,
    getGlCatalog(companyId),
    getGlStores(companyId),
    consultantOn(companyId, po.store_code, po.po_date),
  ]);
  const product = new Map(catalog.map((p) => [p.item_code, p]));
  const lines = rows.map((r): PoLine => {
    const p = product.get(r.item_code);
    const price = num(r.unit_price);
    const ship = one(r.shipments);
    const rec = one(r.recommendations);
    return {
      id: r.id,
      recommendationId: r.recommendation_id,
      itemCode: r.item_code,
      name: itemDisplayName(p?.product_line, p?.variant, r.item_code),
      productLine: p?.product_line ?? null,
      shade: shadeOf(p?.product_line ?? null, p?.variant ?? null, r.item_code),
      qty: r.qty,
      unitPrice: price,
      amount: lineAmount(r.qty, price),
      decision: rec?.decision ?? 'approved',
      suggested: rec?.suggested ?? null,
      remark: rec?.remark ?? null,
      decidedBy: rec?.decided_by ?? null,
      decidedAt: rec?.decided_at ?? null,
      shipmentId: r.shipment_id,
      shippedOn: ship?.shipped_on ?? null,
      arrivesOn: ship?.arrives_on ?? null,
      receivedQty: r.received_qty,
      receivedOn: r.received_on,
      receivedBy: r.received_by,
      short: shortBy({qty: r.qty, receivedQty: r.received_qty}),
    };
  });
  return {
    id: po.id,
    poNo: po.po_no,
    number: poNumber(po.po_no),
    storeCode: po.store_code,
    storeName: stores.find((s) => s.store_code === po.store_code)?.name ?? null,
    cycle: one(po.restock_runs)?.cycle ?? '',
    runId: po.run_id,
    module: po.module,
    consultant,
    createdAt: po.created_at,
    date: po.po_date,
    createdBy: po.created_by,
    status: poStatus(lines),
    lines,
    rejected: rejectedRows.map((r) => {
      const p = product.get(r.item_code);
      return {
        recommendationId: r.id,
        itemCode: r.item_code,
        name: itemDisplayName(p?.product_line, p?.variant, r.item_code),
        productLine: p?.product_line ?? null,
        shade: shadeOf(p?.product_line ?? null, p?.variant ?? null, r.item_code),
        suggested: r.suggested,
        remark: r.remark,
      };
    }),
    approvedTotal: approvedTotal(lines),
    today: manilaDate(),
  };
}

/**
 * A run's lines that are on a PO: recommendation id → its PO. `locked` = the stock was
 * received or is due to have arrived, so the owner can no longer change the line (its
 * shipment can't be cancelled).
 */
export async function runPoLinks(companyId: string, runId: string): Promise<Map<string, {poId: string; number: string; locked: boolean}>> {
  if (!nichidoConfigured()) return new Map();
  const pos = (await fetchAllRows('purchase_orders', (from, to) =>
    db().from('purchase_orders').select('id,po_no').eq('company_id', companyId).eq('run_id', runId).order('id').range(from, to), // pagination-ok: paged by fetchAllRows (.range below)
  )) as unknown as Array<{id: string; po_no: number}>;
  const numberOf = new Map(pos.map((p) => [p.id, poNumber(p.po_no)]));
  const lines = await linesFor(companyId, pos.map((p) => p.id), 'id,po_id,recommendation_id,received_qty,shipments(arrives_on)');
  const today = manilaDate();
  return new Map(
    lines.map((l) => {
      const arrives = one(l.shipments)?.arrives_on;
      return [l.recommendation_id, {poId: l.po_id, number: numberOf.get(l.po_id) ?? '', locked: l.received_qty != null || (arrives != null && arrives <= today)}];
    }),
  );
}

/** Store of a PO (for scope checks), or null. */
export async function poStore(companyId: string, id: string): Promise<string | null> {
  // pagination-ok: one row by primary key.
  const {data, error} = await db().from('purchase_orders').select('store_code').eq('company_id', companyId).eq('id', id).maybeSingle();
  if (error) throw new Error(`purchase_orders read failed: ${error.message}`);
  return (data as {store_code: string} | null)?.store_code ?? null;
}

/** Store of each PO line (for scope checks). */
export async function poLineStores(companyId: string, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 200) {
    // pagination-ok: by id, at most 200 rows per chunk.
    const {data, error} = await db().from('po_lines').select('id,store_code').eq('company_id', companyId).in('id', ids.slice(i, i + 200)).limit(200);
    if (error) throw new Error(`po_lines read failed: ${error.message}`);
    for (const r of (data ?? []) as Array<{id: string; store_code: string}>) out.set(r.id, r.store_code);
  }
  return out;
}
