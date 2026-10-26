import 'server-only';
import {nichidoConfigured, nichidoDb} from './nichido-client';
import {fetchAllRows} from './pos-fetch-paginate';
import {
  DEFAULT_SETTINGS,
  monthlyChecks,
  rowFindings,
  type Adjustment,
  type CellMark,
  type CheckSettings,
  type CountRow,
  type Finding,
  type FlagCause,
  type MarkedRow,
  type MonthCheck,
} from './goldline-checks';

// Runs the P2 checks over committed counts and keeps `flags` in step (F6, F7):
//   * a new finding opens a flag
//   * an open flag whose finding is still there gets fresh numbers
//   * an open flag whose finding is gone (a corrected count, a logged adjustment, a
//     newly linked SKU) is closed as 'resolved'
//   * a flag an admin closed (checked / dismissed) is never touched again
// Re-running is safe; flags are unique per kind, store, item and period.

const db = nichidoDb;

export type FlagStatus = 'open' | 'checked' | 'dismissed' | 'resolved';
export type MonthCoverage = {month: string; match: number; flag: number; baseline: number; waiting_sales: number; unlinked: number; not_counted: number};
export type ChecksRun = {opened: number; updated: number; resolved: number; months: MonthCheck[]};

type StoredFlag = {id: string; kind: string; store_code: string; item_code: string; period_start: string; period_end: string; status: FlagStatus};

const fkey = (f: {kind: string; store_code: string; item_code: string; period_start: string; period_end: string}) =>
  `${f.kind}|${f.store_code}|${f.item_code}|${f.period_start}|${f.period_end}`;

export async function getCheckSettings(companyId: string): Promise<CheckSettings> {
  const res = await db().from('check_settings').select('gap_min_units,gap_pct').eq('company_id', companyId).maybeSingle();
  if (res.error || !res.data) return DEFAULT_SETTINGS;
  return {gapMinUnits: Number(res.data.gap_min_units), gapPct: Number(res.data.gap_pct)};
}

/** Everything the checks read, for the given stores (all counted stores when omitted). */
async function loadInputs(companyId: string, stores?: string[]) {
  const supa = db();
  const counts = (await fetchAllRows('inventory', (from, to) => {
    let q = supa
      .from('inventory') // pagination-ok: paged by fetchAllRows (.range below)
      .select('store_code,item_code,period_start,period_end,stockroom,drawer,selling_area,delivery,ending_on_hand,consultant,source_upload_id')
      .eq('company_id', companyId);
    if (stores) q = q.in('store_code', stores);
    return q.order('id').range(from, to);
  })) as unknown as CountRow[];
  const counted = [...new Set(counts.map((c) => c.store_code))];
  if (!counted.length) return {counts, counted, adjustments: [], marked: [], products: [], sales: [], salesMonths: new Set<string>(), settings: DEFAULT_SETTINGS};

  const months = [...new Set(counts.map((c) => c.period_end.slice(0, 7)))].sort();
  const [adjustments, products, salesMonthsRes, settings, extractions] = await Promise.all([
    fetchAllRows('adjustments', (from, to) =>
      supa.from('adjustments').select('store_code,item_code,period_end,qty').eq('company_id', companyId).in('store_code', counted).order('id').range(from, to),
    ) as unknown as Promise<Adjustment[]>,
    fetchAllRows('products', (from, to) =>
      supa.from('products').select('item_code,sku_code').eq('company_id', companyId).order('item_code').range(from, to),
    ) as unknown as Promise<Array<{item_code: string; sku_code: string | null}>>,
    supa.rpc('sales_months', {p_company: companyId}),
    getCheckSettings(companyId),
    fetchAllRows('extractions', (from, to) =>
      supa.from('extractions').select('upload_id,rows').eq('company_id', companyId).eq('status', 'confirmed').order('id').range(from, to),
    ) as unknown as Promise<Array<{upload_id: string; rows: unknown}>>,
  ]);
  if (salesMonthsRes.error) throw new Error(`sales_months failed: ${salesMonthsRes.error.message}`);
  const salesMonths = new Set(((salesMonthsRes.data ?? []) as unknown as string[]).map((d) => String(d).slice(0, 7)));

  // POS units only for counted stores and the months they were counted in.
  const sales = (await fetchAllRows('sales', (from, to) =>
    supa
      .from('sales')
      .select('store_code,sku_code,period_start,units')
      .eq('company_id', companyId)
      .in('store_code', counted)
      .gte('period_start', `${months[0]}-01`)
      .order('id')
      .range(from, to),
  )) as unknown as Array<{store_code: string; sku_code: string; period_start: string; units: number | null}>;

  // Cells the scan reader marked (F3), from confirmed pages, tied to the counted row.
  const countAt = new Map(counts.map((c) => [`${c.source_upload_id}|${c.item_code}`, c]));
  const marked: MarkedRow[] = [];
  for (const e of extractions) {
    const page = e.rows as {rows?: Array<{item_code?: string; marks?: CellMark[]}>} | null;
    for (const r of page?.rows ?? []) {
      if (!r.item_code || !r.marks?.length) continue;
      const c = countAt.get(`${e.upload_id}|${r.item_code}`);
      if (c) marked.push({store_code: c.store_code, item_code: c.item_code, period_start: c.period_start, period_end: c.period_end, upload_id: e.upload_id, marks: r.marks});
    }
  }
  return {counts, counted, adjustments, marked, products, sales, salesMonths, settings};
}

