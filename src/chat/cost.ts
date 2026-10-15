// Cost cap per chat turn (spec 2.8). Usage is weighed in input-token equivalents with the API's price RATIOS (output 5x input,
// 5-minute cache write 1.25x, cache read 0.1x), so the cap does not depend on one model's price list. Pure.
import type {ChatUsage} from './stream-types';

export const DEFAULT_TURN_BUDGET = 300_000;
export const COST_CAP_TEXT = 'That question needed more work than one answer allows. Try a narrower question.';

export const costUnits = (u: ChatUsage): number => u.input + u.output * 5 + u.cacheWrite * 1.25 + u.cacheRead * 0.1;

export function turnBudgetFromEnv(env: Record<string, string | undefined>): number {
  const n = Number(env.CHAT_TURN_BUDGET);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TURN_BUDGET;
}
