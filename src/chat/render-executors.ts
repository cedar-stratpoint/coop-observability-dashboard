// F7 + F8: the three render tools. Each binds the request to a stored result (bind.ts), emits the blocks to the stream and
// returns only a compact summary to the model: block ids and what was chosen, never the data. With a report open (F8) a
// render call may re-bind ANY block of it (`block: 'bN'`), `source` may be a result id or a block id, and every
// successful call is recorded into the report spec, which is then emitted. Pure, no server-only.
import {bindBlock, type RenderTool} from './bind';
import type {ChatBlock, ChosenView} from './block-types';
import {recommendView} from './recommend-view';
import {filtersOf, queryOf, sameFilters} from './report-spec';
import {REPORT_FULL, type ReportSession} from './report-session';
import {REPORT_MAX_BLOCKS, type ReportBlockSpec, type ReportQuery} from './report-types';
import type {ToolExecutors} from './tools';
import type {ChatToolContext} from './stream-types';

const TOOLS: readonly RenderTool[] = ['render_kpi', 'render_chart', 'render_table'];
const BLOCK_ID = /^b[1-9][0-9]{0,2}$/;
const MAX_Y = 8;
const AUTO_RENDER_MAX = 3; // Explore backstop: unrendered final results drawn per turn
const AUTO_REGISTRY_MAX = 2; // backstop: unrendered query_metric results drawn per turn
// The default of every analytical answer is a visualization; a table is its companion. One nudge per request.
export const CHART_FIRST_TEXT = 'Nothing was drawn and your call was fine. A chart is the default for this data: call render_chart (kind auto, or the form the owner named) first, then render_table again as its companion. If the owner explicitly asked for only a table, call render_table again unchanged.';

const summary = (c: ChosenView) => ({form: c.form, orientation: c.orientation, reason: c.reason, adjustments: c.adjustments, ...(c.notes?.length ? {notes: c.notes} : {})});
const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : []);

/** The recipe of one emitted block: the query it came from and the view the tool call asked for. */
function specOf(tool: RenderTool, input: Record<string, unknown>, block: ChatBlock, query: ReportQuery): ReportBlockSpec {
  if (block.kind === 'kpi') return {id: block.id, kind: 'kpi', query, view: {value: String(input.value), label: block.label, format: block.format}};
  if (block.kind === 'table') {
    const wanted = tool === 'render_table' ? strings(input.columns) : [];
    return {id: block.id, kind: 'table', query, view: {columns: wanted.length ? wanted : ['auto'], title: block.title}};
  }
  const kind = typeof input.kind === 'string' ? input.kind : 'auto';
  const orientation = input.orientation === 'vertical' || input.orientation === 'horizontal' ? input.orientation : 'auto';
  const x = typeof input.x === 'string' && input.x !== '' ? input.x : 'auto';
  const y = strings(input.y).slice(0, MAX_Y);
  return {id: block.id, kind: 'chart', query, view: {kind, orientation, mode: kind === 'auto' ? 'auto' : 'user', x, y: y.length ? y : ['auto'], title: block.title}};
}

export type RenderExecutors = Pick<ToolExecutors, RenderTool> & {
  /**
   * Backstop for a registry (`query_metric`) result too: a successful result of at least two rows that no block was bound from is drawn with the registry's own recommended view (at most AUTO_REGISTRY_MAX per turn);
   * a one-row result is a figure for the text and stays undrawn (THINK-06).
   * Explore backstop: draw EVERY successful, non-empty `run_query` final result no block was bound from yet (query order, at most AUTO_RENDER_MAX, the rest named in a note), each exactly as render_chart with auto selection
   * would (chart with its table twin, chip, SQL, code-written caveats). No model call and no model-typed value. Returns the block ids it drew ([] when nothing was due).
   */
  autoRender: () => Promise<string[]>;
};

