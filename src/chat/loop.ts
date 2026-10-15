// F5: the manual Messages-API tool loop. Pure of Next/server-only: the client is injected, so tests need no network.
// Pattern from Spike A (knowledge/tasks/2026-10-01-talk-to-data-spikes.md): assistant content is appended UNCHANGED
// (thinking blocks included), all tool_result blocks go back in ONE user message with results first, and the
// system + tools prefix is identical on every request so the prompt cache holds.
import type Anthropic from '@anthropic-ai/sdk';
import {logNumberCheckFailed, logNumberViolation, logRegistryGap, logTurn, type AuditSink} from './audit';
import {trailingRepeat} from './degenerate';
import {checkNumbers} from './number-check';
import {stripMarkdownTables} from './strip-tables';
import {assertRequestShape} from './request-shape';
import {COST_CAP_TEXT, costUnits} from './cost';
import type {ChatStreamEvent, ChatUsage, ToolDefinition} from './stream-types';
import {statusFor} from './tool-executors';
import {dispatchToolCall, RUN_QUERY_TOOL, type ToolExecutors, type ToolResult} from './tools';

/** Tools whose results carry text typed by customers or staff. After one succeeds, the stream says `untrusted` once, and the drawer
 *  renders every link in that answer as plain text (no exfiltration by a clicked, injected link; images are never rendered). */
export const UNTRUSTED_TEXT_TOOLS: ReadonlySet<string> = new Set(['run_query', 'list_crm_orders', 'list_crm_customers', 'list_crm_checkouts']);

/** The only part of the Anthropic SDK the loop touches. The real `new Anthropic()` satisfies it. */
export interface MessageStreamLike extends AsyncIterable<Anthropic.MessageStreamEvent> {
  finalMessage(): Promise<Anthropic.Message>;
  abort?(): void;
}
export interface MessagesClient {
  messages: {
    stream(params: Anthropic.MessageStreamParams, options?: {signal?: AbortSignal}): MessageStreamLike;
  };
}

export type SystemBlock = {type: 'text'; text: string; cache_control?: {type: 'ephemeral'}};
export type ChatEffort = 'low' | 'medium' | 'high';

export interface ChatLoopOptions {
  client: MessagesClient;
  model: string;
  maxTokens: number;
  effort: ChatEffort;
  system: SystemBlock[];
  tools: readonly ToolDefinition[];
  /** The sanitised conversation from the client; the last entry is the new user question. */
  messages: {role: 'user' | 'assistant'; content: string}[];
  /** Per-turn context (today's date, coverage). Goes ONLY into the latest user turn, never into the cached prefix. */
  preamble: string;
  executors: ToolExecutors & {
    /** Explore backstop (render-executors.ts): draws the last final result no block was bound from. Called by the loop, never by the model. */
    autoRender?: () => Promise<string[]>;
  };
  emit: (e: ChatStreamEvent) => void;
  user: string | null;
  maxSteps?: number;
  /** Wall-clock budget in ms (default 50_000; the route's maxDuration is 60 s). Checked before each model step, never mid-step. */
  deadlineMs?: number;
  /** Test seam: the clock, in ms. Defaults to Date.now. */
  clock?: () => number;
  signal?: AbortSignal;
  sink?: AuditSink;
  /** Explore: the shape facts of the finals that succeeded (fingerprints, views), for the once-per-question chat_registry_gap line. */
  exploreGap?: () => {fingerprints: string[]; views: string[]};
  /** Cost cap per turn in input-token equivalents (cost.ts costUnits); undefined = no cap. */
  turnBudget?: number;
}

export interface ChatLoopSummary {
  steps: number;
  usage: ChatUsage;
  stopReason: string | null;
}

export const REFUSAL_TEXT = "I can't help with that one.";
export const CUT_OFF_TEXT = '\n\nThe answer was cut off.';
export const DEGENERATE_TEXT = '\n\nThe answer got stuck repeating itself. Try asking again.';
/** The default wall-clock budget of one turn: the route allows 60 s, so a graceful stop has 10 s of room. */
export const CHAT_DEADLINE_MS = 50_000;
/**
 * Soft deadline: after this much of the turn no NEW tool-using step starts. A turn that already has tool results then gets exactly one
 * tool-less composing step (stopReason 'wrapped_up') instead of running into the hard deadline with nothing to say.
 */
