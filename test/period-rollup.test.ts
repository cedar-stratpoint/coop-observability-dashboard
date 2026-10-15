import {describe, expect, it} from 'vitest';
import {buckets, dayRuns, rollupChannels, type RollupChannel, type RollupInput} from '../src/period-rollup';
import {line, mkOrder} from './support/skill-eval-fixtures';
import {cmp, digestRow, phMidnight, series, SEPTEMBER_EXPECTED, SEPTEMBER_ROWS} from './support/channel-report-fixture';

const input = (over: Partial<RollupInput>): RollupInput => ({
  fromDay: '2026-09-01', toDay: '2026-09-30', channels: ['shopee', 'lazada'], granularity: 'total', digests: SEPTEMBER_ROWS, website: null, offline: null, ...over,
});
const one = (over: Partial<RollupInput>, c: RollupChannel) => rollupChannels(input(over))[0].channels.find((x) => x.channel === c)!;

describe('F.6 test 1: overlapping digests, newest wins per channel and day, nothing double counted', () => {
  it('21 to 27 Sep is in two digests: the newer one counts, once', () => {
    expect(one({fromDay: '2026-09-21', toDay: '2026-09-27'}, 'shopee')).toMatchObject({revenue: 8400, orders: 21, units: 28, aov: 400, status: 'ok', notes: ['Shopee: per-day sales from digests Sep 21 to Sep 27, 2026 (every day covered).']});
  });
  it('a newer digest without this channel\'s daily does not hide an older one that has it', () => {
    const newer = digestRow(phMidnight('2026-09-21'), phMidnight('2026-09-28'), '2026-09-29T00:00:00.000Z', {daily: {shopee: series('2026-09-21', '2026-09-27', 1300, 3, 4)}});
    const digests = [newer, ...SEPTEMBER_ROWS];
    expect(one({fromDay: '2026-09-21', toDay: '2026-09-27', digests}, 'shopee')).toMatchObject({revenue: 9100});
    expect(one({fromDay: '2026-09-21', toDay: '2026-09-27', digests}, 'lazada')).toMatchObject({revenue: 11200, orders: 28});
  });
  it('a covered day with no sales is a zero, not a gap', () => {
    expect(one({fromDay: '2026-09-15', toDay: '2026-09-15'}, 'shopee')).toEqual({channel: 'shopee', revenue: 0, orders: 0, units: 0, aov: null, status: 'ok', notes: ['Shopee: per-day sales from digests Sep 1 to Sep 27, 2026 (every day covered).']});
  });
});

describe('F.6 test 2: PH day boundary and the exclusive end', () => {
  it('the window starting 2026-09-27T16:00Z begins on PH 28 Sep: 27 Sep comes from the week before', () => {
    expect(one({fromDay: '2026-09-27', toDay: '2026-09-27'}, 'shopee')).toMatchObject({revenue: 1200});
    expect(one({fromDay: '2026-09-28', toDay: '2026-09-28'}, 'shopee')).toMatchObject({revenue: 800});
  });
  it('the exclusive end 2026-10-04T16:00Z means 5 Oct is not covered', () => {
    expect(one({fromDay: '2026-10-05', toDay: '2026-10-05'}, 'shopee')).toMatchObject({revenue: null, status: 'no_data', notes: ['Shopee: no stored digest covers Oct 5, 2026.']});
  });
});

describe('F.6 test 3: AOV is recomputed from the sums, never averaged', () => {
  const uneven = [digestRow(phMidnight('2026-09-01'), phMidnight('2026-09-15'), '2026-09-15T01:00:00.000Z', {
    daily: {shopee: [{day: '2026-09-02', revenue: 1000, orders: 10, units: 10}, {day: '2026-09-09', revenue: 500, orders: 1, units: 1}]},
  })];
  it('two unequal weeks: 1500 / 11, not the mean of 100 and 500', () => {
    expect(one({fromDay: '2026-09-01', toDay: '2026-09-14', digests: uneven, channels: ['shopee']}, 'shopee')).toMatchObject({revenue: 1500, orders: 11, aov: 136.36});
    const weeks = rollupChannels(input({fromDay: '2026-09-01', toDay: '2026-09-14', digests: uneven, channels: ['shopee'], granularity: 'week'}));
    expect(weeks.map((b) => [b.label, b.channels[0].aov])).toEqual([['Sep 1 to Sep 6, 2026', 100], ['Sep 7 to Sep 13, 2026', 500], ['Sep 14, 2026', null]]);
  });
});

