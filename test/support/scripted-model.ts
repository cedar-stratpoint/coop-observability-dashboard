// F11: a scripted fake model. It replays a fixed (or computed) sequence of steps through the REAL `runChatLoop`, so an
// offline test drives the real loop, the real executors and the real report session over synthetic data with no network
// and no key. A step either asks for tools (`calls`, optionally after some `text`) or ends the turn with `text`.
// A script that runs out of steps THROWS: an extra model call (an unexpected extra tool step) fails the test loudly.
import type Anthropic from '@anthropic-ai/sdk';
import type {ChatBlock} from '../../src/chat/block-types';
import {runChatLoop, type ChatLoopSummary, type MessagesClient, type SystemBlock} from '../../src/chat/loop';
import {buildPreamble} from '../../src/chat/preamble';
import {openReportSession, type ReportSession} from '../../src/chat/report-session';
import type {DigestSource} from '../../src/chat/digest-lookup';
import type {MetricData} from '../../src/chat/result-types';
import type {ChatStreamEvent, ChatToolContext} from '../../src/chat/stream-types';
import {CHAT_TOOLS} from '../../src/chat/tool-defs';
import {createExecutors} from '../../src/chat/tool-executors';
import type {ToolExecutors} from '../../src/chat/tools';
import type {ReportSpec} from '../../src/chat/report-types';
import {EVAL_NOW} from './skill-eval-fixtures';

export interface ScriptedCall {
  name: string;
  input: unknown;
}

/** What the model saw come back for one of its tool calls in the previous step. */
export interface SeenResult {
  id: string;
  name: string;
  is_error: boolean;
  /** The tool_result content, parsed from JSON when it is JSON. */
  content: unknown;
}

export interface ScriptedStep {
  /** Text written in this step (before the calls, or the final answer). A function sees the previous step's results. */
  text?: string | ((seen: SeenResult[]) => string);
  /** Tool calls for this step. Empty or absent ends the turn. */
  calls?: ScriptedCall[] | ((seen: SeenResult[]) => ScriptedCall[]);
}

/**
 * A fixed list of steps, or a function of the step number (1-based), what the previous step's tools returned and the text of
 * the last message the model was sent (the question with its preamble on the first step), so an OBEDIENT model can follow an
 * instruction planted anywhere it can read.
 */
export type Script = readonly ScriptedStep[] | ((n: number, seen: SeenResult[], lastMessage: string) => ScriptedStep);

export interface ModelCall {
  step: number;
  name: string;
  input: unknown;
}

export class ScriptedClient implements MessagesClient {
  readonly requests: string[] = [];
  readonly modelCalls: ModelCall[] = [];
  /** tool_use id -> tool name, for every call the model made. */
  readonly toolNames = new Map<string, string>();
  constructor(private script: Script) {}

  private seenBy(params: {messages: {role: string; content: unknown}[]}): SeenResult[] {
    const last = params.messages.at(-1);
    if (!last || last.role !== 'user' || !Array.isArray(last.content)) return [];
    return (last.content as {type?: string; tool_use_id?: string; content?: unknown; is_error?: boolean}[])
      .filter((b) => b.type === 'tool_result')
      .map((b) => {
        let content: unknown = b.content;
        if (typeof content === 'string') {
          try {
            content = JSON.parse(content);
          } catch {
            // plain text stays text
          }
        }
        const id = String(b.tool_use_id);
        return {id, name: this.toolNames.get(id) ?? '', is_error: b.is_error === true, content};
      });
  }

  messages = {
    stream: (params: Anthropic.MessageStreamParams) => {
      this.requests.push(JSON.stringify(params));
      const n = this.requests.length;
      const seen = this.seenBy(params as unknown as {messages: {role: string; content: unknown}[]});
      let step: ScriptedStep;
      if (typeof this.script === 'function') step = this.script(n, seen, JSON.stringify((params.messages.at(-1) as {content?: unknown} | undefined)?.content ?? ''));
      else if (n <= this.script.length) step = this.script[n - 1];
      else throw new Error(`scripted model: the loop asked for step ${n} but the script has ${this.script.length}`);
      const text = typeof step.text === 'function' ? step.text(seen) : (step.text ?? '');
      const calls = typeof step.calls === 'function' ? step.calls(seen) : (step.calls ?? []);
      const uses = calls.map((c, i) => ({type: 'tool_use' as const, id: `tu_${n}_${i}`, name: c.name, input: c.input}));
      for (const [i, u] of uses.entries()) {
        this.toolNames.set(u.id, u.name);
        this.modelCalls.push({step: n, name: calls[i].name, input: calls[i].input});
      }
      const content = [...(text ? [{type: 'text' as const, text}] : []), ...uses];
      return {
        async *[Symbol.asyncIterator]() {
          if (text) yield {type: 'content_block_delta', index: 0, delta: {type: 'text_delta', text}} as Anthropic.MessageStreamEvent;
        },
        finalMessage: async () =>
          ({
            id: `msg_${n}`, type: 'message', role: 'assistant', model: 'scripted', content, stop_reason: uses.length ? 'tool_use' : 'end_turn', stop_sequence: null,
            usage: {input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0},
          }) as unknown as Anthropic.Message,
      };
    },
  };
}

