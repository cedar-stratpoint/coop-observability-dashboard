// The import pipeline: plan (parse, gate, compare, stage), apply (accept one staged run), undo. Everything that touches the database goes
// through ImportStore, so the rules here are tested without one. One code path for the command line and the API.
// A staged run and its observations are inert: the app reads only ACCEPTED runs (see supabase/shopee_import.sql). apply = one status flip.
import {createHash} from 'node:crypto';
import {classifyFile} from './files';
import {runGates} from './gates';
import {buildPlan, FREEZE_DAYS, type Plan} from './plan';
import {parseSalesOverview} from './sales-overview';
import type {DayFigures, GateFailure, ReportType} from './types';

export interface NewRun {
  reportType: ReportType;
  channel: 'shopee';
  periodFrom: string;
  periodTo: string;
  sourceFilename: string;
  sha256: string;
  rowCount: number;
  status: 'staged' | 'rejected';
  checks: Record<string, unknown>;
  plan: PlanRecord | null;
  note?: string | null;
  restated?: boolean;
  importedBy: string | null;
}
export interface Run {
  importId: string;
  reportType: ReportType;
  periodFrom: string;
  periodTo: string;
  sourceFilename: string;
  sha256: string;
  status: 'staged' | 'accepted' | 'rejected' | 'superseded';
  rowCount: number;
  plan: PlanRecord | null;
  restated: boolean;
}
export interface PlanRecord {
  newDays: string[];
  unchanged: string[];
  changed: Plan['changed'];
  keptCurrent: string[];
  frozenBlocked: string[];
  flags: Plan['flags'];
  openSkipped: string[];
  /** The figures the plan was made against, per day of the span; apply refuses if any moved. */
  basis: [string, string | null][];
  /** Sum of confirmed sales over the loaded span, and the file's own total (null when days were left out). */
  loadedConfirmed: number;
  fileConfirmedTotal: number | null;
}

export interface ImportStore {
  loadCurrent(from: string, to: string): Promise<Map<string, DayFigures>>;
  loadLoadedDays(): Promise<string[]>;
  findAcceptedBySha(reportType: ReportType, sha256: string): Promise<Run | null>;
  supersedeStagedBySha(reportType: ReportType, sha256: string): Promise<void>;
  createRun(run: NewRun): Promise<string>;
  addObservations(importId: string, rows: readonly DayFigures[]): Promise<void>;
  getRun(importId: string): Promise<Run | null>;
  /** Flip a run's status only if it is currently `from`. Returns whether it flipped. */
  transition(importId: string, from: Run['status'], to: Run['status'], patch?: {note?: string}): Promise<boolean>;
  listRuns(status: Run['status']): Promise<Run[]>;
}

export const sha256Of = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const figKey = (d: DayFigures | undefined): string | null =>
  d ? [d.salesPlaced, d.salesConfirmed, d.ordersPlaced, d.ordersConfirmed, d.unitsPlaced, d.unitsConfirmed, d.buyersPlaced, d.buyersConfirmed, d.visitors].join('|') : null;
const basisOf = (days: readonly string[], current: ReadonlyMap<string, DayFigures>): [string, string | null][] => days.map((d) => [d, figKey(current.get(d))]);

export type PlanOutcome =
  | {status: 'unsupported'; filename: string; message: string}
  | {status: 'already_loaded'; filename: string; importId: string}
  | {status: 'rejected'; filename: string; importId: string; failures: GateFailure[]}
  | {status: 'nothing_to_do'; filename: string; plan: Plan; openSkipped: string[]}
  | {status: 'staged'; filename: string; importId: string; plan: Plan; openSkipped: string[]; periodFrom: string; periodTo: string};

export interface PlanInput {
  store: ImportStore;
  bytes: Uint8Array;
  filename: string;
  today: string;
  importedBy?: string | null;
  onlyNew?: boolean;
  restate?: string | null; // the written reason; presence turns restating on
  freezeDays?: number;
}