describe('F.6 test 4: gaps and windows from before `daily` existed', () => {
  it('a missing week and a pre-daily edge: the total covers the per-day days only and names the rest', () => {
    const s = one({fromDay: '2026-08-25', toDay: '2026-10-11'}, 'shopee');
    expect(s).toMatchObject({revenue: 33000, orders: 73, units: 99, aov: 452.05, status: 'partial'});
    expect(s.notes).toEqual([
      'Shopee: per-day sales from digests Sep 1 to Sep 27, 2026; Sep 21 to Sep 27, 2026; Sep 28 to Oct 4, 2026.',
      'Shopee: the totals cover Sep 1 to Oct 4, 2026 only.',
      'Shopee: no stored digest covers Oct 5 to Oct 11, 2026.',
      'Shopee: Aug 25 to Aug 31, 2026 are only in published windows that overlap or do not line up with these dates (Aug 1, 2026 08:00 to Sep 1, 2026 08:00 (PH time)), so they are not combinable.',
    ]);
  });
  it('August alone, in an 08:00 PH window and overlapping re-runs: not combinable, no figure', () => {
    const s = one({fromDay: '2026-08-01', toDay: '2026-08-31'}, 'lazada');
    expect(s).toMatchObject({revenue: null, orders: null, aov: null, status: 'not_combinable'});
    expect(s.notes[0]).toMatch(/^Lazada: Aug 1 to Aug 31, 2026 are only in published windows .*Jul 10, 2026 11:40 to Aug 9, 2026 11:40 \(PH time\).*so they are not combinable\./);
  });
  it('PH-aligned pre-daily windows that tile the missing days exactly are summed whole, and say so', () => {
    const digests = [
      digestRow(phMidnight('2026-09-08'), phMidnight('2026-09-15'), '2026-09-15T01:00:00.000Z', {daily: {shopee: series('2026-09-08', '2026-09-14', 100, 1, 1)}}),
      digestRow(phMidnight('2026-09-01'), phMidnight('2026-09-08'), '2026-09-08T01:00:00.000Z', {comparison: {shopee: cmp(2000, 4, 6)}}),
      digestRow(phMidnight('2026-09-15'), phMidnight('2026-09-22'), '2026-09-22T01:00:00.000Z', {comparison: {shopee: cmp(3000, 5, 7)}}),
    ];
    const s = one({fromDay: '2026-09-01', toDay: '2026-09-21', digests, channels: ['shopee']}, 'shopee');
    expect(s).toMatchObject({revenue: 5700, orders: 16, units: 20, aov: 356.25, status: 'ok'});
    expect(s.notes).toEqual(['Shopee: per-day sales from digests Sep 8 to Sep 14, 2026.', 'Shopee: Sep 1 to Sep 7, 2026; Sep 15 to Sep 21, 2026 come from whole published windows (Sep 1 to Sep 7, 2026; Sep 15 to Sep 21, 2026), not from per-day data.']);
  });
  it('a digest that stores an empty daily array for the channel covers its days as ok zeros', () => {
    const digests = [
      digestRow(phMidnight('2026-09-08'), phMidnight('2026-09-15'), '2026-09-15T01:00:00.000Z', {daily: {shopee: []}}),
      digestRow(phMidnight('2026-09-05'), phMidnight('2026-09-12'), '2026-09-12T01:00:00.000Z', {comparison: {shopee: cmp(2000, 4, 6)}}),
    ];
    expect(one({fromDay: '2026-09-08', toDay: '2026-09-14', digests, channels: ['shopee']}, 'shopee')).toEqual({channel: 'shopee', revenue: 0, orders: 0, units: 0, aov: null, status: 'ok', notes: ['Shopee: per-day sales from digests Sep 8 to Sep 14, 2026 (every day covered).']});
  });
  it('overlapping pre-daily windows are never summed', () => {
    const digests = [
      digestRow(phMidnight('2026-09-05'), phMidnight('2026-09-12'), '2026-09-12T01:00:00.000Z', {comparison: {shopee: cmp(2000, 4, 6)}}),
      digestRow(phMidnight('2026-09-01'), phMidnight('2026-09-08'), '2026-09-08T01:00:00.000Z', {comparison: {shopee: cmp(3000, 5, 7)}}),
    ];
    expect(one({fromDay: '2026-09-01', toDay: '2026-09-11', digests, channels: ['shopee']}, 'shopee')).toMatchObject({revenue: null, status: 'not_combinable'});
  });
});

