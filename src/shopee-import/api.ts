// The HTTP face of the Shopee import: plain request handlers over the same pipeline as the command line (pipeline.ts). Route files in
// app/api/shopee/import/ are thin wrappers. Auth is one bearer token (SHOPEE_IMPORT_TOKEN); with no token configured every call is refused.
// Nothing here reads or echoes file contents, and every plan, apply and undo goes through the same ledger as the command.
import {createHash, timingSafeEqual} from 'node:crypto';
import {reportsByWeek, weeksCoverage} from './coverage';
import {classifyFile} from './files';
import {applyRun, planFile, undoRun, type ImportStore} from './pipeline';
import type {ReportType} from './types';
import {MAX_FILES_PER_WINDOW, type SyncWindow} from '../shopee-sync/windows';

export interface ApiDeps {
  store: ImportStore;
  token: string | undefined;
  now: () => Date;
  /** The grant of the Shopee sync worker (it holds the shared worker secret), or null. Such a worker may plan and apply (never restate, undo or coverage) only files whose
   * period equals a window issued for the job it is running right now, of a type that window carries. */
  workerAuth?: (bearer: string) => Promise<WorkerGrantLike | null>;
  /** Called after a worker's apply wrote something: lets the sync mark the job days that now exist as loaded. Never fails the response. */
  afterWorkerApply?: (jobId: string) => Promise<void>;
}

/** What a worker secret is good for (src/shopee-sync/worker-auth.ts WorkerGrant). */
export interface WorkerGrantLike {
  windows: readonly SyncWindow[];
  jobId: string | null;
  /** The job's only day when it has exactly one (a Refresh press); null otherwise. */
  singleDay: string | null;
}
export const MAX_FILES = 30;
export const MAX_FILE_BYTES = 5 * 1024 * 1024;

const sha = (s: string): Buffer => createHash('sha256').update(s).digest();
export function authorize(req: Request, token: string | undefined): 'ok' | 'denied' | 'not_configured' {
  if (!token) return 'not_configured';
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.get('authorization') ?? '');
  return m && timingSafeEqual(sha(m[1].trim()), sha(token)) ? 'ok' : 'denied';
}

const reply = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json', 'cache-control': 'no-store'}});
/** `workerOk`: the route accepts a worker token (plan, apply). Every other route answers a worker token with 403. */
async function gate(req: Request, d: ApiDeps, workerOk = false): Promise<{denied: Response | null; worker: boolean; grant: WorkerGrantLike}> {
  const none: WorkerGrantLike = {windows: [], jobId: null, singleDay: null};
  const a = authorize(req, d.token);
  if (a === 'ok') return {denied: null, worker: false, grant: none};
  const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.get('authorization') ?? '')?.[1].trim();
  const grant = bearer && d.workerAuth ? await d.workerAuth(bearer) : null;
  if (grant) return workerOk ? {denied: null, worker: true, grant} : {denied: reply({error: 'A worker token cannot do that.'}, 403), worker: true, grant: none};
  if (a === 'not_configured' && !(bearer && d.workerAuth)) return {denied: reply({error: 'The import API is not configured on this deployment.'}, 503), worker: false, grant: none};
  return {denied: reply({error: 'Unauthorized.'}, 401), worker: false, grant: none};
}
/**
 * A worker may touch a file only when its filename period EQUALS a window the server issued for its job and, when `type` is given, the report type
 * is one that window carries (past7: the 3 daily files; week: all 5). A missing period, an unissued window or an unknown type (null) is refused.
 */
