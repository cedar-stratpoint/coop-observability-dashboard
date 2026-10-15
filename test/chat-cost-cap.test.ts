import {describe, expect, it} from 'vitest';
import {COST_CAP_TEXT, costUnits, DEFAULT_TURN_BUDGET, turnBudgetFromEnv} from '../src/chat/cost';

describe('2.8 cost cap per chat turn', () => {
  it('weighs usage in input-token equivalents (output 5x, cache write 1.25x, cache read 0.1x)', () => {
    expect(costUnits({input: 1000, output: 100, cacheRead: 10_000, cacheWrite: 2000})).toBe(1000 + 500 + 1000 + 2500);
  });
  it('reads CHAT_TURN_BUDGET, with a safe default', () => {
    expect(turnBudgetFromEnv({})).toBe(DEFAULT_TURN_BUDGET);
    expect(turnBudgetFromEnv({CHAT_TURN_BUDGET: '150000'})).toBe(150_000);
    expect(turnBudgetFromEnv({CHAT_TURN_BUDGET: 'lots'})).toBe(DEFAULT_TURN_BUDGET);
    expect(COST_CAP_TEXT).toMatch(/narrower question/);
  });
});
