// F5 + F7 + F8 + F10: executors for describe_data, query_metric, get_digest, lookup_product, the three render tools and the three report-edit tools, and the progress line for the stream.
// Pure; data loads lazily. query_metric keeps the FULL result in a per-request store that the render tools bind from.
import {draftLeads} from './contacts/draft';
import {matchPeople} from './contacts/match';
import {findPeople, overlapPeople, type PeopleSource} from './contacts/people';
import {tracked} from './crm/executors';
import {crmEnrichedCustomers} from './crm/tools';
import {listEventLeads, readContactsInput} from './contacts/leads';
import {logPiiRead} from './audit';
import {askOwner, isClarify, type ClarifyResult} from './clarify';
import {rangeLabel} from './range';
import {describeData} from './coverage';
import {createCrmExecutors} from './crm/executors';
import {shapeProductHistory} from './product-history';
import {phtDate} from './coverage';
import {digestsFor, readReportInput, shapeChannelReport} from './channel-report';
import type {RangeOrder} from '../custom-range';
import {coveringWindow, lookupProduct, shapeDigest, type DigestSource} from './digest-lookup';
import {sameWindow, windowOf} from '../digest-windows';
import {METRICS} from './metrics-registry';
import {createRenderExecutors, type RenderExecutors} from './render-executors';
import {createReportSession} from './report-session';
import {createReportExecutors} from './report-tools';
import {crmReason} from './crm/health';
import {runMetric} from './query-metric';
import type {MetricId, MetricRequest, MetricResult} from './result-types';
import type {ToolExecutors} from './tools';
import type {ChatToolContext} from './stream-types';

export const MAX_PAYLOAD_ROWS = 100;
/** A6: a day series longer than this is unreadable as a chart; the chat shows weeks instead and says so. */
export const MAX_DAY_POINTS = 92;

/** The tool executors plus the app-side Explore backstop (never reachable by the model: it is not a tool). */
export type ChatExecutors = ToolExecutors & Pick<RenderExecutors, 'autoRender'>;

const MAX_ALL_ROWS = 60; // every stored window, one cached read each; a long archive is cut here

