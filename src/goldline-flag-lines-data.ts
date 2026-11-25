import 'server-only';
import {nichidoConfigured, nichidoDb} from './nichido-client';
import {fetchAllRows} from './pos-fetch-paginate';
import {getGlCatalog, getGlStores} from './goldline-ref-data';
import {itemDisplayName} from './goldline-item-name';
import {checkWhy, filePage, markWhy, type FlagLine} from './goldline-flag-lines';
import type {MarkKind} from './goldline-review-marks';

// Every flag as one line, with where it is (NICH-43 §3, §4). Reads the BA scorecard flags and
// the review flags, then joins each to its page (uploads), the page's form (upload_batches:
// store and period) and the page's read header (BA, store and period as written), live, since
// a page's store is often set after it was flagged. A store-limited role sees only its stores;
// a flag whose store isn't known yet is hidden from such a role. Nichido project, service role.

const db = nichidoDb;
const ISO = /^\d{4}-\d{2}-\d{2}/;

type MarkRow = {id: string; upload_id: string; item_code: string | null; kind: MarkKind; source: 'reader' | 'reviewer'; reason: string | null; status: string; created_at: string};
type CheckRow = {id: string; kind: string; status: string; store_code: string; item_code: string; period_end: string; consultant: string | null; source_upload_id: string | null; remark: string | null; created_at: string};
type PageInfo = {filename: string; batchId: string | null; batchName: string | null};
type FormInfo = {store: string | null; periodEnd: string | null};
type HeadInfo = {store: string | null; periodEnd: string | null; ba: string | null};

async function inChunks<T>(ids: string[], read: (chunk: string[]) => Promise<T[]>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += 100) out.push(...(await read(ids.slice(i, i + 100))));
  return out;
}

export type FlagLinesData = {configured: boolean; lines: FlagLine[]; stores: Array<{code: string; name: string | null}>; months: string[]};

