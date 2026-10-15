import {describe, expect, it, vi} from 'vitest';

vi.mock('server-only', () => ({}));

import {buildDigestBlock, buildLiveContextBlock, buildStaticSystem} from '../src/chat/context';
import {buildDegradedPreamble} from '../src/chat/preamble';
import {CHAT_TOOLS, exploreTools} from '../src/chat/tool-defs';

// F.5: PROD digests are mixed windows (weekly, about a month, rolling 30 days). No prompt text may call them weekly or 30-day.
describe('F.5 digest wording', () => {
  const texts = [
    buildStaticSystem({tools: true}), buildStaticSystem({tools: true, explore: true}), buildStaticSystem({tools: false}),
    buildLiveContextBlock(), buildLiveContextBlock({explore: true}), buildDigestBlock([], undefined, {home: true}),
    buildDegradedPreamble(new Date('2026-10-07T04:00:00Z')), JSON.stringify(CHAT_TOOLS), JSON.stringify(exploreTools()),
  ];
  it('never says "weekly digest", "rolling 30-day" or "published once a week"', () => {
    for (const t of texts) expect(t).not.toMatch(/weekly digest|rolling 30-day|published once a week/i);
  });
  it('says the windows vary: "weekly or about a month"', () => {
    expect(texts.join('\n')).toMatch(/weekly or about a month/);
  });
});
