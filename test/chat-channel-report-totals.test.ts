import {describe, expect, it} from 'vitest';
import {reportTotals, shapeChannelReport, totalOf} from '../src/chat/channel-report';
import type {ChannelPeriod, RollupChannel} from '../src/period-rollup';
import {SEPTEMBER_ROWS} from './support/channel-report-fixture';

const p = (channel: RollupChannel, revenue: number | null, orders: number | null, units: number | null, status: ChannelPeriod['status'] = 'ok'): ChannelPeriod => ({
  channel, revenue, orders, units, aov: revenue !== null && orders ? revenue / orders : null, status, notes: [],
});
const ALL4 = ['shopee', 'lazada', 'website', 'offline'] as const;
const FOUR = [p('shopee', 59228.1, 120, 300), p('lazada', 11222.2, 30, 45), p('website', 6900.3, 10, 12), p('offline', 4000.4, 8, 20)];

describe('code totals across channels (whole centavos)', () => {
  it('sums to the exact centavo with no float drift and says complete', () => {
    const [online, all] = reportTotals(ALL4, FOUR);
    expect(online.label).toBe('Online total');
    expect(online.revenue).toBe(77350.6); // 59228.1 + 11222.2 + 6900.3, summed as 7735060 centavos
    expect(online.orders).toBe(160);
    expect(online.units).toBe(357);
    expect(all.label).toBe('All channels');
    expect(all.revenue).toBe(81351);
    expect(all.orders).toBe(168);
    expect(all.status).toBe('complete');
    expect(all.channels_excluded).toEqual([]);
    expect(all.calculated_in_code).toBe(true);
    expect(all.note).toMatch(/calculated in code/);
  });
  it('0.1 + 0.2 style values add exactly', () => {
    const t = totalOf('All channels', [p('shopee', 0.1, 1, 1), p('lazada', 0.2, 1, 1)]);
    expect(t.revenue).toBe(0.3);
  });
  it('AOV is revenue / orders of the totals, not an average of the AOVs', () => {
    const t = totalOf('All channels', [p('shopee', 1000, 1, 1), p('lazada', 100, 99, 99)]);
    expect(t.aov).toBe(11); // 1100 / 100; an average of 1000 and ~1.01 would be ~500
  });
  it('a channel that is not ok is named as left out and makes both totals partial', () => {
    const periods = [p('shopee', 100, 2, 3), p('lazada', 50, 1, 1), p('website', null, null, null, 'not_connected'), p('offline', 25, 1, 1)];
    const [online, all] = reportTotals(ALL4, periods);
    expect(online.status).toBe('partial');
    expect(all.status).toBe('partial');
    expect(all.channels_excluded).toEqual([{channel: 'Website', reason: 'is not connected'}]);
    expect(all.channels_included).toEqual(['Shopee', 'Lazada', 'Offline']);
    expect(all.revenue).toBe(175);
    expect(all.note).toMatch(/Partial total of Shopee, Lazada and Offline only\. Left out: Website is not connected/);
  });
  it('a partly covered channel is left out too, with its reason', () => {
    const t = totalOf('All channels', [p('shopee', 100, 2, 3), p('lazada', 40, 1, 1, 'partial')]);
    expect(t.status).toBe('partial');
    expect(t.channels_excluded[0]).toEqual({channel: 'Lazada', reason: 'only part of these dates is covered'});
  });
  it('online complete but Offline missing: Online total complete, All channels partial', () => {
    const periods = [p('shopee', 100, 2, 3), p('lazada', 50, 1, 1), p('website', 20, 1, 1), p('offline', null, null, null, 'no_data')];
    const [online, all] = reportTotals(ALL4, periods);
    expect(online.status).toBe('complete');
    expect(online.revenue).toBe(170);
    expect(all.status).toBe('partial');
    expect(all.channels_excluded[0].channel).toBe('Offline');
  });
  it('no order at all gives a null AOV, no channel complete gives a null total', () => {
    expect(totalOf('All channels', [p('shopee', 0, 0, 0), p('lazada', 0, 0, 0)]).aov).toBeNull();
    const none = totalOf('All channels', [p('shopee', null, null, null, 'no_data'), p('lazada', null, null, null, 'not_connected')]);
    expect(none.revenue).toBeNull();
    expect(none.status).toBe('partial');
    expect(none.note).toMatch(/^No total:/);
  });
  it('units are null (and said so) when an included channel has no unit count', () => {
    const t = totalOf('All channels', [p('shopee', 100, 2, null), p('lazada', 50, 1, 1)]);
    expect(t.units).toBeNull();
    expect(t.note).toMatch(/Units are left out/);
  });
  it('only the requested channels count: two channels give one total labelled as the requested ones', () => {
    const res = reportTotals(['shopee', 'lazada'], FOUR);
    expect(res).toHaveLength(1);
    expect(res[0].label).toBe('Total of the requested channels');
    expect(res[0].channels_included).toEqual(['Shopee', 'Lazada']);
    expect(reportTotals(['shopee'], FOUR)).toEqual([]);
  });
});

describe('totals ride in meta, the rows stay one per channel', () => {
  const ask = (granularity: 'total' | 'week') => shapeChannelReport({from: '2026-09-01', to: '2026-09-30', channels: [...ALL4], granularity}, {digests: SEPTEMBER_ROWS, mock: false, website: null, data: null});
  it('granularity total: meta.totals present, rows unchanged (4 channels, no total row to double count in a chart)', () => {
    const r = ask('total');
    expect(r.rows.map((x) => x.channel)).toEqual(['Shopee', 'Lazada', 'Website', 'Offline']);
    expect(r.meta.totals?.map((t) => t.label)).toEqual(['Online total', 'All channels']);
    expect(r.meta.totals?.every((t) => t.status === 'partial')).toBe(true); // Website and Offline have no data here
    expect(r.meta.totals?.[1].channels_excluded.map((e) => e.channel)).toEqual(['Website', 'Offline']);
  });
  it('week granularity builds no totals', () => {
    expect(ask('week').meta.totals).toBeUndefined();
  });
});
