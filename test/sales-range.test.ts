import {describe, expect, it} from 'vitest';
import {adsTotals, buildSalesRange, isRangeRequest, offlineInput, resolveSpan, spanScopeLabel, snapToWeeks, sumTotals} from '../src/sales-range';
import {spanAds} from '../src/span-windows';
import {cmp, digestRow, phMidnight, series} from './support/channel-report-fixture';
import {addDaysKey} from '../src/chat/range';

// Tue 20 Oct 2026 (PH). The last finished Sunday is 18 Oct. Data starts 1 Sep.
const bounds = {firstDay: '2026-09-01', todayDay: '2026-10-20'};

// Shopee's ad export carries its own dates; here the same Monday to Sunday as the digest.
const withShopeeAds = <T extends {digest: object}>(from: string, to: string, row: T): T => {
  (row.digest as Record<string, unknown>).shopee = {ads: {headline: '', figures: [], recommendations: [], window: {from, to: addDaysKey(to, -1), label: ''}}};
  return row;
};

describe('resolveSpan', () => {
  it('uses the dates in the URL', () => {
    expect(resolveSpan({from: '2026-10-07', to: '2026-10-14'}, bounds)).toMatchObject({fromDay: '2026-10-07', toDay: '2026-10-14', all: false, note: null});
  });
  it('swaps reversed dates and allows a single day', () => {
    expect(resolveSpan({from: '2026-10-14', to: '2026-10-07'}, bounds)).toMatchObject({fromDay: '2026-10-07', toDay: '2026-10-14'});
    expect(resolveSpan({from: '2026-10-07', to: '2026-10-07'}, bounds)).toMatchObject({fromDay: '2026-10-07', toDay: '2026-10-07'});
  });
  it('clamps to the first data day and to today, and says so', () => {
    const r = resolveSpan({from: '2026-01-01', to: '2026-12-31'}, bounds);
    expect(r).toMatchObject({fromDay: '2026-09-01', toDay: '2026-10-20'});
    expect(r.note).toContain('Sep 1, 2026');
  });
  it('says both when the start and the end are moved', () => {
    const r = resolveSpan({from: '2020-01-01', to: '2030-01-01'}, bounds);
    expect(r.note).toContain('Sep 1, 2026');
    expect(r.note).toContain('after today');
  });
  it('span=all is the whole archive up to today', () => {
    expect(resolveSpan({span: 'all'}, bounds)).toMatchObject({fromDay: '2026-09-01', toDay: '2026-10-20', all: true});
  });
  it('falls back to the last 4 finished weeks for missing, junk or fully out-of-range dates', () => {
    const def = {fromDay: '2026-09-21', toDay: '2026-10-18', all: false};
    expect(resolveSpan({}, bounds)).toMatchObject(def);
    expect(resolveSpan({from: 'nope', to: '2026-10-01'}, bounds)).toMatchObject(def);
    expect(resolveSpan({from: '2026-02-30', to: '2026-10-01'}, bounds)).toMatchObject(def);
    expect(resolveSpan({from: '2027-01-01', to: '2027-01-09'}, bounds)).toMatchObject(def);
  });
  it('the default never starts before the first data day', () => {
    expect(resolveSpan({}, {firstDay: '2026-10-05', todayDay: '2026-10-20'})).toMatchObject({fromDay: '2026-10-05', toDay: '2026-10-18'});
  });
  it('when today is a Sunday the default ends the Sunday before (today is not finished)', () => {
    expect(resolveSpan({}, {firstDay: '2026-08-01', todayDay: '2026-10-18'})).toMatchObject({toDay: '2026-10-11'});
  });
});

describe('snapToWeeks', () => {
  it('rounds start down to Monday and end up to Sunday', () => {
    expect(snapToWeeks('2026-10-07', '2026-10-14', bounds)).toEqual({fromDay: '2026-10-05', toDay: '2026-10-18'});
  });
  it('stops at the last finished Sunday when the end week is still running', () => {
    expect(snapToWeeks('2026-10-07', '2026-10-20', bounds)).toEqual({fromDay: '2026-10-05', toDay: '2026-10-18'});
  });
  it('is null when the dates already line up', () => {
    expect(snapToWeeks('2026-10-05', '2026-10-18', bounds)).toBeNull();
  });
  it('is null when no finished week contains the dates', () => {
    expect(snapToWeeks('2026-10-19', '2026-10-20', bounds)).toBeNull();
  });
  it('never starts before the first data day', () => {
    expect(snapToWeeks('2026-09-02', '2026-09-10', bounds)).toEqual({fromDay: '2026-09-01', toDay: '2026-09-13'});
  });
});

