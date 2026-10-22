// The Supabase side of ImportStore. Service role, server side only (RLS on, no policies; see supabase/shopee_import.sql).
// Reads the figures through the view `marketplace_daily_sales` (the newest ACCEPTED import per day); writes only to import_runs and
// marketplace_daily_observations, and never updates or deletes an observation.
import type {SupabaseClient} from '@supabase/supabase-js';
import {fetchAllRows} from '../pos-fetch-paginate';
import type {ImportStore, NewRun, PlanRecord, Run} from './pipeline';
import type {DayFigures, ReportType} from './types';

const CHUNK = 500;
const num = (v: unknown): number => Number(v ?? 0);
const orNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

type RunRow = {
  import_id: string; report_type: ReportType; period_from: string; period_to: string; source_filename: string; sha256: string;
  status: Run['status']; row_count: number; plan: PlanRecord | null; restated: boolean;
};
const toRun = (r: RunRow): Run => ({importId: r.import_id, reportType: r.report_type, periodFrom: r.period_from, periodTo: r.period_to, sourceFilename: r.source_filename, sha256: r.sha256, status: r.status, rowCount: r.row_count, plan: r.plan, restated: r.restated});
const RUN_COLS = 'import_id,report_type,period_from,period_to,source_filename,sha256,status,row_count,plan,restated';

function fail(what: string, error: {message: string} | null): void {
  if (error) throw new Error(`${what}: ${error.message}`);
}

export function supabaseImportStore(sb: SupabaseClient): ImportStore {
  return {
    async loadCurrent(from, to) {
      const data = await fetchAllRows('shopee loaded days', (a, b) => sb.from('marketplace_daily_sales').select('day,revenue,orders,units,sales_placed,orders_placed,units_placed,buyers_placed,buyers_confirmed,visitors')
        .eq('channel', 'shopee').gte('day', from).lte('day', to).order('day').range(a, b));
      return new Map(data.map((r): [string, DayFigures] => [String(r.day), {
        day: String(r.day), salesConfirmed: num(r.revenue), ordersConfirmed: num(r.orders), unitsConfirmed: num(r.units), salesPlaced: num(r.sales_placed), ordersPlaced: num(r.orders_placed),
        unitsPlaced: num(r.units_placed), buyersPlaced: orNull(r.buyers_placed), buyersConfirmed: orNull(r.buyers_confirmed), visitors: orNull(r.visitors),
      }]));
    },
    async loadLoadedDays() {
      const data = await fetchAllRows('shopee loaded days', (a, b) => sb.from('marketplace_daily_sales').select('day').eq('channel', 'shopee').order('day').range(a, b));
      return data.map((r) => String(r.day));
    },
    async findAcceptedBySha(reportType, sha256) {
      const {data, error} = await sb.from('import_runs').select(RUN_COLS).eq('report_type', reportType).eq('channel', 'shopee').eq('sha256', sha256).eq('status', 'accepted').limit(1);
      fail('looking for the file', error);
      return data?.[0] ? toRun(data[0] as RunRow) : null;
    },
    async supersedeStagedBySha(reportType, sha256) {
      const {error} = await sb.from('import_runs').update({status: 'superseded', note: 'planned again'}).eq('report_type', reportType).eq('channel', 'shopee').eq('sha256', sha256).eq('status', 'staged');
      fail('replacing the earlier plan', error);
    },
    async createRun(n: NewRun) {
      const {data, error} = await sb.from('import_runs').insert({
        report_type: n.reportType, channel: n.channel, period_from: n.periodFrom, period_to: n.periodTo, source_filename: n.sourceFilename, sha256: n.sha256, row_count: n.rowCount,
        status: n.status, checks: n.checks, plan: n.plan, note: n.note ?? null, restated: n.restated ?? false, imported_by: n.importedBy,
      }).select('import_id').single();
      fail('recording the import', error);
      return String(data?.import_id);
    },
    async addObservations(importId, rows) {
      const records = rows.map((d) => ({
        import_id: importId, day: d.day, channel: 'shopee', sales_placed: d.salesPlaced, sales_confirmed: d.salesConfirmed, orders_placed: d.ordersPlaced, orders_confirmed: d.ordersConfirmed,
        units_placed: d.unitsPlaced, units_confirmed: d.unitsConfirmed, buyers_placed: d.buyersPlaced, buyers_confirmed: d.buyersConfirmed, visitors: d.visitors,
      }));
      for (let i = 0; i < records.length; i += CHUNK) {
        const {error} = await sb.from('marketplace_daily_observations').insert(records.slice(i, i + CHUNK));
        fail('saving the figures', error);
      }
    },
    async getRun(importId) {
      const {data, error} = await sb.from('import_runs').select(RUN_COLS).eq('import_id', importId).limit(1);
      fail('reading the import', error);
      return data?.[0] ? toRun(data[0] as RunRow) : null;
    },
    async transition(importId, from, to, patch) {
      const change: Record<string, unknown> = {status: to};
      if (to === 'accepted') change.accepted_at = new Date().toISOString();
      if (patch?.note) change.note = patch.note;
      const {data, error} = await sb.from('import_runs').update(change).eq('import_id', importId).eq('status', from).select('import_id'); // pagination-ok: one primary key
      fail('changing the import', error);
      return (data ?? []).length === 1;
    },
    async listRuns(status) {
      const data = await fetchAllRows('import runs', (a, b) => sb.from('import_runs').select(RUN_COLS).eq('status', status).order('period_from').order('import_id').range(a, b));
      return data.map((r) => toRun(r as unknown as RunRow));
    },
  };
}