export const TOOL_DEADLINE_MS = 30_000;
export const WRAP_UP_TEXT = 'Time is short: answer now from the results above, and say what you could not check. Plain text only: you cannot call tools now, so do not write tool calls or tags such as <render_chart>.';
export const DEADLINE_TEXT = 'That took longer than I allow. Try a narrower question.';
export const MAX_STEPS_TEXT = 'That took more steps than I allow. Try asking a narrower question.';
// DASH-01 as a gate: the first time a step asks to render before any text was written, every render call in that step is
// refused once with this message. After that the calls go through even if no text came (bounded cost: one extra step).
export const ORDER_NUDGE_TEXT = 'Nothing was drawn and your call was fine. Write the caveat (only if there is one) and one headline sentence as text now, in this same message, then repeat the same render calls.';
// EXP-04: an Explore answer is held until its figures are checked against the query rows. One rewrite is requested, then the answer is shown with a note.
export const NUMBER_NUDGE_TEXT = 'Some figures in your text do not appear in the query rows.';
export const SAFE_ERROR_TEXT = 'Coop hit a problem answering that. Please try again.';
/** The AI account itself is out of credit or blocked: nothing the owner can fix by retrying. No provider detail is shown. */
export const ACCOUNT_ERROR_TEXT = 'Ask Coop\'s AI account needs attention, so it cannot answer right now. Please tell your admin.';
// The system block that holds the selected week's digest (context.ts buildDigestBlock). Its figures are a legitimate source
// for the number check (the answer may quote the digest without a tool call); the skill text and catalog are not.
const DIGEST_HEADING = '## Selected period';

