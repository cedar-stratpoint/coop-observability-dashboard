// EXP-04: Explore turns hold their text until the number check has passed (spec 7). Scripted model only: no network, no cost.
import {describe, expect, it} from 'vitest';
import {runChatLoop, NUMBER_NUDGE_TEXT, REFUSAL_TEXT, type ChatLoopOptions} from '../src/chat/loop';
import {exploreTools} from '../src/chat/tool-defs';
import {CHAT_TOOLS} from '../src/chat/tool-defs';
import {GuardTripError} from '../src/chat/tools';
import type {ChatStreamEvent} from '../src/chat/stream-types';
import {FakeModel, lines, sink, toolTurn, toolUse} from './support/fake-model';

const ROWS = {id: 'x1', metric: 'explore', rows: [{pet: 'dog', revenue_php: 1200.5, orders_count: 14}], data_notice: 'data'};
const RUN = (id = 'q1') => toolUse(id, 'run_query', {purpose: 'p', sql: 'select 1', step: 'final'});
const RENDER = toolUse('r1', 'render_chart', {block: 'new', source: 'x1', kind: 'auto', orientation: 'auto', x: 'auto', y: ['auto'], title: 'T'});

function run(model: FakeModel, over: Partial<ChatLoopOptions> = {}) {
  const events: ChatStreamEvent[] = [];
  const s = sink();
  const rendered: unknown[] = [];
  const opts: ChatLoopOptions = {
    client: model, model: 'm', maxTokens: 100, effort: 'medium',
    system: [{type: 'text', text: 'S'}], tools: exploreTools(),
    messages: [{role: 'user', content: 'Which pet sells most?'}], preamble: '[context] Today is Monday.',
    executors: {run_query: async () => ROWS, render_chart: async (i) => (rendered.push(i), {ok: true, block: 'b1'})},
    emit: (e) => events.push(e), user: 'owner@zoomy.test', sink: s, ...over,
  };
  return {opts, events, s, rendered, go: () => runChatLoop(opts)};
}
const text = (events: ChatStreamEvent[]) => events.filter((e) => e.t === 'text').map((e) => (e as {d: string}).d).join('');

describe('EXP-04 single-digit counts before a count noun are enforced on Explore turns (live test 4, G01)', () => {
  const TWO_SPELLINGS = {id: 'x1', metric: 'explore', rows: [{event: 'Circuit Makati Weekend', orders_count: 5}, {event: 'circuit makati weekend', orders_count: 2}], data_notice: 'data'};
  const withRows = (model: FakeModel) => run(model, {executors: {run_query: async () => TWO_SPELLINGS, render_chart: async () => ({ok: true, block: 'b1'})}});

  it('"6 orders" (5 + 2 added in the head) is held, one rewrite is requested with the violation list, and the rewrite is shown', async () => {
    const m = new FakeModel((n) => {
      if (n === 1) return toolTurn('', RUN());
      if (n === 2) return {text: ['6 orders at Circuit Makati Weekend.'], stop_reason: 'end_turn'};
      return {text: ['5 orders under one spelling and 2 orders under the other.'], stop_reason: 'end_turn'};
    });
    const t = withRows(m);
    const sum = await t.go();
    expect(sum.steps).toBe(3); // exactly one rewrite request
    expect(text(t.events)).toBe('5 orders under one spelling and 2 orders under the other.');
    expect(text(t.events)).not.toContain('6 orders');
    const retry = JSON.stringify(m.requests[2]);
    expect(retry).toContain(NUMBER_NUDGE_TEXT);
    expect(retry).toContain('Figures not found in the query rows: 6.');
  });

  it('still wrong after the one rewrite: shown with the note, never a second rewrite', async () => {
    const m = new FakeModel((n) => (n === 1 ? toolTurn('', RUN()) : {text: ['6 orders at Circuit Makati Weekend.'], stop_reason: 'end_turn'}));
    const t = withRows(m);
    const sum = await t.go();
    expect(sum.steps).toBe(3);
    expect(text(t.events)).toMatch(/Note: some figures here could not be matched to the query rows: 6\./);
  });

  it('"2 spellings" and "3 notes" are not flagged: the first answer is shown as is', async () => {
    const m = new FakeModel((n) => (n === 1 ? toolTurn('', RUN()) : {text: ['The event has 2 spellings and 3 notes, and 5 orders in one of them.'], stop_reason: 'end_turn'}));
    const t = withRows(m);
    const sum = await t.go();
    expect(sum.steps).toBe(2); // no rewrite request
    expect(text(t.events)).toBe('The event has 2 spellings and 3 notes, and 5 orders in one of them.');
  });
});

