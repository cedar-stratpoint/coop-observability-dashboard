// Live probe (skipped without ANTHROPIC_API_KEY): the API rejects a request whose strict tools compile to a grammar that is too large
// (400 "compiled grammar is too large"). Slow on purpose: the API compiles the grammar. Run before a deploy that touches
// metrics-registry.ts, tool-defs.ts or crm/tools.ts: `ANTHROPIC_API_KEY=... npx vitest run test/chat-tools-grammar.integration.test.ts`.
import {describe, it, expect} from 'vitest';
import {chatTools} from '../src/chat/tool-defs';

describe.skipIf(!process.env.ANTHROPIC_API_KEY)('strict tool grammar fits the API cap', () => {
  for (const [explore, crm] of [[true, true], [false, true], [true, false]] as const) {
    it(`explore=${explore} crm=${crm}`, async () => {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {'x-api-key': process.env.ANTHROPIC_API_KEY as string, 'anthropic-version': '2023-06-01', 'content-type': 'application/json'},
        body: JSON.stringify({model: 'claude-sonnet-5-5', max_tokens: 1, tools: chatTools({explore, crm}), messages: [{role: 'user', content: 'hi'}]}),
      });
      expect(res.status, (await res.clone().text()).slice(0, 200)).toBe(200);
    }, 300_000);
  }
});
