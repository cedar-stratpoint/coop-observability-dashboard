import {describe, expect, it} from 'vitest';
import {
  CRM_ORDERS_CAP, crmCoverage, eventsCells, marketplaceCells, phMonthKey, totalCells, websiteCells, websiteOrderCounts, WEBSITE_STATUS_RULES, PARTIAL_REFUND_NOTE,
} from '../src/plan-gmv';
import {dailyRowsToDigests} from '../src/daily-sales-digests';
import {rollupChannels} from '../src/period-rollup';
import {metricStatus} from '../src/plan-compute';
import type {PosEvent, PosOrder} from '../src/pos-sales-types';

const MONTHS = ['2026-08-01', '2026-09-01', '2026-10-01', '2026-11-01'];
const NOW = '2026-11';

const order = (over: Partial<PosOrder> & {id: string}): PosOrder => ({
  client_uuid: over.id, subtotal: 0, discount: null, total: 0, oversold: false, device_id: null, payment_method: 'cash', customer_handle: null,
  status: 'completed', remarks: null, created_at: '2026-08-10T04:00:00Z', edited_at: null, event_id: 'ev-1', pet_type: null, items: [], ...over,
});
const event = (over: Partial<PosEvent> & {event_id: string}): PosEvent => ({
  name: null, venue: null, city: null, organizer: null, starts_on: null, ends_on: null, opening_cash: null, cash_note: null, closing_cash: null,
  status: 'closed', created_by: null, created_at: null, updated_at: null, ...over,
});

describe('phMonthKey (Manila, UTC+8)', () => {
  it('31 Aug 23:59 +08:00 is August and 1 Sep 00:00 +08:00 is September', () => {
    expect(phMonthKey('2026-08-31T23:59:00+08:00')).toBe('2026-08');
    expect(phMonthKey('2026-09-01T00:00:00+08:00')).toBe('2026-09');
    expect(phMonthKey('2026-08-31T15:59:59Z')).toBe('2026-08');
    expect(phMonthKey('2026-08-31T16:00:00Z')).toBe('2026-09');
  });
  it('an unreadable timestamp has no month', () => {
    expect(phMonthKey('not a date')).toBeNull();
    expect(phMonthKey(null)).toBeNull();
  });
});

describe('Events GMV', () => {
  const first = order({id: 'first', created_at: '2026-08-02T04:00:00Z', total: 100});
  it('buckets by the PH month and sums non-voided event orders', () => {
    const cells = eventsCells(MONTHS, NOW, {
      events: [],
      orders: [
        first,
        order({id: 'aug-late', created_at: '2026-08-31T23:59:00+08:00', total: 500}),
        order({id: 'sep-early', created_at: '2026-09-01T00:00:00+08:00', total: 700}),
      ],
    });
    expect(cells[0]).toMatchObject({value: 600, state: 'ok'});
    expect(cells[1]).toMatchObject({value: 700, state: 'ok'});
  });
  it('a voided order is not counted', () => {
    const cells = eventsCells(MONTHS, NOW, {events: [], orders: [first, order({id: 'v', status: 'voided', total: 999})]});
    expect(cells[0].value).toBe(100);
  });
  it('a non-event POS order, a free taste and a prize are not counted', () => {
    const cells = eventsCells(MONTHS, NOW, {
      events: [],
      orders: [
        first,
        order({id: 'walk-in', event_id: null, total: 4000}), // a normal non-event day
        order({id: 'free-taste', total: 0}), // a free taste rung up at an event adds nothing
      ],
    });
    expect(cells[0].value).toBe(100);
  });
  it('an untagged order on a day exactly one event covers counts through effectiveEventId', () => {
    const cells = eventsCells(MONTHS, NOW, {
      events: [event({event_id: 'ev-9', starts_on: '2026-08-15', ends_on: '2026-08-16'})],
      orders: [first, order({id: 'untagged', event_id: null, created_at: '2026-08-15T05:00:00Z', total: 250})],
    });
    expect(cells[0].value).toBe(350);
  });
  it('a month after the first POS order with no event orders is a real zero', () => {
    const cells = eventsCells(MONTHS, NOW, {events: [], orders: [first]});
    expect(cells[1]).toMatchObject({value: 0, state: 'ok'});
    expect(cells[2]).toMatchObject({value: 0, state: 'ok'});
  });
  it('a month before the first POS order is a gap, never zero', () => {
    const cells = eventsCells(['2026-07-01', ...MONTHS], NOW, {events: [], orders: [first]});
    expect(cells[0]).toMatchObject({value: null, state: 'gap'});
  });
  it('no POS data at all (no env, failed read, no orders) is a gap everywhere', () => {
    for (const pos of [null, {events: [], orders: []}]) {
      for (const c of eventsCells(MONTHS, NOW, pos)) expect(c).toMatchObject({value: null, state: 'gap'});
    }
  });
  it('a month after the current one is a gap', () => {
    expect(eventsCells([...MONTHS, '2026-12-01'], NOW, {events: [], orders: [first]})[4]).toMatchObject({value: null, state: 'gap'});
  });
});