export async function planFile(i: PlanInput): Promise<PlanOutcome> {
  const cls = classifyFile(i.filename);
  if (cls.type !== 'sales_overview') {
    return {status: 'unsupported', filename: i.filename, message: cls.type ? `${cls.type} files are not imported yet.` : 'This file name is not a known Shopee export.'};
  }
  const sha = sha256Of(i.bytes);
  const already = await i.store.findAcceptedBySha('sales_overview', sha);
  if (already) return {status: 'already_loaded', filename: i.filename, importId: already.importId};

  const record = (failures: GateFailure[], parsed?: {from: string; to: string; rows: number}): Promise<string> =>
    i.store.createRun({
      reportType: 'sales_overview', channel: 'shopee', periodFrom: parsed?.from ?? cls.period?.from ?? '1970-01-01', periodTo: parsed?.to ?? cls.period?.to ?? '1970-01-01',
      sourceFilename: i.filename, sha256: sha, rowCount: parsed?.rows ?? 0, status: 'rejected', checks: {failures}, plan: null, importedBy: i.importedBy ?? null,
    });

  let parsed;
  try {
    parsed = await parseSalesOverview(i.bytes);
  } catch (e) {
    const failures = [{code: 'PARSE', message: e instanceof Error ? e.message : String(e)}];
    return {status: 'rejected', filename: i.filename, importId: await record(failures), failures};
  }
  const gates = runGates(parsed, {today: i.today, filenamePeriod: cls.period});
  if (gates.failures.length) {
    return {status: 'rejected', filename: i.filename, importId: await record(gates.failures, {from: parsed.periodFrom, to: parsed.periodTo, rows: parsed.days.length}), failures: gates.failures};
  }

  const from = gates.days[0].day;
  const to = gates.days[gates.days.length - 1].day;
  const current = await i.store.loadCurrent(from, to);
  const plan = buildPlan(gates.days, current, {today: i.today, freezeDays: i.freezeDays ?? FREEZE_DAYS, restate: Boolean(i.restate), onlyNew: Boolean(i.onlyNew)});
  if (!plan.hasEffect) return {status: 'nothing_to_do', filename: i.filename, plan, openSkipped: gates.openSkipped};

  await i.store.supersedeStagedBySha('sales_overview', sha);
  const trimmed = gates.openSkipped.length > 0;
  const record_: PlanRecord = {
    newDays: plan.newDays, unchanged: plan.unchanged, changed: plan.changed, keptCurrent: plan.keptCurrent, frozenBlocked: plan.frozenBlocked, flags: plan.flags, openSkipped: gates.openSkipped,
    basis: basisOf(plan.rows.map((r) => r.day), current),
    loadedConfirmed: Math.round(plan.rows.reduce((s, r) => s + r.salesConfirmed, 0) * 100) / 100,
    fileConfirmedTotal: trimmed || plan.frozenBlocked.length || plan.keptCurrent.length ? null : parsed.summary.salesConfirmed,
  };
  const importId = await i.store.createRun({
    reportType: 'sales_overview', channel: 'shopee', periodFrom: from, periodTo: to, sourceFilename: i.filename, sha256: sha, rowCount: plan.rows.length, status: 'staged',
    checks: {passed: true, filePeriod: [parsed.periodFrom, parsed.periodTo], fileSummary: parsed.summary}, plan: record_, note: i.restate ?? null, restated: Boolean(i.restate), importedBy: i.importedBy ?? null,
  });
  await i.store.addObservations(importId, plan.rows);
  return {status: 'staged', filename: i.filename, importId, plan, openSkipped: gates.openSkipped, periodFrom: from, periodTo: to};
}

export interface Receipt {
  importId: string;
  periodFrom: string;
  periodTo: string;
  newDays: number;
  changedDays: number;
  loadedConfirmed: number;
  /** After the flip, the figures the app reads over the span add up to what the plan said (a newer overlapping import can make this false). */
  reconciled: boolean;
  matchesFileTotal: boolean | null;
}
export type ApplyOutcome = {ok: true; receipt: Receipt} | {ok: false; code: 'NOT_FOUND' | 'NOT_STAGED' | 'STALE_PLAN' | 'LOST_RACE'; message: string};

export async function applyRun(store: ImportStore, importId: string): Promise<ApplyOutcome> {
  const run = await store.getRun(importId);
  if (!run) return {ok: false, code: 'NOT_FOUND', message: `No import ${importId}.`};
  if (run.status !== 'staged' || !run.plan) return {ok: false, code: 'NOT_STAGED', message: `Import ${importId} is ${run.status}, not staged.`};
  const current = await store.loadCurrent(run.periodFrom, run.periodTo);
  const moved = run.plan.basis.filter(([day, key]) => figKey(current.get(day)) !== key).map(([day]) => day);
  if (moved.length) return {ok: false, code: 'STALE_PLAN', message: `The loaded figures for ${moved.slice(0, 5).join(', ')}${moved.length > 5 ? ' and more' : ''} changed since this plan was made. Plan the file again.`};
  if (!(await store.transition(importId, 'staged', 'accepted'))) return {ok: false, code: 'LOST_RACE', message: 'Another process changed this import first.'};
  const after = await store.loadCurrent(run.periodFrom, run.periodTo);
  const total = Math.round([...after.values()].reduce((s, d) => s + d.salesConfirmed, 0) * 100) / 100;
  return {
    ok: true,
    receipt: {
      importId, periodFrom: run.periodFrom, periodTo: run.periodTo, newDays: run.plan.newDays.length, changedDays: run.plan.changed.length, loadedConfirmed: total,
      reconciled: Math.abs(total - run.plan.loadedConfirmed) < 0.01,
      matchesFileTotal: run.plan.fileConfirmedTotal === null ? null : Math.abs(total - run.plan.fileConfirmedTotal) < 0.5,
    },
  };
}

export async function undoRun(store: ImportStore, importId: string, reason: string): Promise<{ok: boolean; message: string}> {
  if (!reason.trim()) return {ok: false, message: 'An undo needs a written reason.'};
  const flipped = await store.transition(importId, 'accepted', 'superseded', {note: reason.trim()});
  return flipped ? {ok: true, message: `Import ${importId} is undone; the previous figures are back.`} : {ok: false, message: `Import ${importId} is not an accepted import.`};
}
