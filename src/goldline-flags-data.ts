import 'server-only';
import {nichidoConfigured, nichidoDb} from './nichido-client';
import {fetchAllRows} from './pos-fetch-paginate';
import {getGlCatalog, getGlStores} from './goldline-ref-data';
import {monthCoverage, type FlagStatus, type MonthCoverage} from './goldline-checks-data';
import type {AdjustmentReason} from './goldline-flags-writes';
import type {FlagCause, FlagKind} from './goldline-checks';
import {itemDisplayName} from './goldline-item-name';

// Reads for the flag queue (F7) and adjustments (F5). Flags are written by the checks
// (src/goldline-checks-data.ts); admin writes are in src/goldline-flags-writes.ts.
// Store-scoped roles only see their own stores.

const db = nichidoDb;

export type {AdjustmentReason};
export type FlagRow = {
  id: string;
  kind: FlagKind;
  cause: FlagCause;
  originalCause: FlagCause | null;
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
  closedBy: string | null;
  closedAt: string | null;
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
export type FlagsData = {
  flags: FlagRow[];
  adjustments: AdjustmentRow[];
  coverage: MonthCoverage[];
  stores: Array<{code: string; name: string}>;
  items: Array<{code: string; name: string}>;
};

const itemName = (p: {product_line: string | null; variant: string | null} | undefined) => (p ? itemDisplayName(p.product_line, p.variant) || null : null);

export async function getFlagsData(companyId: string, scope: string[] | null): Promise<FlagsData> {
  const empty: FlagsData = {flags: [], adjustments: [], coverage: [], stores: [], items: []};
  if (!nichidoConfigured()) return empty;
  const supa = db();
  const [catalog, stores, flags, adjustments, coverage] = await Promise.all([
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
  ]);
  const prod = new Map(catalog.map((p) => [p.item_code, p]));
  const storeName = new Map(stores.map((s) => [s.store_code, s.name]));
  const visibleStores = stores.filter((s) => s.status !== 'closed' && (!scope || scope.includes(s.store_code)));
  return {
    flags: flags.map((f) => ({
      id: f.id as string,
      kind: f.kind as FlagKind,
      cause: f.cause as FlagCause,
      originalCause: (f.original_cause as FlagCause | null) ?? null,
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
      closedBy: (f.closed_by as string | null) ?? null,
      closedAt: (f.closed_at as string | null) ?? null,
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
    coverage,
    stores: visibleStores.map((s) => ({code: s.store_code, name: s.name})).sort((a, b) => a.code.localeCompare(b.code, undefined, {numeric: true})),
    items: catalog.filter((p) => !p.hidden).map((p) => ({code: p.item_code, name: itemName(p) ?? p.item_code})),
  };
}
