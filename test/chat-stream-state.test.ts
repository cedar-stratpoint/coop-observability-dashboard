import {describe, expect, it} from 'vitest';
import type {ChatBlock} from '../src/chat/block-types';
import type {ReportSpec} from '../src/chat/report-types';
import type {ChatStreamEvent} from '../src/chat/stream-types';
import {CUT_OFF_NOTE, StreamSlot, applyStreamEvents, closeStream, startStream, type StreamMsg} from '../components/analyst/chat-stream-state';
import {createLineDecoder, encodeEvent} from '../src/chat/stream-protocol';
import {kpiRow, plainBar} from '../components/analyst/chat-blocks.fixtures';

type M = StreamMsg & {role: 'user' | 'assistant'};
const blockOf = (b: ChatBlock, id: string): ChatBlock => ({...b, id});
const spec = (ids: string[]): ReportSpec =>
  ({spec_version: 1, title: 'Dash', filters: {range: 'all_available', from: '', to: '', pet: 'all', event: 'all', channel: 'offline', pinned: false}, blocks: ids.map((id) => ({id}))}) as unknown as ReportSpec;
const done: ChatStreamEvent = {t: 'done', steps: 1, usage: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}};
const run = (state: ReturnType<typeof startStream<M>>, last: number, events: ChatStreamEvent[]) => applyStreamEvents(state, last, events);

describe('applyStreamEvents', () => {
  const history = (): M[] => [{role: 'user', content: 'q'}, {role: 'assistant', content: ''}];

  it('Train 4: an untrusted event marks only the streamed message, and the mark survives later text', () => {
    const out = run(startStream(history(), null), 1, [{t: 'untrusted'}, {t: 'text', d: 'See https://evil.example'}, done]);
    expect(out.state.messages[1]).toMatchObject({content: 'See https://evil.example', untrusted: true});
    expect(out.state.messages[0]).not.toHaveProperty('untrusted');
  });

  it('accumulates text into the streamed message and clears the status', () => {
    const out = run(startStream(history(), null), 1, [{t: 'status', text: 'Looking'}, {t: 'text', d: 'Hel'}, {t: 'text', d: 'lo'}]);
    expect(out.state.messages[1].content).toBe('Hello');
    expect(out.effects.status).toBe('');
    expect(run(startStream(history(), null), 1, [{t: 'status', text: 'Looking'}]).effects.status).toBe('Looking');
  });

  it('a block lands at the text offset; a report event updates what the open dashboard holds and reports it', () => {
    let out = run(startStream(history(), null), 1, [{t: 'text', d: 'Total.'}, {t: 'block', block: blockOf(plainBar, 'b1')}, {t: 'report', spec: spec(['b1'])}]);
    expect(out.state.messages[1].blocks).toEqual([{at: 6, block: blockOf(plainBar, 'b1')}]);
    expect([...out.state.held]).toEqual(['b1']);
    expect(out.effects.report).toEqual({spec: spec(['b1'])});
    out = run(out.state, 1, [{t: 'report', spec: spec([])}]); // remove_block
    expect(out.state.messages[1].blocks).toEqual([]);
  });

  it('a done event finishes; an error event shows its text and counts as an end', () => {
    expect(run(startStream(history(), null), 1, [done]).state.finished).toBe(true);
    const e = run(startStream(history(), null), 1, [{t: 'text', d: 'Part'}, {t: 'error', message: 'Coop hit a problem.'}]);
    expect(e.state.messages[1].content).toBe('Part\n\n⚠️ Coop hit a problem.');
    expect(e.state.errored).toBe(true);
    expect(e.state.finished).toBe(false);
  });

  it('M4 end to end: Clear dashboard, then a new dashboard draws b1 again; the old dashboard\'s b1 on screen is not overwritten', () => {
    // turn 1: dashboard b1 in message 1
    const turn1 = run(startStream(history(), null), 1, [{t: 'text', d: 'Dogs.'}, {t: 'block', block: {...blockOf(plainBar, 'b1'), title: 'Dog revenue'}}, {t: 'report', spec: spec(['b1'])}, done]);
    // the person clicks Clear dashboard (reportAtSend = null), then asks something else: the server numbers from b1 again
    const next: M[] = [...turn1.state.messages, {role: 'user', content: 'last month bundle sales by SKU'}, {role: 'assistant', content: ''}];
    const turn2 = run(startStream(next, null), 3, [{t: 'text', d: 'By SKU.'}, {t: 'block', block: {...blockOf(kpiRow[0], 'b1'), title: 'Unrelated tile'}}, {t: 'report', spec: spec(['b1'])}, done]);
    expect((turn2.state.messages[1].blocks?.[0].block as {title?: string}).title).toBe('Dog revenue'); // old tile untouched
    expect((turn2.state.messages[3].blocks?.[0].block as {title?: string}).title).toBe('Unrelated tile'); // new tile in the new message
    // the open dashboard still follows edits: the next turn edits b1 and it replaces the NEWEST b1
    const next2: M[] = [...turn2.state.messages, {role: 'user', content: 'rename it'}, {role: 'assistant', content: ''}];
    const turn3 = run(startStream(next2, spec(['b1'])), 5, [{t: 'block', block: {...blockOf(kpiRow[0], 'b1'), title: 'Renamed'}}, {t: 'report', spec: spec(['b1'])}, done]);
    expect((turn3.state.messages[1].blocks?.[0].block as {title?: string}).title).toBe('Dog revenue');
    expect((turn3.state.messages[3].blocks?.[0].block as {title?: string}).title).toBe('Renamed');
    expect(turn3.state.messages[5].blocks).toBeUndefined();
  });

  it('an unrecorded block (digest or product lookup, never held) is always new in the current message', () => {
    const first = run(startStream(history(), null), 1, [{t: 'block', block: blockOf(plainBar, 'u1-1')}, done]);
    const next: M[] = [...first.state.messages, {role: 'user', content: 'again'}, {role: 'assistant', content: ''}];
    const second = run(startStream(next, null), 3, [{t: 'block', block: blockOf(plainBar, 'u1-1')}, done]);
    expect(second.state.messages[1].blocks).toHaveLength(1);
    expect(second.state.messages[3].blocks).toHaveLength(1);
  });
});

