import {describe, expect, it} from 'vitest';
import {
  CRM_ORDERS_CAP, collectOrderPages, crmCoverage, eventsCells, marketplaceCells, phMonthKey, totalCells, websiteCells, orderGross, MISSING_LINES_NOTE, NO_LINES_NOTE,
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

describe('orderGross (Shopify "Gross sales": line price x quantity, before discounts, returns, shipping and tax)', () => {
  it('sums price x quantity over the lines', () => {
    expect(orderGross({lines: [{price: 250, quantity: 2}, {price: 99.5, quantity: 1}]})).toBe(599.5);
  });
  it('reads a string price or quantity (the Worker may send either)', () => {
    expect(orderGross({lines: [{price: '250.00', quantity: '2'}, {price: 99.5, quantity: 1}]})).toBe(599.5);
  });
  it('a free line (price 0) is a real zero', () => {
    expect(orderGross({lines: [{price: 0, quantity: 1}, {price: '100', quantity: 1}]})).toBe(100);
  });
  it.each([
    ['no lines field', {}],
    ['lines null', {lines: null}],
    ['an empty lines array (a Shopify order always has a line)', {lines: []}],
    ['a line with no price', {lines: [{price: 100, quantity: 1}, {price: null, quantity: 1}]}],
    ['a line with an unreadable price', {lines: [{price: 'abc', quantity: 1}]}],
    ['a line with no quantity (the Worker sends 0 for a missing one)', {lines: [{price: 100, quantity: 0}]}],
    ['a line with an unreadable quantity', {lines: [{price: 100, quantity: 'x'}]}],
  ])('%s -> null (unknown, never a low number)', (_label, order) => {
    expect(orderGross(order as never)).toBeNull();
  });
});

describe('Website GMV by month (Shopify gross sales, every order)', () => {
  const line = (price: number | string, quantity: number | string = 1) => ({price, quantity});
  const o = (id: string, createdAt: string, lines: unknown, financialStatus: string | null = 'paid', totalPrice: string | null = '999999') =>
    ({shopifyOrderId: id, createdAt, totalPrice, financialStatus, lines}) as never;
  const orders = [
    o('1', '2026-08-05T04:00:00Z', [line(500.25, 2)]),
    o('2', '2026-08-31T23:59:00+08:00', [line('200')]),
    o('3', '2026-09-01T00:00:00+08:00', [line(300)]),
    o('4', '2026-09-02T04:00:00Z', [line(40)], 'refunded'),
    o('5', '2026-09-03T04:00:00Z', [line(5)], 'voided'),
    o('6', '2026-09-04T04:00:00Z', [line(50)], 'partially_refunded'),
    o('7', '2026-09-05T04:00:00Z', [line(1)], 'expired'),
    o('8', '2026-09-06T04:00:00Z', [line(2)], null),
  ];
  it('sums line gross into the PH month, never the order total', () => {
    const cells = websiteCells(MONTHS, NOW, {orders, truncated: false});
    expect(cells[0]).toMatchObject({value: 1200.5, state: 'ok'});
  });
  it('discounts, shipping and tax are not in it: an order whose total is lower (discount) or higher (shipping + tax) still counts its line gross', () => {
    const discounted = o('d', '2026-09-02T04:00:00Z', [line(1000)], 'paid', '800.00');
    const shipped = o('s', '2026-09-02T04:00:00Z', [line(1000)], 'paid', '1250.00');
    expect(websiteCells(['2026-09-01'], '2026-10', {orders: [discounted, shipped], truncated: false})[0]).toMatchObject({value: 2000, state: 'ok'});
  });
  it('counts every order like Shopify: refunded, voided, expired, partially refunded and unknown status all count, with no overstate note', () => {
    const cells = websiteCells(MONTHS, NOW, {orders, truncated: false});
    expect(cells[1]).toMatchObject({value: 398, state: 'ok'});
    expect(cells[1].note).toBeUndefined();
  });
  it('an order with no usable lines makes its month partial (grey) with a note; other months stay ok', () => {
    const withHole = [...orders, o('9', '2026-09-07T04:00:00Z', [{price: null, quantity: 1}]), o('10', '2026-09-08T04:00:00Z', undefined)];
    const cells = websiteCells(MONTHS, NOW, {orders: withHole, truncated: false});
    expect(cells[1]).toMatchObject({value: 398, state: 'partial', note: MISSING_LINES_NOTE});
    expect(cells[0]).toMatchObject({value: 1200.5, state: 'ok'});
    expect(MISSING_LINES_NOTE).toMatch(/line items/);
  });
  it('a legacy Worker that ignores lines=1 (no order has lines): every month is a gap with a note, never PHP 0', () => {
    const legacy = [o('a', '2026-08-05T04:00:00Z', undefined), o('b', '2026-09-05T04:00:00Z', undefined)];
    for (const c of websiteCells(MONTHS, NOW, {orders: legacy, truncated: false})) expect(c).toMatchObject({value: null, state: 'gap', note: NO_LINES_NOTE});
    expect(NO_LINES_NOTE).toMatch(/line items/);
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
    const cut = [o('a', '2026-09-10T04:00:00Z', [line(100)]), o('b', '2026-10-10T04:00:00Z', [line(40)])];
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

describe('collectOrderPages (paged CRM read)', () => {
  const pages = (list: {orders: number[]; nextCursor: string | null | undefined}[]) => {
    const seen: (string | null)[] = [];
    const fetchPage = async (cursor: string | null) => {
      seen.push(cursor);
      return list[seen.length - 1];
    };
    return {fetchPage, seen};
  };

  it('follows next_cursor until it is null and reports a complete read', async () => {
    const {fetchPage, seen} = pages([{orders: [1, 2], nextCursor: 'a'}, {orders: [3], nextCursor: 'b'}, {orders: [4], nextCursor: null}]);
    const r = await collectOrderPages(fetchPage, 40);
    expect(r).toEqual({orders: [1, 2, 3, 4], complete: true, legacy: false});
    expect(seen).toEqual([null, 'a', 'b']);
  });

  it('stops at the page ceiling and says the read is incomplete', async () => {
    const {fetchPage, seen} = pages([{orders: [1], nextCursor: 'a'}, {orders: [2], nextCursor: 'b'}, {orders: [3], nextCursor: 'c'}]);
    const r = await collectOrderPages(fetchPage, 2);
    expect(r).toEqual({orders: [1, 2], complete: false, legacy: false});
    expect(seen).toHaveLength(2);
  });

  it('a response with no next_cursor field is the old Worker (newest 1000), flagged legacy', async () => {
    const {fetchPage, seen} = pages([{orders: [1, 2], nextCursor: undefined}]);
    const r = await collectOrderPages(fetchPage, 40);
    expect(r).toEqual({orders: [1, 2], complete: true, legacy: true});
    expect(seen).toHaveLength(1);
  });

  it('a page that throws rejects the whole read, never a partial sum', async () => {
    let n = 0;
    const fetchPage = async () => {
      if (++n === 2) throw new Error('CRM 500');
      return {orders: [1], nextCursor: 'a' as string | null | undefined};
    };
    await expect(collectOrderPages(fetchPage, 40)).rejects.toThrow('CRM 500');
  });
});