export async function runChatLoop(opts: ChatLoopOptions): Promise<ChatLoopSummary> {
  const {client, emit, signal, sink} = opts;
  const maxSteps = opts.maxSteps ?? 8;
  const deadlineMs = opts.deadlineMs ?? CHAT_DEADLINE_MS;
  const clock = opts.clock ?? Date.now;
  const t0 = clock();
  const usage: ChatUsage = {input: 0, output: 0, cacheRead: 0, cacheWrite: 0};
  let steps = 0;
  let stopReason: string | null = null;
  let textSeen = false;
  let nudged = false;
  // F11: the answer text and the (non-error) tool results of this turn, for the log-only number check.
  let answer = '';
  const seen: unknown[] = [];
  // EXP-04 (spec 7): after a run_query FINAL succeeded, the text of this turn is held until the number check has passed.
  let exploreUsed = false;
  let untrustedSent = false;
  let reportUsed = false; // a get_channel_report result succeeded: the app draws it when the model typed a table instead (live A8)
  let registryUsed = false; // a query_metric result succeeded: the app may draw it when the model forgot (backstop)
  // An Explore-capable turn (the run_query tool was sent) holds ALL text until its step ends: narration in a step that only calls tools
  // ("Fix the grouping.") is dropped, and only text before a render call or from the final no-tool step is the answer.
  const exploreTurn = opts.tools.some((t) => t.name === RUN_QUERY_TOOL);
  let held = '';
  let numberRetried = false;
  let drawn = false; // a block was drawn this turn (the model's render call succeeded, or the app's backstop drew one)
  const metricsTried: string[] = [];
  // F1: how long each model step and each tool batch took (numbers only; the chat_turn line carries them).
  const stepMs: number[] = [];
  const toolMs: number[] = [];
  const softMs = Math.min(TOOL_DEADLINE_MS, deadlineMs);
  let wrapping = false; // the compose reserve was started: every further step of this turn is tool-less

  const convo: Anthropic.MessageParam[] = opts.messages.map((m, i) =>
    i === opts.messages.length - 1 && m.role === 'user'
      ? {role: 'user', content: [{type: 'text', text: opts.preamble}, {type: 'text', text: m.content}]}
      : {role: m.role, content: m.content},
  );

  // Explore enforce mode counts only figures the USER or the app provided: an earlier ASSISTANT turn holds model-typed numbers, which
  // must not launder a new one (live test 5, H3). The log-only check of other turns keeps every earlier turn as context.
  const numberContext = (userOnly = false): string =>
    [...opts.messages.filter((m) => !userOnly || m.role === 'user').map((m) => m.content), opts.preamble, ...opts.system.filter((b) => b.text.startsWith(DIGEST_HEADING)).map((b) => b.text)].join('\n');

  // Log-only (Slice 6 #1) for every non-Explore turn: figures the answer displays that no tool result, question, preamble or digest holds.
  // It never changes, delays or blocks the answer, and a failure of the check itself is swallowed.
  const auditNumbers = (): void => {
    try {
      const {violations, checked} = checkNumbers(answer, seen, {context: numberContext()});
      if (violations.length > 0) logNumberViolation({violations, checked, user: opts.user}, sink);
    } catch {
      // the check is a safety net, never a dependency
    }
  };

  // Explore enforce mode: the held text, checked. `emit`s it (with a note when figures are unmatched) and clears it.
  // `retry` is true when the caller can still ask the model for a rewrite; then a violation is NOT emitted and the list is returned instead.
  // `drawnNow`: the caller is about to draw a block (a render call in this step); with a block already drawn, the typed markdown tables are removed
  // from the text first (the app draws the chart + table twin; live test 5, H2).
  const releaseHeld = (retry: boolean, drawnNow = false): string[] | null => {
    let text = held;
    if (text === '') return null;
    if (!exploreUsed) {
      // no run_query final succeeded: the text was only held for narration handling, and the number check stays log-only (auditNumbers).
      // A block drawn for a registry result (the model's or the backstop's) already shows the rows, so typed tables are removed here too.
      held = '';
      emit({t: 'text', d: drawn || drawnNow ? stripMarkdownTables(text) : text});
      return null;
    }
    if (drawn || drawnNow) text = stripMarkdownTables(text);
    let list: string[] = [];
    try {
      const {violations, checked} = checkNumbers(text, seen, {context: numberContext(true), countNouns: true});
      list = violations.map((v) => v.value);
      if (list.length > 0) {
        if (retry) return list;
        logNumberViolation({violations, checked, user: opts.user}, sink);
      }
    } catch {
      logNumberCheckFailed({user: opts.user}, sink);
      list = [];
    }
    held = '';
    emit({t: 'text', d: list.length > 0 ? `${text}\n\nNote: some figures here could not be matched to the query rows: ${list.slice(0, 10).join(', ')}.` : text});
    return null;
  };
  const dropHeld = (): void => {
    answer = answer.slice(0, Math.max(0, answer.length - held.length));
    held = '';
  };

  // Explore backstop: if the model finishes without drawing the last final result, the app draws it (no model call, no model-typed numbers).
  const backstop = async (): Promise<void> => {
    if (!(exploreUsed || reportUsed || (registryUsed && exploreTurn)) || !opts.executors.autoRender) return;
    try {
      if ((await opts.executors.autoRender()).length > 0) drawn = true;
    } catch {
      // drawing is a convenience on top of the answer, never a dependency
    }
  };

  const finish = (reason: string | null, done: boolean): ChatLoopSummary => {
    stopReason = reason;
    if (exploreUsed && opts.exploreGap) {
      try {
        const g = opts.exploreGap();
        logRegistryGap({fingerprints: g.fingerprints, views: g.views, metricsTried, user: opts.user}, sink);
      } catch {
        // a log line is never a dependency
      }
    }
    if (done) emit({t: 'done', steps, usage});
    logTurn({steps, usage, ms: clock() - t0, stopReason, stepMs, toolMs, user: opts.user}, sink);
    return {steps, usage, stopReason};
  };

  for (;;) {
    if (signal?.aborted) return finish('aborted', false);
    // Wall-clock budget: stop gracefully BEFORE starting another model step, so Vercel never has to kill the stream mid-answer.
    if (clock() - t0 > deadlineMs) {
      await backstop();
      releaseHeld(false);
      emit({t: 'text', d: `${answer.trim() ? '\n\n' : ''}${DEADLINE_TEXT}`});
      return finish('deadline', true);
    }
    const overBudget = opts.turnBudget !== undefined && costUnits(usage) >= opts.turnBudget;
    if (overBudget && (wrapping || seen.length === 0)) {
      await backstop();
      releaseHeld(false);
      emit({t: 'text', d: `${answer.trim() ? '\n\n' : ''}${COST_CAP_TEXT}`});
      return finish('cost_cap', true);
    }
    if (!wrapping && seen.length > 0 && (clock() - t0 > softMs || overBudget)) {
      wrapping = true;
      const last = convo[convo.length - 1];
      if (last?.role === 'user' && Array.isArray(last.content)) convo[convo.length - 1] = {role: 'user', content: [...last.content, {type: 'text', text: WRAP_UP_TEXT}]};
    }
    steps += 1;
    const stepStart = clock();

    let res: Anthropic.Message;
    try {
      const params = {
        model: opts.model,
        max_tokens: opts.maxTokens,
        thinking: {type: 'adaptive' as const},
        output_config: {effort: opts.effort},
        // Automatic caching: the breakpoint follows the last cacheable block, so the tool results that pile up within a turn are read
        // from cache on the next step instead of re-sent at full price. With the 3 explicit breakpoints (last tool, 2 system blocks) that is 4, the limit.
        cache_control: {type: 'ephemeral' as const},
        system: opts.system,
        // No tools (degraded digest-only mode): the API rejects an empty tools list, so omit tools and tool_choice.
        // The compose step keeps `tools` (the API requires them while tool_use blocks are in the history) but forbids calling them.
        ...(opts.tools.length > 0 ? {tools: [...opts.tools], tool_choice: wrapping ? {type: 'none' as const} : {type: 'auto' as const}} : {}),
        messages: [...convo],
      };
      assertRequestShape(params, sink);
      const stream = client.messages.stream(params, {signal});
      let degenerate = false;
      for await (const ev of stream) {
        if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
          if (ev.delta.text.trim() !== '') textSeen = true;
          let d = ev.delta.text;
          let trimHeld = 0;
          answer += d;
          // A runaway repeat ("<br> <br> ..."): keep one copy, stop reading, emit nothing more of it. Text already emitted live stays (< 20 repeats).
          const rep = trailingRepeat(answer);
          if (rep) {
            const cut = answer.length - (rep.start + rep.unit);
            answer = answer.slice(0, answer.length - cut);
            d = d.slice(0, Math.max(0, d.length - cut));
            trimHeld = cut;
            degenerate = true;
          }
          if (exploreUsed || exploreTurn) held = (held + ev.delta.text).slice(0, (held + ev.delta.text).length - trimHeld); // held until the number check passes (EXP-04) and until the step is known to be the answer
          else if (d !== '') emit({t: 'text', d});
          if (degenerate) {
            stream.abort?.();
            break;
          }
        }
      }
      if (degenerate) {
        stepMs.push(clock() - stepStart);
        await backstop();
        releaseHeld(false);
        emit({t: 'text', d: DEGENERATE_TEXT});
        return finish('degenerate', true);
      }
      res = await stream.finalMessage();
      stepMs.push(clock() - stepStart);
    } catch (err) {
      if (signal?.aborted) return finish('aborted', false);
      const e = err as {name?: unknown; status?: unknown};
      (sink ?? console).error(JSON.stringify({event: 'chat_error', name: String(e?.name ?? 'Error'), status: typeof e?.status === 'number' ? e.status : null, user: opts.user}));
      emit({t: 'error', message: e.status === 400 && /credit balance/i.test(String((err as {message?: unknown})?.message ?? '')) ? ACCOUNT_ERROR_TEXT : SAFE_ERROR_TEXT});
      return finish('error', false);
    }

    usage.input += res.usage?.input_tokens ?? 0;
    usage.output += res.usage?.output_tokens ?? 0;
    usage.cacheRead += res.usage?.cache_read_input_tokens ?? 0;
    usage.cacheWrite += res.usage?.cache_creation_input_tokens ?? 0;

    if (res.stop_reason === 'refusal') {
      held = '';
      emit({t: 'text', d: REFUSAL_TEXT});
      return finish('refusal', true);
    }
    if (res.stop_reason === 'max_tokens') {
      await backstop();
      releaseHeld(false);
      emit({t: 'text', d: CUT_OFF_TEXT});
      return finish('max_tokens', true);
    }
    const calls = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    if (res.stop_reason !== 'tool_use' || calls.length === 0) {
      const endReason = wrapping && res.stop_reason === 'end_turn' ? 'wrapped_up' : res.stop_reason;
      await backstop(); // drawn before the explanation text
      if (!exploreUsed) {
        releaseHeld(false);
        auditNumbers();
        return finish(endReason, true);
      }
      // Explore: the answer is checked before anyone sees it. One rewrite on a violation (it consumes a step), then the note.
      // A rewrite never starts past the hard deadline: the held answer is shown with its note instead.
      // Nor past the cost cap: a rewrite would be thrown away by the cap check, so the held answer is shown with its note instead.
      const capped = opts.turnBudget !== undefined && costUnits(usage) >= opts.turnBudget;
      const bad = releaseHeld(!numberRetried && !capped && steps < maxSteps && clock() - t0 <= deadlineMs);
      if (bad === null) return finish(endReason, true);
      numberRetried = true;
      dropHeld();
      convo.push({role: 'assistant', content: res.content as Anthropic.ContentBlockParam[]});
      convo.push({role: 'user', content: [{type: 'text', text: `${NUMBER_NUDGE_TEXT} Figures not found in the query rows: ${bad.slice(0, 10).join(', ')}. Rewrite the answer using only figures from the rows, or say you cannot tell.`}]});
      continue;
    }

    const isRender = (name: string) => name.startsWith('render_');
    // A Explore step that calls tools and no render tool is working, not answering: its text is narration and never reaches the answer.
    if (exploreTurn && held !== '' && !calls.some((c) => isRender(c.name))) {
      dropHeld();
      textSeen = false;
    }
    if (steps >= maxSteps) {
      await backstop();
      releaseHeld(false);
      emit({t: 'text', d: MAX_STEPS_TEXT});
      return finish('max_steps', true);
    }
    // The assistant turn goes back exactly as returned (thinking blocks included), then ONE user message of results.
    convo.push({role: 'assistant', content: res.content as Anthropic.ContentBlockParam[]});
    for (const c of calls) emit({t: 'status', text: statusFor(c.name, c.input)});
    const nudge = !textSeen && !nudged && calls.some((c) => isRender(c.name));
    if (nudge) nudged = true;
    // EXP-04: held Explore text is checked the moment the model asks to draw (the owner would otherwise see blocks before the words).
    let numberNudge: string | null = null;
    if (held.trim() !== '' && calls.some((c) => isRender(c.name))) {
      const bad = releaseHeld(!numberRetried, true);
      if (bad !== null) {
        numberRetried = true;
        dropHeld();
        numberNudge = `${NUMBER_NUDGE_TEXT} Figures not found in the query rows: ${bad.slice(0, 10).join(', ')}. Rewrite your text using only figures from the rows, then repeat the same render calls.`;
      }
    }
    for (const c of calls) {
      if (c.name === 'query_metric' && c.input !== null && typeof c.input === 'object' && typeof (c.input as {metric?: unknown}).metric === 'string') metricsTried.push((c.input as {metric: string}).metric);
    }
    const toolStart = clock();
    const results: ToolResult[] = await Promise.all(
      calls.map((c) =>
        numberNudge !== null && isRender(c.name)
          ? {is_error: true, content: {error: numberNudge}}
          : nudge && isRender(c.name)
            ? {is_error: true, content: {error: ORDER_NUDGE_TEXT}}
            : dispatchToolCall({name: c.name, input: c.input, user: opts.user}, opts.executors, sink),
      ),
    );
    toolMs.push(clock() - toolStart);
    // A hard guard trip fails the request (spec 3.5): no further model step, nothing held is shown.
    if (results.some((r) => r.trip)) {
      held = '';
      emit({t: 'text', d: REFUSAL_TEXT});
      return finish('guard_trip', true);
    }
    for (const r of results) if (!r.is_error) seen.push(r.content);
    calls.forEach((c, i) => {
      if (!untrustedSent && UNTRUSTED_TEXT_TOOLS.has(String(c.name)) && !results[i].is_error) {
        untrustedSent = true;
        emit({t: 'untrusted'});
      }
      const content = results[i].content as {id?: unknown} | null;
      if (c.name === 'run_query' && !results[i].is_error && typeof content?.id === 'string') exploreUsed = true;
      if (c.name === 'query_metric' && !results[i].is_error && typeof content?.id === 'string') registryUsed = true;
      if (c.name === 'get_channel_report' && !results[i].is_error && typeof content?.id === 'string') reportUsed = true;
      if (isRender(c.name) && !results[i].is_error && (content as {ok?: unknown} | null)?.ok === true) drawn = true;
    });
    convo.push({
      role: 'user',
      content: calls.map((c, i): Anthropic.ToolResultBlockParam => ({
        type: 'tool_result',
        tool_use_id: c.id,
        content: JSON.stringify(results[i].content) ?? 'null',
        ...(results[i].is_error ? {is_error: true} : {}),
      })),
    });
  }
}