/** POS units per store, item and month, through the Watsons SKU links. */
function posIndex(products: Array<{item_code: string; sku_code: string | null}>, sales: Array<{store_code: string; sku_code: string; period_start: string; units: number | null}>) {
  const itemBySku = new Map(products.filter((p) => p.sku_code?.trim()).map((p) => [p.sku_code!.trim(), p.item_code]));
  const pos = new Map<string, number>();
  for (const s of sales) {
    const item = itemBySku.get(s.sku_code);
    if (!item) continue;
    const k = `${s.store_code}|${item}|${s.period_start.slice(0, 7)}`;
    pos.set(k, (pos.get(k) ?? 0) + (Number(s.units) || 0));
  }
  return {linked: new Set(itemBySku.values()), posSold: (store: string, item: string, month: string) => pos.get(`${store}|${item}|${month}`)};
}

/** Run the checks for some stores (all counted stores when omitted) and sync `flags`. */
export async function runChecks(companyId: string, stores?: string[]): Promise<ChecksRun> {
  if (!nichidoConfigured()) return {opened: 0, updated: 0, resolved: 0, months: []};
  const supa = db();
  const inp = await loadInputs(companyId, stores);
  if (!inp.counted.length) return {opened: 0, updated: 0, resolved: 0, months: []};

  const idx = posIndex(inp.products, inp.sales);
  const monthly = monthlyChecks({counts: inp.counts, adjustments: inp.adjustments, posSold: idx.posSold, salesMonths: inp.salesMonths, linked: idx.linked, settings: inp.settings});
  const findings: Finding[] = [...rowFindings(inp.counts, inp.marked), ...monthly.findings];

  const existing = (await fetchAllRows('flags', (from, to) =>
    supa
      .from('flags')
      .select('id,kind,store_code,item_code,period_start,period_end,status')
      .eq('company_id', companyId)
      .in('store_code', inp.counted)
      .order('id')
      .range(from, to),
  )) as unknown as StoredFlag[];
  const byKey = new Map(existing.map((f) => [fkey(f), f]));
  const now = new Date().toISOString();

  const inserts: Array<Record<string, unknown>> = [];
  let updated = 0;
  const seen = new Set<string>();
  for (const f of findings) {
    const k = fkey(f);
    seen.add(k);
    const prev = byKey.get(k);
    const fields = {consultant: f.consultant, source_upload_id: f.source_upload_id, details: f.details, updated_at: now};
    if (!prev) inserts.push({company_id: companyId, kind: f.kind, cause: f.cause, store_code: f.store_code, item_code: f.item_code, period_start: f.period_start, period_end: f.period_end, ...fields});
    else if (prev.status === 'open' || prev.status === 'resolved') {
      // Still there (or back again after it cleared): refresh the numbers, keep it open.
      const res = await supa
        .from('flags')
        .update({...fields, status: 'open', closed_at: null, closed_by: null, ...(prev.status === 'resolved' ? {remark: null} : {})})
        .eq('id', prev.id);
      if (res.error) throw new Error(`flag update failed: ${res.error.message}`);
      updated++;
    }
  }
  for (let i = 0; i < inserts.length; i += 500) {
    const res = await supa.from('flags').insert(inserts.slice(i, i + 500));
    if (res.error) throw new Error(`flag insert failed: ${res.error.message}`);
  }
  const gone = existing.filter((f) => f.status === 'open' && !seen.has(fkey(f))).map((f) => f.id);
  for (let i = 0; i < gone.length; i += 200) {
    const res = await supa
      .from('flags')
      .update({status: 'resolved', remark: 'Cleared by the data (the count, an adjustment or a SKU link changed).', closed_at: now, closed_by: 'coop', updated_at: now})
      .in('id', gone.slice(i, i + 200));
    if (res.error) throw new Error(`flag resolve failed: ${res.error.message}`);
  }
  return {opened: inserts.length, updated, resolved: gone.length, months: monthly.months};
}

/** Read-only: the month-by-month form vs. sales picture (for coverage on the flags page). */
export async function monthCoverage(companyId: string): Promise<MonthCoverage[]> {
  if (!nichidoConfigured()) return [];
  const inp = await loadInputs(companyId);
  if (!inp.counted.length) return [];
  const idx = posIndex(inp.products, inp.sales);
  const {months} = monthlyChecks({counts: inp.counts, adjustments: inp.adjustments, posSold: idx.posSold, salesMonths: inp.salesMonths, linked: idx.linked, settings: inp.settings});
  const by = new Map<string, MonthCoverage>();
  for (const m of months) {
    const r = by.get(m.month) ?? {month: m.month, match: 0, flag: 0, baseline: 0, waiting_sales: 0, unlinked: 0, not_counted: 0};
    r[m.state]++;
    by.set(m.month, r);
  }
  return [...by.values()].sort((a, b) => b.month.localeCompare(a.month));
}

export type {FlagCause};