describe('buildSalesRange', () => {
  const wk = (from: string, to: string, created: string, spend: number, roas: number, rev: number) =>
    withShopeeAds(from, to, digestRow(phMidnight(from), phMidnight(to), created, {
      daily: {shopee: series(from, from === '2026-10-05' ? '2026-10-11' : '2026-10-18', rev / 7, 1, 2), lazada: series(from, from === '2026-10-05' ? '2026-10-11' : '2026-10-18', rev / 7, 1, 2)},
      comparison: {shopee: {...cmp(rev, 7, 14), adSpend: spend, roas}, lazada: {...cmp(rev, 7, 14), adSpend: spend * 3, roas: roas * 2}},
    }));
  const rows = [wk('2026-10-12', '2026-10-19', '2026-10-19T01:00:00.000Z', 300, 4, 700), wk('2026-10-05', '2026-10-12', '2026-10-12T01:00:00.000Z', 100, 2, 700)];
  const base = {digests: rows, website: null, offline: null, ...bounds};

  it('adds the channels that have data and recomputes AOV from the totals', () => {
    const v = buildSalesRange({...base, span: {from: '2026-10-05', to: '2026-10-18'}});
    expect(v.totals).toMatchObject({revenue: 2800, orders: 28});
    expect(v.totals.aov).toBe(100);
    expect(v.label).toBe('Oct 5 to Oct 18, 2026');
    expect(v.dayCount).toBe(14);
  });
  it('weights ROAS across channels and windows, and tags every ad number', () => {
    const v = buildSalesRange({...base, span: {from: '2026-10-05', to: '2026-10-18'}});
    expect(v.ads.shopee).toMatchObject({spend: 400, roas: 3.5});
    expect(v.ads.lazada).toMatchObject({spend: 1200, roas: 7});
    expect(v.ads.total.spend).toBe(1600);
    expect(v.ads.total.roas).toBe(6.13); // (400*3.5 + 1200*7) / 1600
    expect(v.ads.total.tag).toEqual({kind: 'ex', text: '2 full windows'});
    // what was used is a quiet source note, not an amber gap
    expect(v.sources.join(' ')).toContain('2 full windows inside these dates');
    expect(v.notes.join(' ')).not.toContain('2 full windows inside these dates');
  });
  it('a span that cuts a week keeps sales exact but ads only from the full window, and offers a snap', () => {
    const v = buildSalesRange({...base, span: {from: '2026-10-07', to: '2026-10-18'}});
    expect(v.totals.revenue).toBe(2400); // 5 + 7 days of 100/day, per channel
    expect(v.ads.shopee).toMatchObject({spend: 300});
    expect(v.ads.total.tag.kind).toBe('wk');
    expect(v.snap).toEqual({fromDay: '2026-10-05', toDay: '2026-10-18', label: 'Oct 5 to Oct 18, 2026'});
    expect(v.notes.join(' ')).toContain('only partly inside');
  });
  it('says "none", not zero, when no full ad window is inside', () => {
    const v = buildSalesRange({...base, span: {from: '2026-10-07', to: '2026-10-10'}});
    expect(v.ads.total).toMatchObject({spend: null, roas: null, tag: {kind: 'none'}});
  });
  it('lists website products from orders and keeps marketplace products separate', () => {
    const orders = [{createdAt: '2026-10-06T02:00:00.000Z', totalPrice: '500', lineItems: [{title: 'Meaty Treats', quantity: 2, price: 250}]}];
    const v = buildSalesRange({...base, website: {orders, asOf: '2026-10-20T01:00:00.000Z'}, span: {from: '2026-10-05', to: '2026-10-18'}});
    expect(v.products.website).toEqual([{title: 'Meaty Treats', revenue: 500, units: 2}]);
    expect(v.channels.find((c) => c.channel === 'website')).toMatchObject({revenue: 500, orders: 1});
    expect(v.products.shopee.status).toBe('none');
  });
  it('an empty archive still builds, with the channels saying there is no data', () => {
    const v = buildSalesRange({digests: [], website: null, offline: null, span: {}, firstDay: '2026-10-01', todayDay: '2026-10-20'});
    expect(v.totals).toMatchObject({revenue: null, orders: null, aov: null});
    expect(v.channels.every((c) => c.revenue === null)).toBe(true);
  });
});

