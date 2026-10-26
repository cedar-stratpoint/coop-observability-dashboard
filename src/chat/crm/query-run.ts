// Runs one validated `crm_query`: a single read for a normal question, or, when the owner asked for everything (deliver "all"), a walk
// through the CRM's cursor in code (plan 2026-10-23, 4.5). The model never reads every row: it gets a sample, the count and the CRM's own
// totals; the owner gets the full table, drawn by the app. The walk is bounded (time budget, row ceiling, request limit, the CRM's own
// paging limit), never overshoots a ceiling (so a continuation cursor leaves no gap and no repeat), and says why it stopped. Pure apart from
// the injected `get` and clock.
import type {MetricResult} from '../result-types';
import {CrmError} from './client';
import {QUERY_LIMITS as L} from './query-config';
import {noteCatalogVersion, type Catalog} from './query-catalog';
import {buildResult, buildTable, modelCap, parsePage, type Delivery, type Page} from './query-shape';
import type {QueryRequest, WireSpec} from './query-spec';
import type {CrmGet} from './tools';

type Query = Extract<QueryRequest, {kind: 'query'}>;
export interface RunDeps {
  get: CrmGet;
  cat: Catalog;
  now: Date;
  /** Milliseconds clock for the time budget (tests pass a fake). */
  clock?: () => number;
}
export interface RunOutcome {
  result: MetricResult;
  /** The owner's full table (deliver "all" only, and only when there are rows). */
  table: ReturnType<typeof buildTable> | null;
  /** Rows the owner received (the audit line counts these). */
  rowsOut: number;
  stopped: Delivery['stopped'];
}

async function read(deps: RunDeps, spec: WireSpec, paged: boolean): Promise<Page> {
  const r = await deps.get('query', {spec: JSON.stringify(spec)}, paged ? {paged: true} : undefined);
  const page = parsePage(r.body);
  if (!page) throw new CrmError('bad_shape');
  noteCatalogVersion(page.version);
  return page;
}

/** How many rows match, from an aggregate count over the same filters (never by summing the table). null when it cannot be asked. */
async function countMatching(deps: RunDeps, spec: WireSpec): Promise<number | null> {
  try {
    const page = await read(deps, {table: spec.table, select: [{agg: 'count', as: 'n'}], filters: spec.filters, group_by: [], order_by: [], ...(spec.joins ? {joins: spec.joins} : {}), ...(spec.tz ? {tz: spec.tz} : {})}, false);
    const n = page.rows[0]?.n;
    return typeof n === 'number' ? n : null;
  } catch {
    return null;
  }
}

export async function runQuery(req: Query, deps: RunDeps): Promise<RunOutcome> {
  const {spec, identity, aggregate} = req;
  const cat = deps.cat;
  if (req.deliver !== 'all') {
    const page = await read(deps, spec, false);
    const d: Delivery = {modelRows: modelCap({identity, aggregate, all: false}, cat), delivered: null, total: null, stopped: null, nextCursor: page.nextCursor, identity, catalogVersion: page.version};
    return {result: buildResult(page, spec, cat, deps.now, d, aggregate), table: null, rowsOut: Math.min(page.rows.length, d.modelRows), stopped: null};
  }

  const clock = deps.clock ?? Date.now;
  const t0 = clock();
  const size = Math.min(L.pageRows, identity ? cat.identity?.cap ?? L.modelIdentity : cat.pagedCap);
  const rows: Page['rows'] = [];
  const notes = new Set<string>();
  let first: Page | null = null;
  let partial = false;
  let cursor: string | null = spec.cursor ?? null;
  let stopped: Delivery['stopped'] = null;
  const seen = new Set<string>(cursor ? [cursor] : []);
  for (;;) {
    const want = Math.min(size, L.csvRows - rows.length);
    let page: Page;
    try {
      page = await read(deps, {...spec, limit: want, cursor: cursor ?? 'start'}, true); // "start" opens the CRM's keyset paging: pages of 500, no 64 KB cap
    } catch (e) {
      if (first === null || !(e instanceof CrmError)) throw e;
      stopped = 'pages'; // a later page failed or the request limit was reached: keep what was read, and say so
      break;
    }
    first ??= page;
    rows.push(...page.rows);
    for (const n of page.notes) notes.add(n);
    partial ||= page.partial;
    cursor = page.nextCursor;
    if (!cursor) {
      if (page.truncated) stopped = 'cap'; // the CRM ended the walk without a cursor (it has no paging ceiling of its own; this is not expected)
      break;
    }
    if (rows.length >= L.csvRows) stopped = 'ceiling';
    else if (clock() - t0 >= L.budgetMs) stopped = 'budget';
    else if (seen.has(cursor)) stopped = 'pages'; // a cursor that does not move would loop forever
    if (stopped) break;
    seen.add(cursor);
  }
  const head = first as Page;
  const total = stopped === null && !spec.cursor ? rows.length : identity ? null : await countMatching(deps, spec);
  const merged: Page = {...head, rows, notes: [...notes], partial, nextCursor: cursor, truncated: stopped !== null};
  const d: Delivery = {modelRows: modelCap({identity, aggregate: false, all: true}, cat), delivered: rows.length, total, stopped, nextCursor: cursor, identity, catalogVersion: head.version};
  return {result: buildResult(merged, spec, cat, deps.now, d, false), table: rows.length ? buildTable(merged, rows, spec, d) : null, rowsOut: rows.length, stopped};
}