describe('Website GMV status table', () => {
  it('lists every Shopify status explicitly', () => {
    expect(WEBSITE_STATUS_RULES).toEqual({
      paid: true, pending: true, authorized: true, partially_paid: true, partially_refunded: true,
      refunded: false, voided: false, expired: false,
    });
  });
  it.each([
    ['paid', true], ['PAID', true], [' paid ', true], ['partially_refunded', true],
    ['pending', true], ['authorized', true], ['partially_paid', true],
    ['refunded', false], ['voided', false], ['expired', false],
    ['something_new', false], ['', false], [null, false],
  ])('%s -> counts: %s', (status, counts) => {
    expect(websiteOrderCounts(status as string | null)).toBe(counts);
  });
});

describe('Website GMV by month', () => {
  const o = (id: string, createdAt: string, totalPrice: string | null, financialStatus: string | null) => ({shopifyOrderId: id, createdAt, totalPrice, financialStatus});
  const orders = [
    o('1', '2026-08-05T04:00:00Z', '1000.50', 'paid'),
    o('2', '2026-08-31T23:59:00+08:00', '200', 'paid'),
    o('3', '2026-09-01T00:00:00+08:00', '300', 'paid'),
    o('4', '2026-09-02T04:00:00Z', '9999', 'refunded'),
    o('5', '2026-09-03T04:00:00Z', '9999', 'voided'),
    o('6', '2026-09-04T04:00:00Z', '50', 'partially_refunded'),
    o('7', '2026-09-05T04:00:00Z', 'abc', 'paid'), // unreadable price adds nothing and never NaN
  ];
  it('sums paid-like totals into the PH month, and excludes refunded and voided', () => {
    const cells = websiteCells(MONTHS, NOW, {orders, truncated: false});
    expect(cells[0]).toMatchObject({value: 1200.5, state: 'ok'});
    expect(cells[1]).toMatchObject({value: 350, state: 'ok'});
  });
  it('counts pending, authorized and partially_paid orders (owner rule: only cancelled, voided and refunded are out)', () => {
    const cells = websiteCells(['2026-09-01'], '2026-10', {orders: [o('p', '2026-09-02T04:00:00Z', '100', 'pending'), o('q', '2026-09-02T04:00:00Z', '10', 'authorized'), o('r', '2026-09-02T04:00:00Z', '1', 'partially_paid'), o('s', '2026-09-02T04:00:00Z', '9999', 'refunded')], truncated: false});
    expect(cells[0]).toMatchObject({value: 111, state: 'ok'});
    expect(cells[0].note).toBeUndefined();
  });
  it('a month with a partially refunded order keeps its full total and says it may overstate; a month without does not', () => {
    const cells = websiteCells(MONTHS, NOW, {orders, truncated: false});
    expect(cells[1].note).toBe(PARTIAL_REFUND_NOTE);
    expect(PARTIAL_REFUND_NOTE).toMatch(/may overstate/);
    expect(cells[0].note).toBeUndefined();
  });
  it('a month after the first CRM order with no orders is a real zero; before it a gap', () => {
    const cells = websiteCells(['2026-07-01', ...MONTHS], NOW, {orders, truncated: false});
    expect(cells[0]).toMatchObject({value: null, state: 'gap'});
    expect(cells[3]).toMatchObject({value: 0, state: 'ok'});
  });
  it('a failed or unconfigured read (null) is a gap everywhere, never an understated number', () => {
    for (const c of websiteCells(MONTHS, NOW, null)) expect(c).toMatchObject({value: null, state: 'gap'});
  });
  it('a CRM with no orders at all is a gap', () => {
    for (const c of websiteCells(MONTHS, NOW, {orders: [], truncated: false})) expect(c.state).toBe('gap');
  });
  it('a truncated read: months at or before the oldest returned order are gaps, later months are real', () => {
    const cut = [o('a', '2026-09-10T04:00:00Z', '100', 'paid'), o('b', '2026-10-10T04:00:00Z', '40', 'paid')];
    const cells = websiteCells(MONTHS, NOW, {orders: cut, truncated: true});
    expect(cells[0]).toMatchObject({value: null, state: 'gap'});
    expect(cells[1]).toMatchObject({value: null, state: 'gap'}); // September started before the oldest row we hold
    expect(cells[2]).toMatchObject({value: 40, state: 'ok'});
  });
});