export function periodIsWindow(from: string | null | undefined, to: string | null | undefined, windows: readonly SyncWindow[], type?: ReportType | null): boolean {
  if (!from || !to || type === null) return false;
  return windows.some((w) => w.from === from && w.to === to && (type === undefined || w.files.includes(type)));
}
/** How a run planned by a sync worker is marked, so only that job may apply it. */
export const syncStamp = (jobId: string): string => `sync:${jobId}`;
const outsideJob = (): Response => reply({error: 'A worker token can only load the windows (and file types) issued for the sync job it is running now.'}, 403);
const workerRefused = (what: string): Response => reply({error: `A worker token cannot do ${what}.`}, 403);
const phToday = (now: Date): string => new Date(now.getTime() + 8 * 3_600_000).toISOString().slice(0, 10);
const body = async (req: Request): Promise<Record<string, unknown> | null> => {
  try {
    const v = await req.json();
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

export async function handlePlan(req: Request, d: ApiDeps): Promise<Response> {
  const {denied, worker, grant} = await gate(req, d, true);
  if (denied) return denied;
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return reply({error: 'Send the files as multipart form data, field "files".'}, 400);
  }
  const files = form.getAll('files').filter((f): f is File => typeof f !== 'string');
  if (files.length === 0) return reply({error: 'No files. Send them in the form field "files".'}, 400);
  if (files.length > MAX_FILES) return reply({error: `At most ${MAX_FILES} files per request.`}, 413);
  if (files.some((f) => f.size > MAX_FILE_BYTES)) return reply({error: `A file is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB.`}, 413);
  const only = form.get('only_new');
  const restate = form.get('restate');
  if (worker && restate !== null) return workerRefused('a restate');
  if (worker) {
    const cls = files.map((f) => classifyFile(f.name));
    if (files.length > MAX_FILES_PER_WINDOW || new Set(cls.map((c) => c.type)).size !== files.length) return workerRefused(`more than ${MAX_FILES_PER_WINDOW} files, or two files of one type, in one request`);
    if (cls.some((c) => !periodIsWindow(c.period?.from, c.period?.to, grant.windows, c.type))) return outsideJob();
  }
  // A worker's sales plan only adds days that are missing (no review noise for overlapping loaded days), except a Refresh press (one day, already loaded) so a changed day can update.
  const refresh = worker && grant.singleDay !== null && (await d.store.loadLoadedDays()).includes(grant.singleDay);
  const onlyNew = worker ? !refresh : only === 'true' || only === '1';
  const ordered = [...files].sort((a, b) => (classifyFile(a.name).period?.from ?? '').localeCompare(classifyFile(b.name).period?.from ?? ''));
  const results = [];
  for (const f of ordered) {
    const o = await planFile({store: d.store, bytes: new Uint8Array(await f.arrayBuffer()), filename: f.name.split(/[\\/]/).pop() ?? f.name, today: phToday(d.now()), importedBy: worker && grant.jobId ? syncStamp(grant.jobId) : 'api', onlyNew, restate: typeof restate === 'string' && restate.trim() ? restate.trim() : null});
    if (o.status === 'staged') {
      results.push({status: o.status, filename: o.filename, importId: o.importId, periodFrom: o.periodFrom, periodTo: o.periodTo, newDays: o.plan.newDays.length, unchanged: o.plan.unchanged.length, changed: o.plan.changed, keptCurrent: o.plan.keptCurrent.length, frozenBlocked: o.plan.frozenBlocked, flags: o.plan.flags, openSkipped: o.openSkipped});
    } else if (o.status === 'staged_report') {
      results.push({status: o.status, filename: o.filename, importId: o.importId, reportType: o.reportType, periodFrom: o.periodFrom, periodTo: o.periodTo, rows: o.rows, summary: o.summary, coveragePct: o.coveragePct, openSkipped: o.openSkipped, rawStored: o.rawStored});
    } else if (o.status === 'rejected') results.push({status: o.status, filename: o.filename, importId: o.importId, failures: o.failures});
    else if (o.status === 'nothing_to_do') results.push({status: o.status, filename: o.filename, openSkipped: o.openSkipped});
    else if (o.status === 'already_loaded') results.push({status: o.status, filename: o.filename, importId: o.importId});
    else results.push(o);
  }
  return reply({results});
}

export async function handleApply(req: Request, d: ApiDeps): Promise<Response> {
  const {denied, worker, grant} = await gate(req, d, true);
  if (denied) return denied;
  const b = await body(req);
  const ids = b && Array.isArray(b.importIds) ? b.importIds.filter((x): x is string => typeof x === 'string') : null;
  if (!ids || ids.length === 0 || ids.length > MAX_FILES) return reply({error: `Send {"importIds": [...]} with 1 to ${MAX_FILES} ids from a plan.`}, 400);
  if (worker) {
    if (ids.length > MAX_FILES_PER_WINDOW) return workerRefused(`an apply of more than ${MAX_FILES_PER_WINDOW} runs`);
    for (const id of ids) {
      const run = await d.store.getRun(id);
      if (run?.restated) return workerRefused('a restate');
      if (run && !periodIsWindow(run.periodFrom, run.periodTo, grant.windows, run.reportType)) return outsideJob();
      if (!run || !grant.jobId || run.importedBy !== syncStamp(grant.jobId)) return reply({error: 'A worker token can only apply runs its own sync job planned.'}, 403);
      if (run.plan && run.plan.flags.length > 0) return reply({error: 'This plan has flags, so a person has to review it in the dashboard.'}, 403);
    }
  }
  const results = [];
  for (const id of ids) {
    const r = await applyRun(d.store, id);
    results.push(r.ok ? {importId: id, ok: true, receipt: r.receipt} : {importId: id, ok: false, code: r.code, message: r.message});
  }
  if (worker && grant.jobId && results.some((r) => r.ok)) {
    try {
      await d.afterWorkerApply?.(grant.jobId);
    } catch {
      // progress marks are a convenience for the card; the apply itself is done
    }
  }
  return reply({results});
}

export async function handleUndo(req: Request, d: ApiDeps): Promise<Response> {
  const {denied} = await gate(req, d);
  if (denied) return denied;
  const b = await body(req);
  const id = typeof b?.importId === 'string' ? b.importId : '';
  const reason = typeof b?.reason === 'string' ? b.reason : '';
  if (!id || !reason.trim()) return reply({error: 'Send {"importId": "...", "reason": "..."}: an undo needs a written reason.'}, 400);
  const r = await undoRun(d.store, id, reason);
  return reply(r, r.ok ? 200 : 409);
}

export async function handleCoverage(req: Request, d: ApiDeps): Promise<Response> {
  const {denied} = await gate(req, d);
  if (denied) return denied;
  const yesterday = new Date(Date.parse(`${phToday(d.now())}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  const weeks = weeksCoverage(await d.store.loadLoadedDays(), yesterday);
  const reports = reportsByWeek(await d.store.loadReportPeriods(), weeks.map((w) => w.weekStart));
  return reply({through: yesterday, weeks: weeks.map((w) => ({...w, reports: reports[w.weekStart]}))});
}