export function createExecutors(ctx: ChatToolContext): ChatExecutors {
  let loaded: ReturnType<ChatToolContext['data']> | null = null;
  const data = () => (loaded ??= ctx.data());
  let counter = 0;
  let contactBlocks = 0;
  // The open report (F8) owns the result store: results are reachable by result id and by block id. Empty when none is open.
  const session = ctx.report ?? createReportSession();
  // Train 4: CRM results go into the same store as every other tool (charts and the number check work on them).
  const keep = (r: MetricResult) => {
    counter += 1;
    const id = `r${counter}`;
    session.store.set(id, {...r, id});
    return compact(r, id);
  };

  // The website side of find/overlap goes through the chat's own GET-only CRM client (one chat_crm_call line per read); never src/crm-data.ts.
  const peopleSource = async (s: import('./contacts/leads').LeadsSource): Promise<PeopleSource> => {
    const base = {leads: s.leads, lazada: s.lazada ?? null, events: s.events};
    if (!ctx.crm) return {...base, website: null, websiteNote: 'the website CRM is not connected for this chat'};
    const out = await tracked({client: ctx.crm, user: ctx.user, sink: ctx.sink}, 'contacts', {endpoint: 'customers'}, (get) => crmEnrichedCustomers(get, ctx.now), (r) => r.enriched.length);
    return 'error' in out ? {...base, website: null, websiteNote: out.error.split('. ')[0].toLowerCase()} : {...base, website: out.enriched};
  };

  return {
    ...createRenderExecutors(ctx, session),
    ...createReportExecutors(ctx, session, data),
    ...(ctx.explore ? {run_query: ctx.explore} : {}),
    ...(ctx.exploreSchema ? {list_tables: ctx.exploreSchema.list_tables, describe_table: ctx.exploreSchema.describe_table} : {}),
    ...(ctx.crm ? createCrmExecutors({client: ctx.crm, now: ctx.now, user: ctx.user, sink: ctx.sink, keep}) : {}),
    describe_data: async (input) => describeData(input as {metric: string}, await data(), ctx.now, !!ctx.explore, !!ctx.crm, !!ctx.crmOrders || !!ctx.crm),
    query_metric: async (input) => {
      let result = runMetric(input, await data(), ctx.now);
      if ('error' in result) return {error: result.error};
      if (result.dimension === 'day' && result.rows.length > MAX_DAY_POINTS) {
        // A6: too many days to read. Weeks instead, said first; the owner can ask for a shorter range to see days.
        const days = result.rows.length;
        input = {...(input as object), dimension: 'week'};
        const weekly = runMetric(input, await data(), ctx.now);
        if (!('error' in weekly)) {
          weekly.meta.caveats.unshift(`Shown by week: by day would be ${days} points, too many to read. Ask for a range of ${MAX_DAY_POINTS} days or less to see days.`);
          result = weekly;
        }
      }
      const outside = noDataAsk(result);
      if (outside) return outside; // the loop asks the owner and ends the turn
      counter += 1;
      const id = `r${counter}`;
      session.remember(id, input as MetricRequest, {...result, id}); // runMetric accepted the input, so it IS a MetricRequest
      return compact(result, id);
    },
    // F10. These results are stored for the render tools but have no MetricRequest recipe, so a block drawn from one is shown in
    // the chat and is not recorded into a saved report (nothing could re-run it).
    get_digest: async (input) => {
      let source: DigestSource | null = null;
      try {
        source = ctx.digest ? await ctx.digest() : null;
      } catch {
        source = null; // an unreadable digest is "not available", never a crash
      }
      if ((input as {window?: unknown})?.window === 'all') {
        const all = source ? await digestsFor(source, '2000-01-01', '2999-12-31', MAX_ALL_ROWS) : [];
        const hist = shapeProductHistory(input, all, phtDate(ctx.now), source?.source === 'mock');
        if ('error' in hist) return {error: hist.error};
        counter += 1;
        const id = `r${counter}`;
        session.store.set(id, {...hist.result, id});
        return compact(hist.result, id);
      }
      // "covering" may pick a digest older than the loaded ones: load that one row first (a narrow, cached read).
      const want = source ? coveringWindow(input, source) : null;
      if (source && want && source.rowAt && !source.rows.some((r) => sameWindow(windowOf(r), want))) {
        const extra = await source.rowAt(want).catch(() => null);
        if (extra) source = {...source, rows: [...source.rows, extra]};
      }
      const out = shapeDigest(input, source, ctx.now);
      if ('error' in out) return {error: out.error};
      counter += 1;
      const id = `r${counter}`;
      session.store.set(id, {...out.result, id});
      return {...compact(out.result, id), window: out.window, headline: out.headline};
    },
    // F.6: computed figures per channel for any dates. Like get_digest, the result has no re-runnable recipe, so a block drawn from it
    // is shown in the chat and is not recorded into a saved report.
    get_channel_report: async (input) => {
      const req = readReportInput(input);
      if ('error' in req) return {error: req.error};
      const wants = (c: string): boolean => (req.channels as string[]).includes(c);
      let digest: DigestSource | null = null;
      if (wants('shopee') || wants('lazada')) {
        try {
          digest = ctx.digest ? await ctx.digest() : null;
        } catch {
          digest = null; // unreadable digests: the channel says so, never a crash
        }
      }
      let website: {orders: RangeOrder[]; asOf: string} | null = null;
      let websiteFailed = false;
      let websiteReason: string | undefined;
      if (wants('website') && ctx.crmOrders) {
        try {
          website = await ctx.crmOrders();
        } catch (e) {
          websiteFailed = true; // read failed: say so, never "live orders as of ..." with zero sales
          websiteReason = crmReason(e);
        }
      }
      const result = shapeChannelReport(req, {
        digests: digest ? [...(await digestsFor(digest, req.from, req.to)), ...(await (ctx.daily?.() ?? Promise.resolve([])).catch(() => []))] : null,
        mock: digest?.source === 'mock',
        website,
        websiteFailed,
        websiteReason,
        data: wants('offline') ? await data() : null,
      });
      counter += 1;
      const id = `r${counter}`;
      session.store.set(id, {...result, id});
      return compact(result, id);
    },
    ...(ctx.leads ? {contacts: async (input: unknown) => {
      const req = readContactsInput(input);
      if ('error' in req) return {error: req.error};
      const source = await ctx.leads!();
      let out: ReturnType<typeof listEventLeads> | ReturnType<typeof draftLeads> | ReturnType<typeof findPeople>;
      if (req.mode === 'find' || req.mode === 'overlap' || req.mode === 'matches') {
        const people = await peopleSource(source);
        out = req.mode === 'find' ? findPeople(req, people) : req.mode === 'overlap' ? overlapPeople(req, people) : matchPeople(req, people);
      } else {
        out = req.mode === 'draft' ? draftLeads(req, source) : listEventLeads(req, source);
      }
      if ('table' in out) {
        contactBlocks += 1;
        ctx.emitBlock?.({kind: 'table', id: `c${contactBlocks}`, source: `contacts:${out.audit.eventId}`, ...out.table});
        logPiiRead({tool: 'contacts', mode: req.mode, ok: true, code: null, eventId: out.audit.eventId, rows: out.audit.rows, columns: out.audit.columns, user: ctx.user}, ctx.sink);
        return {ok: true, shown: true, block: `c${contactBlocks}`, ...out.model};
      }
      logPiiRead({tool: 'contacts', mode: req.mode, ok: false, code: isClarify(out) ? 'clarify' : 'no_result', eventId: null, rows: null, columns: [], user: ctx.user}, ctx.sink);
      return out;
    }} : {}),
    ask_owner: async (input) => askOwner(input), // a question: the loop writes it and ends the turn
    lookup_product: async (input) => {
      const result = lookupProduct(input, await data(), ctx.now);
      if ('error' in result) return {error: result.error};
      if (isClarify(result)) return result; // the loop asks the owner and ends the turn
      counter += 1;
      const id = `r${counter}`;
      session.store.set(id, {...result, id});
      return compact(result, id);
    },
  };
}