describe('a stream cut off before done (M3)', () => {
  const lines = (events: ChatStreamEvent[]) => events.map(encodeEvent).join('');
  const history = (): M[] => [{role: 'user', content: 'q'}, {role: 'assistant', content: ''}];
  const consume = (chunks: string[]) => {
    const decode = createLineDecoder();
    let state = startStream(history(), null);
    for (const c of chunks) state = applyStreamEvents(state, 1, decode(c)).state;
    state = applyStreamEvents(state, 1, decode('', true)).state;
    return closeStream(state, 1);
  };

  it('appends "The answer was cut off." when the stream ends without done or error', () => {
    const s = consume([lines([{t: 'text', d: 'Revenue was ₱1,200 and'}])]);
    expect(CUT_OFF_NOTE).toBe('The answer was cut off.');
    expect(s.messages[1].content).toBe('Revenue was ₱1,200 and\n\nThe answer was cut off.');
  });

  it('a stream that dies mid-line is not left silent (the decoder reports the unreadable line as an error), and an empty one says only the note', () => {
    const torn = consume([lines([{t: 'text', d: 'Part one. '}]), '{"t":"text","d":"par']).messages[1].content;
    expect(torn.startsWith('Part one. ')).toBe(true);
    expect(torn).toMatch(/⚠️ Could not read part of the answer\./);
    expect(consume([]).messages[1].content).toBe('The answer was cut off.');
  });

  it('a complete stream (done) gets no note', () => {
    const s = consume([lines([{t: 'text', d: 'All good.'}, done])]);
    expect(s.messages[1].content).toBe('All good.');
  });

  it('an errored stream gets no second note', () => {
    const s = consume([lines([{t: 'text', d: 'Part'}, {t: 'error', message: 'Coop hit a problem answering that. Please try again.'}])]);
    expect(s.messages[1].content).not.toContain(CUT_OFF_NOTE);
  });
});

describe('StreamSlot (New chat must abort a running stream)', () => {
  it('abort() aborts the running request', () => {
    const slot = new StreamSlot();
    const ctrl = slot.begin();
    expect(ctrl.signal.aborted).toBe(false);
    slot.abort();
    expect(ctrl.signal.aborted).toBe(true);
  });

  it('abort() with nothing running is a no-op', () => {
    expect(() => new StreamSlot().abort()).not.toThrow();
  });

  it('a stale request cannot release the request that replaced it (no clobbered controller, no cleared busy flag)', () => {
    const slot = new StreamSlot();
    const old = slot.begin();
    slot.abort(); // New chat
    const fresh = slot.begin(); // the person asks again at once
    expect(slot.release(old)).toBe(false); // the aborted stream winds down: it must not reset the new one
    slot.abort();
    expect(fresh.signal.aborted).toBe(true); // the new request is still the one that Stop / New chat reach
    expect(slot.release(fresh)).toBe(true);
    expect(slot.release(fresh)).toBe(false);
  });

  it('the drawer wires New chat, Stop and Open report to the slot, and a post-abort chunk returns before touching state', async () => {
    const {readFileSync} = await import('node:fs');
    const src = readFileSync('components/analyst/coop-chat.tsx', 'utf8');
    const newChat = src.slice(src.indexOf('const newChat = useCallback'), src.indexOf('return (\n    <CoopChatCtx.Provider'));
    expect(newChat.indexOf('slotRef.current.abort()')).toBeGreaterThan(-1);
    expect(newChat.indexOf('slotRef.current.abort()')).toBeLessThan(newChat.indexOf('setMessages([])'));
    expect(src).toMatch(/const stop = useCallback\(\(\) => slotRef\.current\.abort\(\)/);
    expect(src).toMatch(/if \(ctrl\.signal\.aborted\) return;/);
    expect(src).not.toMatch(/abortRef/);
  });
});