describe('EXP-04 number check enforce for Explore turns', () => {
  it('EXP-04 a figure not in the rows is retried once and the invented figure never reaches emit; the second attempt is shown', async () => {
    const m = new FakeModel((n) => {
      if (n === 1) return toolTurn('', RUN());
      if (n === 2) return {text: ['Dogs made ₱9,999 in sales.'], stop_reason: 'end_turn'};
      return {text: ['Dogs made ₱1,200.50 from 14 orders.'], stop_reason: 'end_turn'};
    });
    const t = run(m);
    const sum = await t.go();
    expect(text(t.events)).toBe('Dogs made ₱1,200.50 from 14 orders.');
    expect(text(t.events)).not.toContain('9,999');
    expect(sum.steps).toBe(3);
    const retry = JSON.stringify(m.requests[2]);
    expect(retry).toContain(NUMBER_NUDGE_TEXT);
    expect(retry).toContain('₱9,999');
  });

  it('EXP-04 still wrong on the second attempt: shown with a warning note, logged once', async () => {
    const m = new FakeModel((n) => (n === 1 ? toolTurn('', RUN()) : {text: [`Dogs made ₱${n}0,999 in sales.`], stop_reason: 'end_turn'}));
    const t = run(m);
    const sum = await t.go();
    expect(sum.steps).toBe(3);
    expect(text(t.events)).toMatch(/Note: some figures here could not be matched to the query rows: ₱30,999\./);
    expect(lines(t.s.info).filter((l) => l.event === 'chat_number_violation')).toHaveLength(1);
  });

  it('EXP-04 text before a render call is checked first: a bad figure refuses the render calls with the nudge and is never emitted', async () => {
    const m = new FakeModel((n) => {
      if (n === 1) return toolTurn('', RUN());
      if (n === 2) return toolTurn('Dogs made ₱7,777.', RENDER);
      if (n === 3) return toolTurn('Dogs made ₱1,200.50.', RENDER);
      return {text: ['Done.'], stop_reason: 'end_turn'};
    });
    const t = run(m);
    await t.go();
    expect(text(t.events)).not.toContain('7,777');
    expect(text(t.events)).toContain('₱1,200.50');
    expect(t.rendered).toHaveLength(1); // the first render call was refused, the second went through
    expect(m.requests[2]).toContain(NUMBER_NUDGE_TEXT);
  });

  it('EXP-04 a figure from the question or the preamble passes without a retry', async () => {
    const m = new FakeModel((n) => (n === 1 ? toolTurn('', RUN()) : {text: ['You asked about 1,234 pets; dogs have 14 orders.'], stop_reason: 'end_turn'}));
    const t = run(m, {messages: [{role: 'user', content: 'Out of my 1,234 pets, which sells most?'}]});
    const sum = await t.go();
    expect(sum.steps).toBe(2);
    expect(text(t.events)).toContain('1,234');
  });

  it('EXP-04 a non-Explore turn keeps streaming live (no held text) and its check stays log-only', async () => {
    const m = new FakeModel(() => ({text: ['Sales were ', '₱5,555 last week.'], stop_reason: 'end_turn'}));
    const t = run(m, {tools: CHAT_TOOLS});
    const sum = await t.go();
    expect(t.events.filter((e) => e.t === 'text')).toHaveLength(2);
    expect(sum.steps).toBe(1);
    expect(lines(t.s.info).filter((l) => l.event === 'chat_number_violation')).toHaveLength(1);
  });

  it('EXP-04 a probe alone does not start number enforcement, and its narration is dropped', async () => {
    const m = new FakeModel((n) => (n === 1 ? toolTurn('Let me look.', toolUse('q', 'run_query', {purpose: 'p', sql: 's', step: 'probe'})) : {text: ['₱5,555 it is.'], stop_reason: 'end_turn'}));
    const t = run(m, {executors: {run_query: async () => ({id: null, rows: [{n: 1}]})}});
    await t.go();
    expect(text(t.events)).toBe('₱5,555 it is.'); // "Let me look." was narration in a tool step; the figure is shown unchecked (no final succeeded)
  });

  it('EXP-04 the DASH-01 render nudge still fires when text is missing', async () => {
    const m = new FakeModel((n) => {
      if (n === 1) return toolTurn('', RUN());
      if (n === 2) return toolTurn('', RENDER);
      if (n === 3) return toolTurn('Dogs lead.', RENDER);
      return {text: [], stop_reason: 'end_turn'};
    });
    const t = run(m);
    await t.go();
    expect(m.requests[2]).toContain('Nothing was drawn');
    expect(t.rendered).toHaveLength(1);
  });

  it('EXP-04 a registry gap line is logged once when a final succeeded', async () => {
    const m = new FakeModel((n) => (n === 1 ? toolTurn('', toolUse('a', 'query_metric', {metric: 'pet_mix'}), RUN()) : {text: ['Dogs: 14 orders.'], stop_reason: 'end_turn'}));
    const t = run(m, {executors: {run_query: async () => ROWS, query_metric: async () => ({error: 'nope'})}, exploreGap: () => ({fingerprints: ['abc'], views: ['coop_explore_orders']})});
    await t.go();
    const gap = lines(t.s.info).filter((l) => l.event === 'chat_registry_gap');
    expect(gap).toEqual([{event: 'chat_registry_gap', fingerprints: ['abc'], views: ['coop_explore_orders'], metrics_tried: ['pet_mix'], user: 'owner@zoomy.test'}]);
  });
});

