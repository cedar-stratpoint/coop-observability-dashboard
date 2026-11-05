import {describe, expect, it} from 'vitest';
import {assemblePlan, GRID_METRIC_GROUPS, LINE_GROUPS, LINES, METRICS, stockOrderSeries} from '../src/plan-compute';

// The All months grid follows the approved prototype: typed lines first (grouped by what they feed), then the key-metrics block.
describe('grid row structure', () => {
  it('LINE_GROUPS lists every typed line exactly once, in the approved artifact order', () => {
    const ids = LINE_GROUPS.flatMap((g) => g.ids);
    expect(ids).toEqual(['overhead', 'cogs', 'platform_fees', 'fulfilment', 'event_costs', 'ad_marketplace', 'ad_website', 'event_marketing', 'content_other', 'inv_purchases_paid', 'bridge_funding', 'liability_settlement', 'freight_onetime']);
    expect([...ids].sort()).toEqual(LINES.map((l) => l.id).sort());
    expect(LINE_GROUPS.map((g) => g.label)).toEqual(['overhead', 'feeds CM1', 'feeds CM2', 'feeds CM3', 'cash flow items']);
  });
  it('GRID_METRIC_GROUPS covers every metric once', () => {
    const ids = GRID_METRIC_GROUPS.flatMap((g) => g.ids);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(METRICS.map((m) => m.id).sort());
    expect(GRID_METRIC_GROUPS[0]).toMatchObject({label: 'Key metrics', ids: ['gmv_total', 'gmv_events', 'gmv_website', 'gmv_marketplace']});
  });
});

describe('planned stock orders', () => {
  it('assemblePlan keeps the inventory purchases row', () => {
    const p = assemblePlan('v1', [{month: '2026-08-01', metric: 'inv_purchases', value: 0}, {month: '2026-09-01', metric: 'inv_purchases', value: '250000'}]);
    expect(p.targets.inv_purchases).toEqual([0, 250000]);
  });
  it('stockOrderSeries is the plan row as is, null where the plan has none (never invented)', () => {
    expect(stockOrderSeries({targets: {inv_purchases: [0, 250000, null]}})).toEqual([0, 250000, null]);
    expect(stockOrderSeries({targets: {}})).toEqual([]);
  });
});