describe('F.6 test 5: a month-boundary order at 23:59 PH', () => {
  it('23:59 PH on 30 Sep is September, 00:00 PH on 1 Oct is October, for Offline and Website alike', () => {
    const offline = {orders: [mkOrder('a', '2026-09-30T15:59:00Z', [line('P1', 'A', 1, 100)]), mkOrder('b', '2026-09-30T16:00:00Z', [line('P1', 'A', 2, 100)])], dataFrom: '2026-09-01', dataTo: '2026-10-01'};
    const website = {orders: [{createdAt: '2026-09-30T15:59:00Z', totalPrice: '300'}, {createdAt: '2026-09-30T16:00:00Z', totalPrice: '400'}], asOf: '2026-10-07T06:05:00Z'};
    const [sep, oct] = rollupChannels(input({fromDay: '2026-09-01', toDay: '2026-10-31', channels: ['website', 'offline'], granularity: 'month', website, offline}));
    expect([sep.label, oct.label]).toEqual(['Sep 1 to Sep 30, 2026', 'Oct 1 to Oct 31, 2026']);
    expect(sep.channels).toEqual([
      {channel: 'website', revenue: 300, orders: 1, units: null, aov: 300, status: 'ok', notes: ['Website: live CRM orders as of Oct 7, 2026 14:05 (PH time).', 'Website: units unknown (CRM orders carry no line items).']},
      {channel: 'offline', revenue: 100, orders: 1, units: 1, aov: 100, status: 'ok', notes: []},
    ]);
    expect(oct.channels.map((c) => c.revenue)).toEqual([400, 200]);
  });
});

describe('F.6 test 6: one month against a hand-computed total (the golden "September report per channel")', () => {
  it('September 2026 per channel from the PROD-shaped digests', () => {
    const [b] = rollupChannels(input({}));
    expect(b.channels).toEqual([
      {channel: 'shopee', ...SEPTEMBER_EXPECTED.shopee, status: 'ok', notes: ['Shopee: per-day sales from digests Sep 1 to Sep 27, 2026; Sep 21 to Sep 27, 2026; Sep 28 to Oct 4, 2026 (every day covered).']},
      {channel: 'lazada', ...SEPTEMBER_EXPECTED.lazada, status: 'ok', notes: ['Lazada: per-day sales from digests Sep 1 to Sep 27, 2026; Sep 21 to Sep 27, 2026; Sep 28 to Oct 4, 2026 (every day covered).']},
    ]);
  });
});

describe('edges', () => {
  it('Website not connected, CRM empty, POS not loaded, POS starting late, digests unreadable: honest notes, never a false zero', () => {
    const get = (over: Partial<RollupInput>, c: RollupChannel) => one({channels: [c], ...over}, c);
    expect(get({}, 'website')).toMatchObject({revenue: null, status: 'not_connected', notes: ['Website: the website CRM is not connected, so there are no Website figures.']});
    expect(get({website: {orders: [], asOf: '2026-10-07T06:05:00Z'}}, 'website')).toMatchObject({revenue: null, status: 'no_data'});
    expect(get({}, 'offline')).toMatchObject({revenue: null, status: 'not_connected'});
    const late = {orders: [mkOrder('c', '2026-09-10T02:00:00Z', [line('P1', 'A', 1, 100)]), mkOrder('v', '2026-09-11T02:00:00Z', [line('P1', 'A', 1, 999)], {status: 'voided'})], dataFrom: '2026-09-07', dataTo: '2026-09-27'};
    expect(get({offline: late}, 'offline')).toMatchObject({revenue: 100, orders: 1, status: 'partial', notes: ['Offline: POS data starts Sep 7, 2026; the days before it have no POS data.']});
    expect(get({digests: null}, 'shopee')).toMatchObject({revenue: null, status: 'not_connected', notes: ['Shopee: the stored digests are not available right now.']});
  });
  it('buckets: weeks Monday to Sunday and calendar months, clipped to the range; day runs', () => {
    expect(buckets('2026-09-15', '2026-11-10', 'month')).toEqual([['2026-09-15', '2026-09-30'], ['2026-10-01', '2026-10-31'], ['2026-11-01', '2026-11-10']]);
    expect(buckets('2026-08-31', '2026-09-13', 'week')).toEqual([['2026-08-31', '2026-09-06'], ['2026-09-07', '2026-09-13']]);
    expect(dayRuns(['2026-09-03', '2026-09-01', '2026-09-02', '2026-09-05'])).toBe('Sep 1 to Sep 3, 2026; Sep 5, 2026');
  });
});
