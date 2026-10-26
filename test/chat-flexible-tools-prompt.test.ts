// knowledge/lessons/prompt-must-not-contradict-the-tools.md: a prompt variant that sends shopify_query or compare_sku must not say the data they read is unavailable
// or "digest only". The tool texts live in the tool definitions (outside the cached prompt budget); the prompt itself is not allowed to grow for them.
import {describe, expect, it, vi} from 'vitest';

vi.mock('server-only', () => ({}));

import {buildStaticSystem, buildLiveContextBlock} from '../src/chat/context';
import {buildPreamble} from '../src/chat/preamble';
import {estimateTokens} from '../src/chat/skills/load';
import type {MetricData} from '../src/chat/result-types';

const data = {source: 'live', orders: [], events: [], prices: [], priceChanges: [], bulkReads: []} as unknown as MetricData;
const now = new Date('2026-10-26T04:00:00Z');

describe('prompt variants that send shopify_query (the CRM tools are on)', () => {
  const variants = [
    ['static, crm', buildStaticSystem({tools: true, crm: true, website: true})],
    ['static, explore + crm', buildStaticSystem({tools: true, explore: true, crm: true, website: true})],
    ['live block, crm', buildLiveContextBlock({crm: true, website: true})],
    ['live block, explore + crm', buildLiveContextBlock({explore: true, crm: true, website: true})],
    ['preamble, crm', buildPreamble(data, now, '', null, {flags: {website: true, crm: true}})],
    ['preamble, explore + crm', buildPreamble(data, now, '', null, {explore: true, flags: {website: true, crm: true}})],
  ] as const;
  it.each(variants)('%s: website data is not "only from the digest" and Shopify is not denied', (_n, text) => {
    expect(text).not.toMatch(/Website[^.]{0,80}(come|comes) only from the digest/i);
    expect(text).not.toMatch(/Shopify[^.]{0,80}(not available|cannot be read|unavailable)/i);
  });
});

describe('no variant says a single product cannot be compared across channels', () => {
  it.each([
    ['static', buildStaticSystem({tools: true})],
    ['static, explore', buildStaticSystem({tools: true, explore: true})],
    ['static, crm', buildStaticSystem({tools: true, crm: true, website: true})],
  ])('%s', (_n, text) => {
    expect(text).not.toMatch(/(cannot|can't|not able to)[^.]{0,60}compare[^.]{0,60}(SKU|product)[^.]{0,40}channels?/i);
  });
});

describe('the cached Explore prompt did not grow for these tools (budget 14,400, was 14,396 before this change)', () => {
  it('stays at or below its size before shopify_query and compare_sku', () => {
    expect(estimateTokens(buildStaticSystem({tools: true, explore: true}))).toBeLessThanOrEqual(14_396);
  });
});