/**
 * A4: dates the POS data does not reach at all would read as "₱0". The chat asks instead (saved-report re-runs keep the plain result).
 * Stock is "as of now" and never outside the data.
 */
export function noDataAsk(r: MetricResult): ClarifyResult | null {
  const {coverage, dataFrom, dataTo, range} = r.meta;
  if (coverage !== 'none' || !dataFrom || !dataTo) return null;
  const covered = rangeLabel(dataFrom, dataTo);
  return {clarify: {question: `The offline (POS) sales data covers ${covered}, so there is nothing for ${range.label}. Use the dates the data covers?`, options: [`Use ${covered}`]}};
}

function compact(r: MetricResult, id: string) {
  const {measures, ...meta} = r.meta;
  const used = measures.find((m) => m.key === meta.measure);
  const total = r.rows.length;
  return {
    id,
    metric: r.metric,
    dimension: r.dimension,
    columns: r.columns,
    rows: total > MAX_PAYLOAD_ROWS ? r.rows.slice(0, MAX_PAYLOAD_ROWS) : r.rows,
    ...(total > MAX_PAYLOAD_ROWS ? {truncated: {shown: MAX_PAYLOAD_ROWS, total}} : {}),
    meta: {...meta, method: used?.method ?? '', declared_measures: measures.map((m) => m.key)},
  };
}

/** Plain-language progress line. Labels come from the registry only; raw input text is never echoed. */
export function statusFor(name: string, input: unknown): string {
  if (name === 'describe_data') return 'Checking what data is available';
  if (name === 'query_metric' && input !== null && typeof input === 'object') {
    const {metric, dimension} = input as {metric?: unknown; dimension?: unknown};
    if (typeof metric === 'string' && Object.prototype.hasOwnProperty.call(METRICS, metric)) {
      const def = METRICS[metric as MetricId];
      const dim = typeof dimension === 'string' && dimension !== 'none' ? def.dimensions.find((d) => d.key === dimension) : undefined;
      return `Looking at ${def.label.toLowerCase()}${dim ? ` by ${dim.label.toLowerCase().replace(/^by /, '').replace(/\s*\(.*\)/, '')}` : ''}`;
    }
  }
  if (name === 'run_query') return 'Running an exploratory query'; // constant: never echoes the SQL
  if (name === 'list_tables') return 'Listing the tables';
  if (name === 'describe_table') return "Reading a table's columns";
  if (name === 'get_digest') return 'Reading a stored digest';
  if (name === 'get_channel_report') return 'Building the channel report';
  if (name === 'get_crm_metrics') return 'Reading the website CRM totals';
  if (name === 'list_crm_orders') return 'Looking up website orders';
  if (name === 'list_crm_customers') return 'Looking up website customers';
  if (name === 'list_crm_checkouts') return 'Looking up abandoned checkouts';
  if (name === 'lookup_product') return 'Looking up a product';
  if (name === 'contacts') return 'Looking up contacts';
  if (name === 'ask_owner') return 'Checking what you mean';
  if (name === 'render_kpi') return 'Adding a tile';
  if (name === 'render_chart') return 'Drawing a chart';
  if (name === 'render_table') return 'Building a table';
  if (name === 'set_report_filters') return 'Updating the dashboard filters';
  if (name === 'remove_block') return 'Removing a block';
  if (name === 'set_report_title') return 'Renaming the dashboard';
  return 'Working on it';
}
