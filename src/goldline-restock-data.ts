import 'server-only';
import {nichidoConfigured, nichidoDb} from './nichido-client';
import {fetchAllRows} from './pos-fetch-paginate';
import {getGlCatalog, getGlStores, getGlSupplyRef} from './goldline-ref-data';
import {itemDisplayName} from './goldline-item-name';
import {HOLD_REASONS, type HoldReason} from './goldline-forecast';
import {lineState, overallScore, runCycle, storeScores, type Decision, type RunLineState, type RunSkipped, type StoreScore} from './goldline-restock';

// Server-only reads behind the Restock page's Run tab (F11): the saved run for a half
// month, its lines and the owner's score per store. Company-fenced on every query and
// narrowed to a store-scoped role's stores. Lines are read fresh (decisions change them);
// names come from the cached catalog and store list.

const db = nichidoDb;

export type RunHeader = {
  id: string;
  cycle: string;
  runDate: string;
  months: string[];
  lastYear: string[];
  windowMonths: number;
  safetyMonths: number;
  skipped: RunSkipped;
  createdBy: string | null;
  createdAt: string;
  updatedBy: string | null;
  updatedAt: string;
};

export type RunLine = {
  id: string;
  storeCode: string;
  storeName: string | null;
  itemCode: string;
  name: string;
  lyUnits: Array<number | null>;
  need: number | null;
  safety: number | null;
  onHand: number | null;
  onHandPeriodEnd: string | null;
  onTheWay: number;
  rawSend: number | null;
  suggested: number | null;
  warehouseShort: boolean;
  holds: HoldReason[];
  state: RunLineState;
  decision: Decision;
  finalQty: number | null;
  remark: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
};

export type RunStoreRow = StoreScore & {name: string | null; lines: number; send: number; covered: number; held: number; sendUnits: number};

export type RestockRunData = {
  configured: boolean;
  cycle: string; // the half month for the page's run date
  run: RunHeader | null;
  stores: RunStoreRow[];
  score: number | null; // approved as is ÷ decided, every store in view
  toDecide: number;
  store: string | null; // the store picked, if any
  lines: RunLine[]; // the picked store's lines, or every store's lines with something to send
  warehouseSample: boolean; // warehouse figures are still sample data
};

type LineRow = {
  id: string;
  store_code: string;
  item_code: string;
  ly_units: Array<number | null>;
  need: number | null;
  safety: number | null;
  on_hand: number | null;
  on_hand_period_end: string | null;
  on_the_way: number;
  raw_send: number | null;
  suggested: number | null;
  warehouse_short: boolean;
  holds: string[];
  decision: Decision;
  final_qty: number | null;
  remark: string | null;
  decided_by: string | null;
  decided_at: string | null;
};

const LINE_COLS =
  'id,store_code,item_code,ly_units,need,safety,on_hand,on_hand_period_end,on_the_way,raw_send,suggested,warehouse_short,holds,decision,final_qty,remark,decided_by,decided_at';
const asHolds = (xs: string[] | null) => HOLD_REASONS.filter((r) => (xs ?? []).includes(r));
const EMPTY_SKIPPED: RunSkipped = {no_count: {stores: 0, lines: 0}, out_of_scope: {stores: 0, lines: 0}};