export function createRenderExecutors(ctx: ChatToolContext, session: ReportSession): RenderExecutors {
  // Blocks with no re-runnable recipe (digest and product lookups) are drawn but never recorded in the report, so the report's
  // counter cannot number them. They get ids of their own, unique within this request (counter) and across requests (the
  // request time), so they never overwrite each other or an older block on screen, and can be re-bound within the turn.
  const tag = `u${ctx.now.getTime().toString(36).slice(-5)}`;
  const drawn: string[] = [];
  let charted = false; // a chart or tile was bound in this request
  let chartNudged = false;
  let pendingNote: string | null = null; // autoRender only: a caveat for the blocks of the call being drawn
  const bound = new Set<string>(); // result ids a block was drawn from in this request
  const run = (tool: RenderTool) => async (input: unknown): Promise<unknown> => {
    const rec = isRecord(input) ? input : {};
    const target = rec.block;
    const reuse = typeof target === 'string' && target !== 'new' && target !== '' ? target : null;
    const ids = session.ids();
    if (reuse !== null && !session.has(reuse) && !drawn.includes(reuse)) {
      return {error: `Unknown block '${reuse}'. Use "new"${ids.length ? ` or one of: ${ids.join(', ')}` : ' (no blocks have been drawn yet)'}.`};
    }
    // A block id as `source` must name a block that is still on the dashboard (a removed block's result is gone).
    const source = typeof rec.source === 'string' ? rec.source : '';
    if (BLOCK_ID.test(source) && !session.has(source)) {
      return {error: `Unknown result '${source}'. ${ids.length ? `Blocks on the dashboard: ${ids.join(', ')}.` : 'There are no blocks yet.'} Use a query_metric result id or a block id.`};
    }
    const request = session.requestOf(source);
    // Criterion 10: every block shares the dashboard's filters. A source asked with other filters must not slip in.
    if (request && session.size() > 0 && !sameFilters(filtersOf(request), session.filters())) {
      return {error: `Result '${source}' was asked with different filters than the dashboard. Do not mix scopes: call set_report_filters to change the filters of every block, then query again with the dashboard's filters.`};
    }

    // Chart first: a table of data that could be charted, with nothing visual drawn yet, is refused once.
    if (tool === 'render_table' && !charted && !chartNudged) {
      const result = session.store.get(source);
      if (result && recommendView(result, {kind: 'auto', orientation: 'auto'}).decisions.some((d) => d.block === 'chart')) {
        chartNudged = true;
        return {error: CHART_FIRST_TEXT};
      }
    }

    let pending = reuse !== null && (request ? session.has(reuse) : drawn.includes(reuse)) ? reuse : null;
    let n = session.counter();
    const nextId = (): string => {
      if (pending !== null) {
        const id = pending;
        pending = null;
        return id;
      }
      if (!request) {
        const id = `${tag}-${drawn.length + 1}`;
        drawn.push(id);
        return id;
      }
      n += 1;
      return `b${n}`;
    };
    const out = bindBlock(tool, input, session.store, nextId);
    if ('error' in out) return {error: out.error};
    const added = request ? out.blocks.length - (reuse !== null && session.has(reuse) ? 1 : 0) : 0;
    if (session.size() + added > REPORT_MAX_BLOCKS) return {error: REPORT_FULL};

    if (request) {
      if (session.size() === 0) session.adoptFilters(filtersOf(request));
      const query = queryOf(request);
      for (const block of out.blocks) {
        session.record(specOf(tool, rec, block, query));
        session.alias(block.id, source);
      }
    }
    if (tool !== 'render_table') charted = true;
    for (const block of out.blocks) {
      if (pendingNote) block.caveats.push(pendingNote);
      bound.add(block.source);
      ctx.emitBlock?.(block);
    }
    ctx.emitReport?.(session.snapshot());
    const blockIds = out.blocks.map((b) => b.id);
    const [first, ...rest] = out.chosen;
    return {
      ok: true,
      block: blockIds[0],
      ...(blockIds.length > 1 ? {blocks: blockIds} : {}),
      ...(first ? {chosen: summary(first)} : {}),
      ...(rest.length ? {also: rest.map(summary)} : {}),
    };
  };

  const autoRender = async (): Promise<string[]> => {
    const explore = [...session.store.entries()].filter(([id, r]) => /^x[1-9][0-9]*$/.test(id) && r.metric === 'explore' && r.rows.length > 0 && !bound.has(id));
    const registry = [...session.store.entries()].filter(([id, r]) => /^r[1-9][0-9]*$/.test(id) && (session.requestOf(id) !== undefined || r.metric === 'channel_report') && r.rows.length >= 2 && !bound.has(id));
    const draw = [...explore.slice(0, AUTO_RENDER_MAX), ...registry.slice(0, AUTO_REGISTRY_MAX)];
    const dropped = explore.length - Math.min(explore.length, AUTO_RENDER_MAX);
    const ids: string[] = [];
    for (const [i, [id]] of draw.entries()) {
      pendingNote = i === draw.length - 1 && dropped > 0 ? `${dropped} more ${dropped === 1 ? 'result was' : 'results were'} not drawn (at most ${AUTO_RENDER_MAX} blocks per answer). Ask for ${dropped === 1 ? 'it' : 'them'} on its own to see ${dropped === 1 ? 'it' : 'them'}.` : null;
      const out = (await run('render_chart')({block: 'new', source: id, kind: 'auto', orientation: 'auto', x: 'auto', y: ['auto'], title: ''})) as {ok?: true; block?: string; blocks?: string[]};
      if (out.ok) ids.push(...(out.blocks ?? (out.block ? [out.block] : [])));
    }
    pendingNote = null;
    return ids;
  };

  return {...(Object.fromEntries(TOOLS.map((t) => [t, run(t)])) as Pick<ToolExecutors, RenderTool>), autoRender};
}