describe('EXP-02 a hard guard trip fails the request (spec 3.5)', () => {
  it('EXP-02 a GuardTripError ends the turn with the refusal text, no further model step, exactly one chat_guard_trip line, no SQL logged', async () => {
    const SECRET = "delete from pos_orders where handle = 'Maria Santos'";
    const m = new FakeModel(() => toolTurn('Trying.', toolUse('q', 'run_query', {purpose: 'Maria Santos', sql: SECRET, step: 'final'})));
    const t = run(m, {executors: {run_query: async () => { throw new GuardTripError('explore_parser', 'E_NOT_SELECT'); }}});
    const sum = await t.go();
    expect(sum.stopReason).toBe('guard_trip');
    expect(m.requests).toHaveLength(1);
    expect(text(t.events).endsWith(REFUSAL_TEXT)).toBe(true);
    const trips = lines(t.s.error).filter((l) => l.event === 'chat_guard_trip');
    expect(trips).toEqual([{event: 'chat_guard_trip', layer: 'explore_parser', detail: {code: 'E_NOT_SELECT', class: 'hard'}, user: 'owner@zoomy.test'}]);
    const all = JSON.stringify([t.s.info.mock.calls, t.s.error.mock.calls, t.s.warn.mock.calls]);
    expect(all).not.toContain('Maria Santos');
    expect(all).not.toContain('pos_orders');
  });
});

describe('EXP-02 params for the tool log never hold SQL', () => {
  it('EXP-02 a normal run_query call logs only step and lengths', async () => {
    const SQL = "select o.id from coop_explore_orders o where o.customer_handle = 'Maria Santos'";
    const m = new FakeModel((n) => (n === 1 ? toolTurn('', toolUse('q', 'run_query', {purpose: 'Maria Santos orders', sql: SQL, step: 'probe'})) : {text: ['ok'], stop_reason: 'end_turn'}));
    const t = run(m, {executors: {run_query: async () => ({id: null, rows: []})}});
    await t.go();
    expect(lines(t.s.info).find((l) => l.event === 'chat_tool')?.params).toEqual({step: 'probe', sql_chars: SQL.length, purpose_chars: 'Maria Santos orders'.length});
    expect(JSON.stringify(t.s.info.mock.calls)).not.toContain('Maria Santos');
  });
});

