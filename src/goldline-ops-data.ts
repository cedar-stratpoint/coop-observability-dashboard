import 'server-only';
import {createClient, type SupabaseClient} from '@supabase/supabase-js';
import {fetchAllRows} from './pos-fetch-paginate';
import {getGlCatalog, getGlStores} from './goldline-ref-data';
import type {InventoryRowIn} from './goldline-inventory';
import {addDays, formTimeliness, isCurrentCount, pickCurrentPeriod, storeHealth, storeMovement, type Count, type StoreHealth} from './goldline-movement';

// Server-only reads behind the stock forecast, Action Feed and store Health. Company
// scoped on every query (service-role key bypasses RLS; company_id is the fence),
// optionally narrowed to a store-scoped role's stores.
//
// Reads the last ~70 days of counts (up to four semi-monthly counts per store) — the
// history the movement estimate needs — never the whole inventory history. At the
// full 300-store ramp this is a few hundred thousand rows per load; that's the point
// to move the rollup into a SQL function / materialized view.

const url = process.env.SUPABASE_URL_ARCHIVE;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY_ARCHIVE;
const HISTORY_DAYS = 70;
const SNAPSHOT_WINDOW_DAYS = 180; // pickers / current period only need recent periods
// Typical gap between today and the latest count (forms are semi-monthly, committed
// within days). A store counted longer ago than this is re-read with its own window.
const EARLY_LAG_DAYS = 25;

function db(): SupabaseClient {
  return createClient(url as string, key as string, {auth: {persistSession: false}});
}

export type StoreOps = {
  storeCode: string;
  storeName: string | null;
  movement: ReturnType<typeof storeMovement>;
  health: StoreHealth;
  committedAt: string | null; // latest count's last commit
  countedCurrent: boolean; // has a count for the company's current period
};

export type OpsData = {
  currentPeriod: {start: string; end: string} | null; // the company's latest form period
  stores: StoreOps[];
  catalog: Record<string, {name: string; productLine: string | null; price: number | null; bestseller: boolean}>;
  pendingReview: number;
};

export async function getOpsData(companyId: string, storeScope?: string[] | null): Promise<OpsData> {
  const empty: OpsData = {currentPeriod: null, stores: [], catalog: {}, pendingReview: 0};
  if (!url || !key) return empty;
  const supa = db();
  const scope = storeScope ? new Set(storeScope) : null;
  const sinceSnapshots = addDays(new Date().toISOString().slice(0, 10), -SNAPSHOT_WINDOW_DAYS);

  // Counts load alongside the period lookup (one round trip, not two): read a window
  // from today wide enough for the usual lag, trim to the current period in memory, and
  // only re-read in the rare case the company's latest count is older than that window.
  const today = new Date().toISOString().slice(0, 10);
  const readCounts = (since: string) =>
    fetchAllRows(
      'gl_inventory',
      (from, to) => {
        let q = supa
          .from('gl_inventory') // pagination-ok: paged by fetchAllRows (.range below)
          .select('store_code,item_code,period_start,period_end,stockroom,drawer,selling_area,delivery,ending_on_hand')
          .eq('company_id', companyId)
          .gte('period_end', since);
        if (storeScope) q = q.in('store_code', storeScope);
        return q.order('id').range(from, to);
      },
      undefined,
      {concurrency: 4},
    ) as unknown as Promise<Array<InventoryRowIn & {store_code: string; period_start: string; period_end: string}>>;
  const earlySince = addDays(today, -(HISTORY_DAYS + EARLY_LAG_DAYS));
  const earlyCounts = readCounts(earlySince);
  earlyCounts.catch(() => {}); // awaited below (re-throws there); never an unhandled rejection on early return

  const [snapsAll, storesRows, products, pending] = await Promise.all([
    fetchAllRows('gl_inventory_snapshots', (from, to) => {
      let q = supa
        .from('gl_inventory_snapshots') // pagination-ok: paged by fetchAllRows (.range below)
        .select('store_code,period_start,period_end,last_committed_at')
        .eq('company_id', companyId)
        .gte('period_end', sinceSnapshots);
      if (storeScope) q = q.in('store_code', storeScope);
      return q.order('period_end', {ascending: false}).order('store_code').range(from, to);
    }) as unknown as Promise<Array<{store_code: string; period_start: string; period_end: string; last_committed_at: string | null}>>,
    getGlStores(companyId),
    getGlCatalog(companyId),
    // pagination-ok: count-only head request, returns no rows.
    supa.from('gl_uploads').select('id', {count: 'exact', head: true}).eq('company_id', companyId).eq('status', 'needs_review'),
  ]);

  const snaps = scope ? snapsAll.filter((s) => scope.has(s.store_code)) : snapsAll;
  const catalog: OpsData['catalog'] = {};
  for (const p of products) {
    catalog[p.item_code] = {
      name: p.variant?.trim() || p.item_code,
      productLine: p.product_line,
      price: p.unit_price == null ? null : Number(p.unit_price),
      bestseller: Boolean(p.is_bestseller),
    };
  }
  const currentPeriod = pickCurrentPeriod(snaps);
  if (!currentPeriod) return {...empty, catalog, pendingReview: pending.count ?? 0};

  const since = addDays(currentPeriod.end, -HISTORY_DAYS);
  const rows = (since >= earlySince ? await earlyCounts : await readCounts(since)).filter((r) => r.period_end >= since);

  // store → period → rows
  const byStore = new Map<string, Map<string, Count>>();
  for (const r of rows) {
    if (scope && !scope.has(r.store_code)) continue;
    const k = `${r.period_start}|${r.period_end}`;
    const periods = byStore.get(r.store_code) ?? new Map<string, Count>();
    const c = periods.get(k) ?? {period_start: r.period_start, period_end: r.period_end, rows: []};
    c.rows.push(r);
    periods.set(k, c);
    byStore.set(r.store_code, periods);
  }

  // Each store's commit time for the count that is "this period" (within tolerance).
  const committedAt = new Map<string, string | null>();
  for (const s of snaps) if (isCurrentCount(s.period_end, currentPeriod) && !committedAt.has(s.store_code)) committedAt.set(s.store_code, s.last_committed_at);
  const nameOf = new Map(storesRows.map((s) => [s.store_code, s.name]));
  const activeStores = storesRows.filter((s) => s.status === 'active' && (!scope || scope.has(s.store_code))).map((s) => s.store_code);
  const codes = [...new Set([...activeStores, ...byStore.keys()])].sort((a, b) => a.localeCompare(b, undefined, {numeric: true}));

  const priceOf = (code: string) => catalog[code]?.price ?? null;
  const stores: StoreOps[] = codes.map((storeCode) => {
    const counts = [...(byStore.get(storeCode)?.values() ?? [])];
    const movement = storeMovement(counts);
    const countedCurrent = isCurrentCount(movement.latest?.period_end, currentPeriod);
    const form = countedCurrent ? formTimeliness(movement.latest?.period_end ?? currentPeriod.end, committedAt.get(storeCode) ?? null) : 'missing';
    return {
      storeCode,
      storeName: nameOf.get(storeCode) ?? null,
      movement,
      health: storeHealth(movement, priceOf, form),
      committedAt: committedAt.get(storeCode) ?? null,
      countedCurrent,
    };
  });

  return {currentPeriod, stores, catalog, pendingReview: pending.count ?? 0};
}