describe('selection helpers the page uses on the client', () => {
  it('sumTotals ignores channels with no figures and leaves units unknown if any channel has none', () => {
    const ch = (channel: string, revenue: number | null, orders: number | null, units: number | null) => ({channel, revenue, orders, units, aov: null, status: 'ok', notes: []}) as never;
    expect(sumTotals([ch('shopee', 100, 2, 4), ch('lazada', 50, 1, null), ch('offline', null, null, null)])).toEqual({revenue: 150, orders: 3, aov: 50, units: null});
    expect(sumTotals([])).toEqual({revenue: null, orders: null, aov: null, units: null});
  });
  it('adsTotals over one marketplace is that marketplace, and "wk" if another selected one has no window', () => {
    const rows = [withShopeeAds('2026-10-05', '2026-10-12', digestRow(phMidnight('2026-10-05'), phMidnight('2026-10-12'), '2026-10-12T01:00:00.000Z', {comparison: {shopee: {...cmp(700, 7, 14), adSpend: 100, roas: 2}}}))];
    const s = spanAds('shopee', '2026-10-05', '2026-10-11', rows);
    const l = spanAds('lazada', '2026-10-05', '2026-10-11', []);
    expect(adsTotals([s], '2026-10-05', '2026-10-11')).toMatchObject({spend: 100, roas: 2, tag: {kind: 'ex', text: '1 full window'}});
    expect(adsTotals([s, l], '2026-10-05', '2026-10-11').tag.kind).toBe('wk');
  });
  it('offlineInput finds the first and last PH day with an order', () => {
    const o = (iso: string) => ({created_at: iso}) as never;
    expect(offlineInput([o('2026-10-06T02:00:00.000Z'), o('2026-10-04T17:00:00.000Z')])).toMatchObject({dataFrom: '2026-10-05', dataTo: '2026-10-06'});
    expect(offlineInput([])).toMatchObject({dataFrom: null});
    expect(offlineInput(null)).toBeNull();
  });
});

describe('the Sales page picks the range view only when the link asks for it', () => {
  it('two real dates, or span=all', () => {
    expect(isRangeRequest({from: '2026-10-05', to: '2026-10-18'})).toBe(true);
    expect(isRangeRequest({span: 'all'})).toBe(true);
  });
  it('anything else is the weekly view', () => {
    expect(isRangeRequest({})).toBe(false);
    expect(isRangeRequest({from: '2026-10-05'})).toBe(false);
    expect(isRangeRequest({from: 'nope', to: '2026-10-18'})).toBe(false);
    expect(isRangeRequest({from: '2026-02-30', to: '2026-03-02'})).toBe(false);
    expect(isRangeRequest({span: 'week'})).toBe(false);
  });
});

describe('spanScopeLabel: what the chat drawer says it is answering about', () => {
  it('names the span, or all time with its dates', () => {
    expect(spanScopeLabel({from: '2026-10-05', to: '2026-10-18'}, bounds)).toBe('Oct 5 to Oct 18, 2026');
    expect(spanScopeLabel({span: 'all'}, bounds)).toBe('Sep 1 to Oct 20, 2026 (all time)');
  });
  it('uses the dates as they are resolved (swapped, clamped)', () => {
    expect(spanScopeLabel({from: '2026-10-18', to: '2026-10-05'}, bounds)).toBe('Oct 5 to Oct 18, 2026');
    expect(spanScopeLabel({from: '2025-01-01', to: '2026-10-05'}, bounds)).toBe('Sep 1 to Oct 5, 2026');
  });
  it('is null when no dates are picked, so the weekly label stays', () => {
    expect(spanScopeLabel({}, bounds)).toBeNull();
    expect(spanScopeLabel({from: 'nope', to: '2026-10-05'}, bounds)).toBeNull();
  });
});