describe('crmCoverage (the Worker returns its newest 1000 orders, ignores limit/offset)', () => {
  it('is truncated when the Worker hit its cap', () => {
    expect(CRM_ORDERS_CAP).toBe(1000);
    expect(crmCoverage(CRM_ORDERS_CAP, null).truncated).toBe(true);
    expect(crmCoverage(999, null).truncated).toBe(false);
  });
  it('is truncated when the CRM counts more orders than were returned', () => {
    expect(crmCoverage(500, 612).truncated).toBe(true);
    expect(crmCoverage(500, 500).truncated).toBe(false);
  });
});

describe('Marketplace GMV', () => {
  const win = {window_from: '2026-07-31T16:00:00Z', window_to: '2026-09-30T16:00:00Z', captured_at: '2026-10-05T00:00:00Z'};
  const rows = (channel: 'shopee' | 'lazada', days: string[], revenue: number) => days.map((day) => ({day, channel, revenue, orders: 1, units: 1, ...win}));
  const aug = Array.from({length: 31}, (_, i) => `2026-08-${String(i + 1).padStart(2, '0')}`);
  const sep = Array.from({length: 30}, (_, i) => `2026-09-${String(i + 1).padStart(2, '0')}`);
  const buckets = (r: ReturnType<typeof rows>) => rollupChannels({fromDay: '2026-08-01', toDay: '2026-10-31', channels: ['shopee', 'lazada'], granularity: 'month', digests: dailyRowsToDigests(r), website: null, offline: null});

  it('Shopee + Lazada per PH day, summed by month, ok only when both cover the whole month', () => {
    const cells = marketplaceCells(MONTHS, NOW, buckets([...rows('shopee', aug, 10), ...rows('lazada', aug, 5), ...rows('shopee', sep, 1), ...rows('lazada', sep, 1)]));
    expect(cells[0]).toMatchObject({value: 31 * 15, state: 'ok'});
    expect(cells[1]).toMatchObject({value: 60, state: 'ok'});
  });
  it('no daily rows for a month is a gap, never zero', () => {
    const cells = marketplaceCells(MONTHS, NOW, buckets([...rows('shopee', aug, 10), ...rows('lazada', aug, 5)]));
    expect(cells[2]).toMatchObject({value: null, state: 'gap'});
  });
  it('only one channel covered, or half a month, is partial', () => {
    const one = marketplaceCells(MONTHS, NOW, buckets(rows('shopee', aug, 10)));
    expect(one[0]).toMatchObject({value: 310, state: 'partial'});
    // a run whose window ends mid-month covers only half of it (a day inside a window with no row is a real zero, so the window matters)
    const shortWin = (r: ReturnType<typeof rows>) => r.map((x) => ({...x, window_to: '2026-08-15T16:00:00Z'}));
    const half = marketplaceCells(MONTHS, NOW, buckets(shortWin([...rows('shopee', aug.slice(0, 15), 10), ...rows('lazada', aug.slice(0, 15), 5)])));
    expect(half[0].state).toBe('partial');
  });
  it('digests not readable (null) is a gap everywhere', () => {
    for (const c of marketplaceCells(MONTHS, NOW, null)) expect(c).toMatchObject({value: null, state: 'gap'});
  });
});

describe('Total GMV', () => {
  const ok = (value: number) => ({value, state: 'ok' as const});
  const partial = (value: number) => ({value, state: 'partial' as const});
  const gap = {value: null, state: 'gap' as const};
  it('is the sum only when no channel is a gap or partial', () => {
    expect(totalCells([[ok(1)], [ok(2)], [ok(3)]])[0]).toMatchObject({value: 6, state: 'ok'});
  });
  it('a gap channel makes the total partial with the sum of the rest', () => {
    expect(totalCells([[ok(1)], [gap], [ok(3)]])[0]).toMatchObject({value: 4, state: 'partial'});
  });
  it('a partial channel makes the total partial', () => {
    expect(totalCells([[ok(1)], [partial(2)], [ok(3)]])[0]).toMatchObject({value: 6, state: 'partial'});
  });
  it('every channel a gap is a gap, never zero', () => {
    expect(totalCells([[gap], [gap], [gap]])[0]).toMatchObject({value: null, state: 'gap'});
  });
});

describe('status of a GMV cell', () => {
  const base = {direction: 'higher' as const, target: 100, phase: 'past' as const, hasSource: true};
  it('a partial actual is never red or green', () => {
    expect(metricStatus({...base, actual: 1, partial: true})).toBe('partial');
    expect(metricStatus({...base, actual: 500, partial: true})).toBe('partial');
  });
  it('a gap (null) is waiting, never red', () => {
    expect(metricStatus({...base, actual: null})).toBe('waiting');
  });
});
