// An in-memory ImportStore with the same reading rule as the SQL view: per day, the newest ACCEPTED import wins.
import type {ImportStore, NewRun, ReportPeriod, Run} from '../../src/shopee-import/pipeline';
import type {DayFigures} from '../../src/shopee-import/types';

export class FakeStore implements ImportStore {
  runs: (Run & {acceptedSeq: number; note?: string | null})[] = [];
  obs = new Map<string, DayFigures[]>();
  snapshotRows = new Map<string, {table: string; records: Record<string, unknown>[]}>();
  raw = new Map<string, {path: string; bytes: Uint8Array}>();
  rawWorks = true;
  /** Make addSnapshotRows throw, as a database failing part way through a large file would. */
  failSnapshotRows = false;
  private seq = 0;

  async loadCurrent(from: string, to: string): Promise<Map<string, DayFigures>> {
    const out = new Map<string, DayFigures>();
    const accepted = this.runs.filter((r) => r.status === 'accepted').sort((a, b) => a.acceptedSeq - b.acceptedSeq);
    for (const r of accepted) for (const d of this.obs.get(r.importId) ?? []) if (d.day >= from && d.day <= to) out.set(d.day, d);
    return out;
  }
  async loadLoadedDays(): Promise<string[]> {
    return [...(await this.loadCurrent('0000-01-01', '9999-12-31')).keys()].sort();
  }
  async findAcceptedBySha(reportType: string, sha: string): Promise<Run | null> {
    return this.runs.find((r) => r.status === 'accepted' && r.reportType === reportType && r.sha256 === sha) ?? null;
  }
  async supersedeStagedBySha(reportType: string, sha: string): Promise<void> {
    for (const r of this.runs) if (r.status === 'staged' && r.reportType === reportType && r.sha256 === sha) r.status = 'superseded';
  }
  async createRun(n: NewRun): Promise<string> {
    const importId = `run-${this.runs.length + 1}`;
    this.runs.push({importId, reportType: n.reportType, periodFrom: n.periodFrom, periodTo: n.periodTo, sourceFilename: n.sourceFilename, sha256: n.sha256, status: n.status, rowCount: n.rowCount, plan: n.plan, restated: Boolean(n.restated), checks: n.checks, importedBy: n.importedBy ?? null, acceptedSeq: 0});
    return importId;
  }
  async addObservations(importId: string, rows: readonly DayFigures[]): Promise<void> {
    this.obs.set(importId, [...rows]);
  }
  async addSnapshotRows(table: string, importId: string, records: readonly Record<string, unknown>[]): Promise<void> {
    if (this.failSnapshotRows) throw new Error('saving the figures: connection lost');
    this.snapshotRows.set(importId, {table, records: [...records]});
  }
  async saveRaw(importId: string, path: string, bytes: Uint8Array): Promise<boolean> {
    if (!this.rawWorks) return false;
    this.raw.set(importId, {path, bytes});
    return true;
  }
  async loadReportPeriods(): Promise<ReportPeriod[]> {
    return this.runs.filter((r) => r.status === 'accepted' && r.reportType !== 'sales_overview').map((r) => ({reportType: r.reportType as ReportPeriod['reportType'], periodFrom: r.periodFrom, periodTo: r.periodTo}));
  }
  async getRun(importId: string): Promise<Run | null> {
    return this.runs.find((r) => r.importId === importId) ?? null;
  }
  async transition(importId: string, from: Run['status'], to: Run['status'], patch?: {note?: string}): Promise<boolean> {
    const r = this.runs.find((x) => x.importId === importId);
    if (!r || r.status !== from) return false;
    r.status = to;
    if (to === 'accepted') r.acceptedSeq = ++this.seq;
    if (patch?.note) r.note = patch.note;
    return true;
  }
  async listRuns(status: Run['status']): Promise<Run[]> {
    return this.runs.filter((r) => r.status === status);
  }
}
