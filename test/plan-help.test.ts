import {describe, expect, it} from 'vitest';
import {PLAN_HELP} from '../src/plan-help';

describe('PLAN_HELP copy map', () => {
  it('keeps every explanatory text non-empty', () => {
    for (const v of Object.values(PLAN_HELP)) {
      const s = typeof v === 'function' ? (v as (...a: never[]) => string)(...([13, true, false].slice(0, v.length) as never[])) : v;
      expect(s.length).toBeGreaterThan(10);
    }
  });
  it('says Website GMV is Shopify gross sales, every order', () => {
    expect(PLAN_HELP.sources).toMatch(/Website from Shopify gross sales/);
    expect(PLAN_HELP.sources).toMatch(/before discounts, shipping and tax/);
    expect(PLAN_HELP.sources).not.toMatch(/other than cancelled/);
  });
  it('fills in the dynamic parts', () => {
    expect(PLAN_HELP.grid(13)).toContain('Type the 13 lines');
    expect(PLAN_HELP.stockChart(1.84)).toContain('1.8 months of cover');
    expect(PLAN_HELP.stockChart(null)).not.toContain('cover');
    expect(PLAN_HELP.openingCash(true, false)).toMatch(/bank balance/);
    expect(PLAN_HELP.openingCash(false, true)).toMatch(/against your bank/);
  });
});

import {closeAction} from '../src/plan-compute';
describe('closeAction (header close button)', () => {
  it('hides when nothing waits', () => expect(closeAction({waiting: null, tag: "Oct'26", blocker: null, filled: 13, required: 13})).toBeNull());
  it('is primary and named for the month when ready', () => expect(closeAction({waiting: '2026-10-01', tag: "Oct'26", blocker: null, filled: 13, required: 13})).toEqual({label: "Close Oct'26", blocked: false, reason: null}));
  it('is quiet with the blocker as reason', () => expect(closeAction({waiting: '2026-10-01', tag: "Oct'26", blocker: 'Website data is not in yet.', filled: 13, required: 13})).toMatchObject({blocked: true, reason: 'Website data is not in yet.'}));
  it('is quiet when lines are missing', () => expect(closeAction({waiting: '2026-10-01', tag: "Oct'26", blocker: null, filled: 9, required: 13})?.reason).toMatch(/9 of 13/));
});
