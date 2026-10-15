// Live A8 (final review): the model typed a markdown table for get_channel_report and nothing was drawn. The loop's backstop now
// draws a channel report too (chart first, table twin), on any turn, when no render tool ran.
import {describe, expect, it} from 'vitest';
import {runChatLoop} from '../src/chat/loop';
import {CHAT_TOOLS, exploreTools} from '../src/chat/tool-defs';
import {FakeModel, sink, toolTurn, toolUse} from './support/fake-model';

const run = async (tools: typeof CHAT_TOOLS, calls: unknown[]) => {
  const m = new FakeModel((n) => (n === 1 ? toolTurn('', toolUse('a', 'get_channel_report', {from: '2026-09-01', to: '2026-09-30', channels: ['shopee'], granularity: 'total'})) : {text: ['Shopee led.'], stop_reason: 'end_turn'}));
  await runChatLoop({
    client: m, model: 'm', maxTokens: 10, effort: 'medium', system: [{type: 'text', text: 'S'}], tools, messages: [{role: 'user', content: 'hi'}], preamble: 'p',
    executors: {get_channel_report: async () => ({id: 'r1'}), autoRender: async () => (calls.push(1), ['b1'])} as never, emit: () => {}, user: null, sink: sink(),
  });
};

describe('get_channel_report is auto-drawn when the model draws nothing', () => {
  it('a plain turn: autoRender runs once', async () => {
    const calls: unknown[] = [];
    await run(CHAT_TOOLS, calls);
    expect(calls).toHaveLength(1);
  });
  it('an Explore turn: autoRender runs once', async () => {
    const calls: unknown[] = [];
    await run(exploreTools(), calls);
    expect(calls).toHaveLength(1);
  });
  it('a failed report is not drawn', async () => {
    const calls: unknown[] = [];
    const m = new FakeModel((n) => (n === 1 ? toolTurn('', toolUse('a', 'get_channel_report', {})) : {text: ['x'], stop_reason: 'end_turn'}));
    await runChatLoop({
      client: m, model: 'm', maxTokens: 10, effort: 'medium', system: [{type: 'text', text: 'S'}], tools: CHAT_TOOLS, messages: [{role: 'user', content: 'hi'}], preamble: 'p',
      executors: {get_channel_report: async () => ({error: 'bad'}), autoRender: async () => (calls.push(1), [])} as never, emit: () => {}, user: null, sink: sink(),
    });
    expect(calls).toHaveLength(0);
  });
});