export async function flagLines(companyId: string, scope: string[] | null): Promise<FlagLinesData> {
  if (!nichidoConfigured()) return {configured: false, lines: [], stores: [], months: []};
  if (scope && scope.length === 0) return {configured: true, lines: [], stores: [], months: []};
  const [catalog, stores, marks, checks] = await Promise.all([
    getGlCatalog(companyId),
    getGlStores(companyId),
    fetchAllRows('review_marks', (from, to) =>
      db().from('review_marks').select('id,upload_id,item_code,kind,source,reason,status,created_at').eq('company_id', companyId).order('created_at', {ascending: false}).order('id').range(from, to),
    ) as unknown as Promise<MarkRow[]>,
    fetchAllRows('flags', (from, to) => {
      let q = db().from('flags').select('id,kind,status,store_code,item_code,period_end,consultant,source_upload_id,remark,created_at').eq('company_id', companyId); // pagination-ok: paged by fetchAllRows (.range below)
      if (scope) q = q.in('store_code', scope);
      return q.order('created_at', {ascending: false}).order('id').range(from, to);
    }) as unknown as Promise<CheckRow[]>,
  ]);

  const uploadIds = [...new Set([...marks.map((m) => m.upload_id), ...checks.map((c) => c.source_upload_id).filter((x): x is string => Boolean(x))])];
  const pages = new Map<string, PageInfo>();
  const heads = new Map<string, HeadInfo>();
  // pagination-ok: chunks of 100 ids, one row per upload (and one extraction per upload) each.
  const [ups, exts] = await Promise.all([
    inChunks(uploadIds, async (chunk) => {
      const r = await db().from('uploads').select('id,filename,batch_id,batch_name').eq('company_id', companyId).in('id', chunk);
      if (r.error) throw new Error(`uploads read failed: ${r.error.message}`);
      return (r.data ?? []) as Array<{id: string; filename: string; batch_id: string | null; batch_name: string | null}>;
    }),
    inChunks(uploadIds, async (chunk) => {
      const r = await db().from('extractions').select('upload_id,store:rows->>store_code,pe:rows->>period_end,ba:rows->>consultant').eq('company_id', companyId).in('upload_id', chunk); // pagination-ok: ≤100 ids, one extraction each
      if (r.error) throw new Error(`extractions read failed: ${r.error.message}`);
      return (r.data ?? []) as unknown as Array<{upload_id: string; store: string | null; pe: string | null; ba: string | null}>;
    }),
  ]);
  for (const u of ups) pages.set(u.id, {filename: u.filename, batchId: u.batch_id, batchName: u.batch_name});
  for (const e of exts) heads.set(e.upload_id, {store: e.store?.trim() || null, periodEnd: e.pe && ISO.test(e.pe) ? e.pe.slice(0, 10) : null, ba: e.ba?.trim() || null});

  const batchIds = [...new Set(ups.map((u) => u.batch_id).filter((x): x is string => Boolean(x)))];
  const forms = new Map<string, FormInfo>();
  // pagination-ok: chunks of 100 ids, one row per batch.
  for (const b of await inChunks(batchIds, async (chunk) => {
    const r = await db().from('upload_batches').select('id,store_code,period_end').eq('company_id', companyId).in('id', chunk);
    if (r.error) throw new Error(`upload_batches read failed: ${r.error.message}`);
    return (r.data ?? []) as Array<{id: string; store_code: string | null; period_end: string | null}>;
  }))
    forms.set(b.id, {store: b.store_code, periodEnd: b.period_end});

  const prod = new Map(catalog.map((p) => [p.item_code, itemDisplayName(p.product_line, p.variant, p.item_code)]));
  const storeName = new Map(stores.map((s) => [s.store_code, s.name]));
  const where = (uploadId: string | null) => {
    const pg = uploadId ? pages.get(uploadId) : undefined;
    const form = pg?.batchId ? forms.get(pg.batchId) : undefined;
    const head = uploadId ? heads.get(uploadId) : undefined;
    return {pg, ...filePage(pg?.filename, pg?.batchName), store: form?.store ?? head?.store ?? null, periodEnd: form?.periodEnd ?? head?.periodEnd ?? null, ba: head?.ba ?? null};
  };

  const lines: FlagLine[] = [];
  for (const m of marks) {
    const w = where(m.upload_id);
    if (!w.pg) continue; // the page was deleted
    if (scope && (!w.store || !scope.includes(w.store))) continue;
    const code = m.item_code && !m.item_code.startsWith('written-in ') ? m.item_code : null;
    lines.push({
      key: `m:${m.id}`,
      source: m.source,
      why: markWhy(m.kind),
      note: m.reason,
      open: m.status === 'open',
      storeCode: w.store,
      storeName: w.store ? (storeName.get(w.store) ?? null) : null,
      ba: w.ba,
      month: w.periodEnd?.slice(0, 7) ?? null,
      itemCode: code ?? (m.item_code ? m.item_code : null),
      product: code ? (prod.get(code) ?? null) : m.item_code ? 'Hand-written, no code read' : 'Whole page',
      uploadId: m.upload_id,
      file: w.file,
      page: w.page,
      pageOf: w.pageOf,
      createdAt: m.created_at,
    });
  }
  for (const c of checks) {
    const w = where(c.source_upload_id);
    lines.push({
      key: `f:${c.id}`,
      source: 'check',
      why: checkWhy(c.kind),
      note: c.remark,
      open: c.status === 'open',
      storeCode: c.store_code,
      storeName: storeName.get(c.store_code) ?? null,
      ba: c.consultant ?? w.ba,
      month: c.period_end?.slice(0, 7) ?? null,
      itemCode: c.item_code,
      product: prod.get(c.item_code) ?? null,
      uploadId: w.pg ? c.source_upload_id : null,
      file: w.file,
      page: w.page,
      pageOf: w.pageOf,
      createdAt: c.created_at,
    });
  }
  const inStores = [...new Set(lines.map((l) => l.storeCode).filter((x): x is string => Boolean(x)))].sort((a, b) => a.localeCompare(b, undefined, {numeric: true}));
  const months = [...new Set(lines.map((l) => l.month).filter((x): x is string => Boolean(x)))].sort().reverse();
  return {configured: true, lines, stores: inStores.map((code) => ({code, name: storeName.get(code) ?? null})), months};
}