describe('compose reserve with the Explore number check', () => {
  // The script runs when a step starts, so it advances the fake clock by that step's duration.
  const timed = (durations: number[], answer: string) => {
    let t = 0;
    const m = new FakeModel((n) => ((t += durations[n - 1] ?? 0), n === 1 ? toolTurn('', RUN()) : {text: [answer], stop_reason: 'end_turn'}));
    return {m, clock: () => t};
  };

  it('the held wrap-up answer is checked and released normally', async () => {
    const {m, clock} = timed([35_000, 5_000], 'Dogs made ₱1,200.50 from 14 orders.'); // step 1 ends t=35 > 30 soft
    const t = run(m, {clock});
    const sum = await t.go();
    expect(sum.stopReason).toBe('wrapped_up');
    expect(text(t.events)).toBe('Dogs made ₱1,200.50 from 14 orders.');
  });

  it('a wrapped-up answer with a bad figure gets NO retry once past the hard deadline: it is shown with the note', async () => {
    const {m, clock} = timed([35_000, 20_000], 'Dogs made ₱9,999.'); // wrap-up ends t=55 > 50
    const t = run(m, {clock});
    const sum = await t.go();
    expect(m.requests).toHaveLength(2);
    expect(sum.stopReason).toBe('wrapped_up');
    expect(text(t.events)).toContain('9,999');
    expect(text(t.events)).toContain('could not be matched');
  });

  it('a bad figure inside the deadline still gets its one rewrite, and the rewrite is tool-less too', async () => {
    let t = 0;
    const m = new FakeModel((n) => ((t += 35_000 * (n === 1 ? 1 : 0) + 1_000), n === 1 ? toolTurn('', RUN()) : {text: [n === 2 ? 'Dogs made ₱9,999.' : 'Dogs made ₱1,200.50.'], stop_reason: 'end_turn'}));
    const r = run(m, {clock: () => t});
    const sum = await r.go();
    expect(sum.steps).toBe(3);
    expect(JSON.parse(m.requests[2]).tool_choice).toEqual({type: 'none'});
    expect(text(r.events)).toBe('Dogs made ₱1,200.50.');
  });
});

const TBL = '| pet | orders_count |\n|---|---:|\n| dog | 14 |';
const WITH_TABLE = `Dogs lead with 14 orders.\n\n${TBL}\n\nBasis: completed orders.`;
const PROSE = 'Dogs lead with 14 orders.\n\nBasis: completed orders.';

// Live test 5 (H2): the app already draws the chart + table twin, so a typed table of the same rows is removed from the answer text.
describe('EXP-03 typed markdown tables are removed once a block was drawn (live test 5, H2)', () => {
  it('auto-rendered turn: the table is stripped, the prose around it stays', async () => {
    const m = new FakeModel((n) => (n === 1 ? toolTurn('', RUN()) : {text: [WITH_TABLE], stop_reason: 'end_turn'}));
    const t = run(m, {executors: {run_query: async () => ROWS, autoRender: async () => ['b1']}});
    await t.go();
    expect(text(t.events)).toBe(PROSE);
  });
  it('model-rendered turn: text before the render call loses its table', async () => {
    const m = new FakeModel((n) => (n === 1 ? toolTurn('', RUN()) : n === 2 ? toolTurn(WITH_TABLE, RENDER) : {text: ['Done.'], stop_reason: 'end_turn'}));
    const t = run(m);
    await t.go();
    expect(text(t.events)).toBe(`${PROSE}Done.`);
    expect(t.rendered).toHaveLength(1);
  });
  it('an Explore turn where nothing was drawn keeps its table', async () => {
    const m = new FakeModel((n) => (n === 1 ? toolTurn('', RUN()) : {text: [WITH_TABLE], stop_reason: 'end_turn'}));
    const t = run(m, {executors: {run_query: async () => ROWS, autoRender: async () => []}});
    await t.go();
    expect(text(t.events)).toBe(WITH_TABLE);
  });
  it('a non-Explore turn keeps its table', async () => {
    const m = new FakeModel(() => ({text: [WITH_TABLE], stop_reason: 'end_turn'}));
    const t = run(m, {tools: CHAT_TOOLS});
    await t.go();
    expect(text(t.events)).toBe(WITH_TABLE);
  });
  it('a table inside a code fence is not stripped', async () => {
    const fenced = `Here:\n\n\`\`\`\n${TBL}\n\`\`\`\n\nDone.`;
    const m = new FakeModel((n) => (n === 1 ? toolTurn('', RUN()) : {text: [fenced], stop_reason: 'end_turn'}));
    const t = run(m, {executors: {run_query: async () => ROWS, autoRender: async () => ['b1']}});
    await t.go();
    expect(text(t.events)).toBe(fenced);
  });
});

