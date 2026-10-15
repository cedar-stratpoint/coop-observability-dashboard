// Pure state for one streamed answer in the Ask Coop drawer (no React, no fetch): folding NDJSON events into the message list,
// what to show when the stream ends without a verdict, and the slot that owns the running request. coop-chat.tsx keeps only the
// side effects (setState, localStorage, the network). Contract of the events: src/chat/stream-types.ts.
import type {ChatStreamEvent} from '@/src/chat/stream-types';
import type {ReportSpec} from '@/src/chat/report-types';
import type {PlacedBlock} from './chat-blocks-format';
import {applyReportEvent, placeBlock} from './report-state';

/** Appended when the stream closes with neither a `done` nor an `error` event (the function was killed, the connection dropped). */
export const CUT_OFF_NOTE = 'The answer was cut off.';

export interface StreamMsg {
  content: string;
  blocks?: PlacedBlock[];
  /** Train 4: the answer used customer-entered text; its links render as plain text. */
  untrusted?: true;
}

export interface StreamState<M extends StreamMsg> {
  /** The working list: history plus the assistant message being streamed at index `last`. */
  messages: M[];
  /** The raw text of the streamed answer. */
  acc: string;
  /** Ids of the blocks the open REPORT holds (never every drawn block), so only a block the server removes leaves the screen. */
  held: Set<string>;
  /** A `done` event was seen. */
  finished: boolean;
  /** An `error` event was seen (it already put its text in the answer). */
  errored: boolean;
}

export interface StreamEffects {
  /** The status line to show now ('' clears it). Absent: unchanged. */
  status?: string;
  /** The server sent a report event: the new open report (null = none). Absent: unchanged. */
  report?: {spec: ReportSpec | null};
}

export function startStream<M extends StreamMsg>(working: M[], reportAtSend: ReportSpec | null): StreamState<M> {
  return {messages: working, acc: '', held: new Set((reportAtSend?.blocks ?? []).map((b) => b.id)), finished: false, errored: false};
}

const withAnswer = <M extends StreamMsg>(messages: M[], last: number, acc: string): M[] => messages.map((m, i) => (i === last ? {...m, content: acc} : m));

/** Fold decoded events into the state. Pure: returns a new state and the side effects the component must perform. */
export function applyStreamEvents<M extends StreamMsg>(state: StreamState<M>, last: number, events: readonly ChatStreamEvent[]): {state: StreamState<M>; effects: StreamEffects} {
  let {messages, acc, held, finished, errored} = state;
  const effects: StreamEffects = {};
  for (const ev of events) {
    if (ev.t === 'text') {
      acc += ev.d;
      effects.status = '';
    } else if (ev.t === 'block') {
      messages = placeBlock(messages, last, ev.block, acc.length, held);
    } else if (ev.t === 'report') {
      const applied = applyReportEvent(messages, held, ev.spec);
      messages = applied.messages;
      held = applied.held;
      effects.report = {spec: ev.spec};
    } else if (ev.t === 'status') {
      effects.status = ev.text;
    } else if (ev.t === 'error') {
      acc += `${acc ? '\n\n' : ''}⚠️ ${ev.message}`;
      errored = true;
      effects.status = '';
    } else if (ev.t === 'untrusted') {
      messages = messages.map((m, i) => (i === last ? {...m, untrusted: true as const} : m));
    } else if (ev.t === 'done') {
      finished = true;
      effects.status = '';
    }
  }
  return {state: {messages: withAnswer(messages, last, acc), acc, held, finished, errored}, effects};
}

/**
 * The stream ended (the reader said done). With a `done` or an `error` event that was a proper end; without either the answer was
 * cut off (the host killed the function at its time limit, or the connection dropped), and a partial answer must not look complete.
 */
export function closeStream<M extends StreamMsg>(state: StreamState<M>, last: number): StreamState<M> {
  if (state.finished || state.errored) return state;
  const acc = state.acc.trim() ? `${state.acc}\n\n${CUT_OFF_NOTE}` : CUT_OFF_NOTE;
  return {...state, acc, errored: true, messages: withAnswer(state.messages, last, acc)};
}

/**
 * Owns the one running request of the drawer. New chat, a re-opened report and Stop go through `abort()`; a request that finishes
 * (or is aborted) calls `release(ctrl)`, which only counts when `ctrl` is still the current one, so a stale stream that is winding
 * down can never clear the controller or the busy flag of the request that replaced it.
 */
export class StreamSlot {
  private current: AbortController | null = null;

  begin(): AbortController {
    const ctrl = new AbortController();
    this.current = ctrl;
    return ctrl;
  }

  /** Abort the running request, if any. */
  abort(): void {
    this.current?.abort();
  }

  /** True when `ctrl` was the current request (and it is now cleared); false when a newer request has taken over. */
  release(ctrl: AbortController): boolean {
    if (this.current !== ctrl) return false;
    this.current = null;
    return true;
  }
}