export interface RunOptions {
  script: Script;
  /** The conversation so far; the last entry is the new user question. */
  messages: {role: 'user' | 'assistant'; content: string}[];
  data: MetricData;
  now?: Date;
  /** The report the drawer sends back (the spec of the previous turn), or null/absent for none. */
  report?: ReportSpec | null;
  digest?: DigestSource | null;
  crmOrders?: ChatToolContext['crmOrders'];
  /** Default: the real per-turn preamble the route builds (coverage plus the open dashboard's outline). */
  preamble?: string;
  system?: SystemBlock[];
  /** Extra executors merged over the real ones, e.g. trap executors under write-tool names (tests only). */
  extraExecutors?: Record<string, (input: unknown) => Promise<unknown>>;
  maxSteps?: number;
}

export interface RunResult {
  summary: ChatLoopSummary;
  client: ScriptedClient;
  events: ChatStreamEvent[];
  /** The streamed answer text, all steps joined. */
  text: string;
  blocks: ChatBlock[];
  /** Every report event emitted this turn. */
  reports: (ReportSpec | null)[];
  /** The report after the turn (what the drawer would send back next). */
  finalSpec: ReportSpec | null;
  session: ReportSession;
  /** Every tool_use the model made, in order (including refused and unknown ones). */
  modelCalls: ModelCall[];
  /** Names that reached an executor, in order. */
  executed: string[];
  /** Every tool result the model got back, in order. */
  results: SeenResult[];
  /** The audit lines, parsed. */
  info: Record<string, unknown>[];
  errors: Record<string, unknown>[];
}

const parse = (lines: unknown[][]): Record<string, unknown>[] => lines.map((l) => JSON.parse(String(l[0])) as Record<string, unknown>);

/** Run one turn through the real loop and the real executors. */
export async function runScripted(o: RunOptions): Promise<RunResult> {
  const now = o.now ?? EVAL_NOW;
  const info: unknown[][] = [];
  const errors: unknown[][] = [];
  const sink = {info: (...a: unknown[]) => void info.push(a), error: (...a: unknown[]) => void errors.push(a)};
  const events: ChatStreamEvent[] = [];
  const blocks: ChatBlock[] = [];
  const reports: (ReportSpec | null)[] = [];
  const session = openReportSession(o.report ?? undefined, o.data, now);
  const real = createExecutors({
    data: async () => o.data, now, user: 'scripted', report: session,
    emitBlock: (b) => blocks.push(b), emitReport: (s) => reports.push(s),
    ...(o.crmOrders ? {crmOrders: o.crmOrders} : {}),
    ...(o.digest !== undefined ? {digest: async () => o.digest as DigestSource} : {}),
  });
  const executed: string[] = [];
  const executors: ToolExecutors = {};
  for (const [name, fn] of Object.entries({...real, ...(o.extraExecutors ?? {})})) {
    if (!fn) continue;
    (executors as Record<string, (input: unknown) => Promise<unknown>>)[name] = async (input) => (executed.push(name), fn(input));
  }
  const client = new ScriptedClient(o.script);
  const summary = await runChatLoop({
    client, model: 'scripted', maxTokens: 4096, effort: 'medium',
    system: o.system ?? [{type: 'text', text: 'STATIC', cache_control: {type: 'ephemeral'}}],
    tools: CHAT_TOOLS, messages: o.messages, preamble: o.preamble ?? buildPreamble(o.data, now, session.outline()), executors,
    emit: (e) => events.push(e), user: 'scripted', sink, ...(o.maxSteps ? {maxSteps: o.maxSteps} : {}),
  });
  // Rebuild what the model saw from the recorded requests: each request's last user message holds the previous step's results.
  const results: SeenResult[] = [];
  for (const raw of client.requests.slice(1)) {
    const msgs = (JSON.parse(raw) as {messages: {role: string; content: unknown}[]}).messages;
    const last = msgs.at(-1);
    if (!last || !Array.isArray(last.content)) continue;
    for (const b of last.content as {type?: string; tool_use_id?: string; content?: string; is_error?: boolean}[]) {
      if (b.type !== 'tool_result') continue;
      let content: unknown = b.content;
      try {
        content = JSON.parse(String(b.content));
      } catch {
        // plain text
      }
      results.push({id: String(b.tool_use_id), name: client.toolNames.get(String(b.tool_use_id)) ?? '', is_error: b.is_error === true, content});
    }
  }
  return {
    summary, client, events, blocks, reports, session, modelCalls: client.modelCalls, executed, results,
    text: events.filter((e): e is Extract<ChatStreamEvent, {t: 'text'}> => e.t === 'text').map((e) => e.d).join(''),
    finalSpec: session.snapshot(), info: parse(info), errors: parse(errors),
  };
}