// Live test 5 (H3): "Correction: my earlier reply said 6 orders" laundered a stale model-typed number through the earlier assistant turn.
describe('EXP-04 Explore number context holds only user and app figures, not earlier assistant turns (live test 5, H3)', () => {
  const HISTORY = [
    {role: 'user' as const, content: 'How did Circuit Makati do?'},
    {role: 'assistant' as const, content: 'Circuit Makati had 6 orders.'},
    {role: 'user' as const, content: 'And by pet?'},
  ];
  it('"6 orders" repeated from an earlier assistant turn, with no such cell, is flagged: one rewrite request', async () => {
    const m = new FakeModel((n) => (n === 1 ? toolTurn('', RUN()) : n === 2 ? {text: ['Correction: my earlier reply said 6 orders; dogs have 14 orders.'], stop_reason: 'end_turn'} : {text: ['Dogs have 14 orders.'], stop_reason: 'end_turn'}));
    const t = run(m, {messages: HISTORY});
    const sum = await t.go();
    expect(sum.steps).toBe(3);
    expect(JSON.stringify(m.requests[2])).toContain('Figures not found in the query rows: 6.');
    expect(text(t.events)).toBe('Dogs have 14 orders.');
  });
  it('a figure in the USER\'s own earlier message still passes', async () => {
    const m = new FakeModel((n) => (n === 1 ? toolTurn('', RUN()) : {text: ['You said 7 orders; dogs have 14 orders.'], stop_reason: 'end_turn'}));
    const t = run(m, {messages: [{role: 'user', content: 'Is it 7 orders at Circuit Makati?'}, {role: 'assistant', content: 'Let me check.'}, {role: 'user', content: 'Go on.'}]});
    const sum = await t.go();
    expect(sum.steps).toBe(2);
    expect(text(t.events)).toContain('7 orders');
  });
  it('a figure in this turn\'s result cells still passes', async () => {
    const m = new FakeModel((n) => (n === 1 ? toolTurn('', RUN()) : {text: ['Dogs have 14 orders.'], stop_reason: 'end_turn'}));
    const t = run(m, {messages: HISTORY});
    expect((await t.go()).steps).toBe(2);
  });
  it('a non-Explore turn keeps counting earlier assistant turns as context (no violation logged)', async () => {
    const m = new FakeModel(() => ({text: ['Circuit Makati had 6 orders.'], stop_reason: 'end_turn'}));
    const t = run(m, {tools: CHAT_TOOLS, messages: HISTORY});
    await t.go();
    expect(lines(t.s.info).filter((l) => l.event === 'chat_number_violation')).toHaveLength(0);
  });
});

describe('2.8 a finished Explore answer survives the cost cap (Task 8 fix 1, finding 2)', () => {
  it('over budget, the wrap-up answer fails the number check: it is shown with its note, not replaced by the cap text', async () => {
    const m = new FakeModel((n) => (n === 1 ? toolTurn('', RUN()) : {text: ['Dogs made ₱9,999 in sales.'], stop_reason: 'end_turn'}));
    const t = run(m, {turnBudget: 5});
    const sum = await t.go();
    expect(text(t.events)).toContain('Dogs made ₱9,999 in sales.');
    expect(text(t.events)).toMatch(/Note: some figures here could not be matched/);
    expect(text(t.events)).not.toMatch(/needed more work/);
    expect(sum.steps).toBe(2);
  });
});