export async function getRestockRun(companyId: string, runDate: string, store: string | null, storeScope?: string[] | null): Promise<RestockRunData> {
  const cycle = runCycle(runDate);
  const empty: RestockRunData = {configured: nichidoConfigured(), cycle, run: null, stores: [], score: null, toDecide: 0, store: null, lines: [], warehouseSample: false};
  if (!nichidoConfigured()) return empty;

  const supa = db();
  const scope = storeScope ?? null;
  // pagination-ok: one row by (company_id, cycle), unique.
  const {data: runRow, error} = await supa
    .from('restock_runs')
    .select('id,cycle,run_date,months,last_year,window_months,safety_months,skipped,created_by,created_at,updated_by,updated_at')
    .eq('company_id', companyId)
    .eq('cycle', cycle)
    .maybeSingle();
  if (error) throw new Error(`restock_runs read failed: ${error.message}`);
  const supply = await getGlSupplyRef(companyId);
  const warehouseSample = supply.warehouse.some((w) => w.is_sample);
  if (!runRow) return {...empty, warehouseSample};

  const picked = store && (!scope || scope.includes(store)) ? store : null;
  const [rows, catalog, storeRows] = await Promise.all([
    fetchAllRows('recommendations', (from, to) => {
      let q = supa.from('recommendations').select(LINE_COLS).eq('company_id', companyId).eq('run_id', runRow.id); // pagination-ok: paged by fetchAllRows (.range below)
      if (scope) q = q.in('store_code', scope);
      return q.order('store_code').order('item_code').range(from, to);
    }) as unknown as Promise<LineRow[]>,
    getGlCatalog(companyId),
    getGlStores(companyId),
  ]);

  const storeName = new Map(storeRows.map((s) => [s.store_code, s.name]));
  const itemName = new Map(catalog.map((p) => [p.item_code, itemDisplayName(p.product_line, p.variant, p.item_code)]));
  const lines: RunLine[] = rows.map((r) => {
    const holds = asHolds(r.holds);
    return {
      id: r.id,
      storeCode: r.store_code,
      storeName: storeName.get(r.store_code) ?? null,
      itemCode: r.item_code,
      name: itemName.get(r.item_code) ?? r.item_code,
      lyUnits: r.ly_units ?? [],
      need: r.need,
      safety: r.safety,
      onHand: r.on_hand,
      onHandPeriodEnd: r.on_hand_period_end,
      onTheWay: r.on_the_way ?? 0,
      rawSend: r.raw_send,
      suggested: r.suggested,
      warehouseShort: r.warehouse_short,
      holds,
      state: lineState({suggested: r.suggested, holds}),
      decision: r.decision,
      finalQty: r.final_qty,
      remark: r.remark,
      decidedBy: r.decided_by,
      decidedAt: r.decided_at,
    };
  });

  const scores = storeScores(lines.map((l) => ({storeCode: l.storeCode, decision: l.decision, suggested: l.suggested, holds: l.holds})));
  const scoreBy = new Map(scores.map((s) => [s.storeCode, s]));
  const by = new Map<string, RunStoreRow>();
  for (const l of lines) {
    const s = scoreBy.get(l.storeCode);
    const r =
      by.get(l.storeCode) ??
      ({
        storeCode: l.storeCode,
        name: l.storeName,
        decided: s?.decided ?? 0,
        approved: s?.approved ?? 0,
        edited: s?.edited ?? 0,
        rejected: s?.rejected ?? 0,
        pending: s?.pending ?? 0,
        score: s?.score ?? null,
        lines: 0,
        send: 0,
        covered: 0,
        held: 0,
        sendUnits: 0,
      } satisfies RunStoreRow);
    r.lines++;
    r[l.state]++;
    if (l.state === 'send') r.sendUnits += l.decision === 'pending' ? l.suggested ?? 0 : l.finalQty ?? 0;
    by.set(l.storeCode, r);
  }

  const run: RunHeader = {
    id: runRow.id,
    cycle: runRow.cycle,
    runDate: runRow.run_date,
    months: runRow.months ?? [],
    lastYear: runRow.last_year ?? [],
    windowMonths: runRow.window_months,
    safetyMonths: runRow.safety_months,
    skipped: {...EMPTY_SKIPPED, ...((runRow.skipped as Partial<RunSkipped>) ?? {})},
    createdBy: runRow.created_by,
    createdAt: runRow.created_at,
    updatedBy: runRow.updated_by,
    updatedAt: runRow.updated_at,
  };

  return {
    configured: true,
    cycle,
    run,
    stores: [...by.values()].sort((a, b) => a.storeCode.localeCompare(b.storeCode, undefined, {numeric: true})),
    score: overallScore(scores),
    toDecide: lines.filter((l) => l.state === 'send' && l.decision === 'pending').length,
    store: picked,
    lines: picked ? lines.filter((l) => l.storeCode === picked) : lines.filter((l) => l.state === 'send'),
    warehouseSample,
  };
}
