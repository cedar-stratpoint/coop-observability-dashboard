import {describe, expect, it} from 'vitest';
import {spanAds, spanTopProducts, type WindowDigest} from '../src/span-windows';
import {phMidnight} from './support/channel-report-fixture';
import {addDaysKey} from '../src/chat/range';

const week = (from: string, to: string, created: string, over: Record<string, unknown> = {}): WindowDigest => ({
  window_from: phMidnight(from),
  window_to: phMidnight(to),
  created_at: created,
  digest: {
    comparison: {shopee: {revenue: 1, orders: 1, aov: 1, units: 1, adSpend: 100, roas: 2}, lazada: {revenue: 1, orders: 1, aov: 1, units: 1, adSpend: 300, roas: 4}},
    // Shopee's ad export carries its own dates (here the same Monday to Sunday as the digest).
    shopee: {ads: {headline: '', figures: [], recommendations: [], window: {from, to: addDaysKey(to, -1), label: ''}}},
    ...over,
  },
});
const W1 = week('2026-10-05', '2026-10-12', '2026-10-12T01:00:00.000Z');
const W2 = week('2026-10-12', '2026-10-19', '2026-10-19T01:00:00.000Z');

describe('spanAds: full windows inside the span', () => {
  it('adds spend and weights ROAS by spend, never averages it', () => {
    const r = spanAds('lazada', '2026-10-05', '2026-10-18', [W1, W2]);
    expect(r).toMatchObject({status: 'ok', spend: 600, roas: 4});
    const mixed = week('2026-10-12', '2026-10-19', '2026-10-19T01:00:00.000Z', {comparison: {shopee: {revenue: 1, orders: 1, aov: 1, units: 1, adSpend: 300, roas: 4}}});
    const s = spanAds('shopee', '2026-10-05', '2026-10-18', [W1, mixed]);
    expect(s.spend).toBe(400);
    expect(s.roas).toBe(3.5); // (100*2 + 300*4) / 400, not (2 + 4) / 2
    expect(s.windows.map((w) => w.label)).toEqual(['Oct 5 to Oct 11, 2026', 'Oct 12 to Oct 18, 2026']);
  });

  it('leaves out a week the dates cut, and names it', () => {
    const r = spanAds('shopee', '2026-10-07', '2026-10-18', [W1, W2]);
    expect(r.windows).toHaveLength(1);
    expect(r.spend).toBe(100);
    expect(r.skipped).toEqual([expect.objectContaining({reason: 'outside', label: 'Oct 5 to Oct 11, 2026'})]);
    expect(r.notes.join(' ')).toContain('Oct 5 to Oct 11, 2026');
  });

  it('says "none" instead of 0 when no full window is inside', () => {
    const r = spanAds('shopee', '2026-10-07', '2026-10-10', [W1]);
    expect(r).toMatchObject({status: 'none', spend: null, roas: null});
  });

  it('ignores digests that do not touch the span at all', () => {
    const r = spanAds('shopee', '2026-10-12', '2026-10-18', [W1, W2]);
    expect(r.skipped).toEqual([]);
    expect(r.windows).toHaveLength(1);
  });

  it('counts spend but not ROAS when a week has no ROAS', () => {
    const noRoas = week('2026-10-12', '2026-10-19', '2026-10-19T01:00:00.000Z', {comparison: {shopee: {revenue: 1, orders: 1, aov: 1, units: 1, adSpend: 50, roas: null}}});
    const r = spanAds('shopee', '2026-10-05', '2026-10-18', [W1, noRoas]);
    expect(r.spend).toBe(150);
    expect(r.roas).toBe(2); // only the week that has a ROAS
    expect(r.notes.join(' ')).toContain('no ROAS');
  });

  it('skips a week with no ad figures and names it', () => {
    const none = week('2026-10-12', '2026-10-19', '2026-10-19T01:00:00.000Z', {comparison: {shopee: {revenue: 1, orders: 1, aov: 1, units: 1, adSpend: null, roas: null}}});
    const r = spanAds('shopee', '2026-10-05', '2026-10-18', [W1, none]);
    expect(r.spend).toBe(100);
    expect(r.skipped).toEqual([expect.objectContaining({reason: 'no_figures'})]);
  });
});

describe('spanAds: re-runs and overlaps are never double counted', () => {
  it('keeps the newest of two re-runs of one week', () => {
    const rerun = week('2026-10-05', '2026-10-12', '2026-10-13T01:00:00.000Z', {comparison: {shopee: {revenue: 1, orders: 1, aov: 1, units: 1, adSpend: 120, roas: 2}}});
    const r = spanAds('shopee', '2026-10-05', '2026-10-11', [W1, rerun]);
    expect(r.spend).toBe(120);
    expect(r.skipped).toEqual([expect.objectContaining({reason: 'rerun'})]);
    expect(spanAds('shopee', '2026-10-05', '2026-10-11', [rerun, W1]).spend).toBe(120); // input order does not matter
  });

  it('uses each Shopee ad export own window, not the digest window (real staging rows)', () => {
    // Three July digests made 2026-09-07: Shopee ads windows of 32, 31 and 14 days that all overlap.
    const row = (from: string, to: string, adFrom: string, adTo: string, spend: number, roas: number) => ({
      window_from: from, window_to: to, created_at: '2026-09-07T03:19:04.798Z',
      digest: {comparison: {shopee: {revenue: 1, orders: 1, aov: 1, units: null, adSpend: spend, roas}}, shopee: {ads: {headline: '', figures: [], recommendations: [], window: {from: adFrom, to: adTo, label: ''}}}},
    }) as WindowDigest;
    const rows = [
      row('2026-07-13T04:33:26.349Z', '2026-08-12T04:33:26.349Z', '2026-07-12', '2026-08-12', 46648.1, 2.56),
      row('2026-07-10T11:07:17.880Z', '2026-08-09T11:07:17.880Z', '2026-07-09', '2026-08-09', 49859.63, 2.53),
      row('2026-07-10T10:50:01.066Z', '2026-08-09T10:50:01.066Z', '2026-07-20', '2026-08-02', 16017.34, 2.29),
    ];
    const r = spanAds('shopee', '2026-07-01', '2026-08-31', rows);
    expect(r.windows).toHaveLength(1); // the three overlap, so only one counts
    expect(r.spend).toBe(46648.1); // tie on created_at: the one that ends last
    expect(r.skipped.map((s) => s.reason)).toEqual(['overlap', 'overlap']);
    // A span inside the 14-day window counts nothing: that export is not fully inside it.
    expect(spanAds('shopee', '2026-07-20', '2026-07-31', rows)).toMatchObject({status: 'none', spend: null});
  });

  it('falls back to the digest window when the channel has no ads window (Lazada)', () => {
    const r = spanAds('lazada', '2026-10-05', '2026-10-11', [W1]);
    expect(r.windows).toEqual([expect.objectContaining({from: '2026-10-05', to: '2026-10-11', spend: 300})]);
  });
});

const sku = (title: string, revenue: number, units: number) => ({title, revenue, units});
const withList = (w: WindowDigest, ch: 'shopee' | 'lazada', list: ReturnType<typeof sku>[], window?: {from: string; to: string; label: string}): WindowDigest =>
  ({...w, digest: {...w.digest, [ch]: {sales: {headline: '', figures: [], recommendations: [], topProducts: list, ...(window ? {window} : {})}}}});

describe('spanTopProducts: merge the lists of full windows inside the span', () => {
  const a = withList(W1, 'lazada', [sku('Meaty Treats', 100, 5), sku('Joint Chews', 80, 4)]);
  const b = withList(W2, 'lazada', [sku('meaty treats ', 50, 2), sku('Salmon Crunch', 70, 3)]);

  it('sums by title (case and spaces ignored), ranks by revenue, and says it is approximate', () => {
    const r = spanTopProducts('lazada', '2026-10-05', '2026-10-18', [a, b]);
    expect(r.products).toEqual([sku('Meaty Treats', 150, 7), sku('Joint Chews', 80, 4), sku('Salmon Crunch', 70, 3)]);
    expect(r.approximate).toBe(true);
    expect(r.notes[0]).toContain('6th every time');
  });

  it('is exact (not approximate) when only one window is used', () => {
    const r = spanTopProducts('lazada', '2026-10-05', '2026-10-11', [a, b]);
    expect(r).toMatchObject({approximate: false, products: [sku('Meaty Treats', 100, 5), sku('Joint Chews', 80, 4)]});
  });

  it('keeps only the top N', () => {
    const r = spanTopProducts('lazada', '2026-10-05', '2026-10-18', [a, b], 2);
    expect(r.products.map((p) => p.title)).toEqual(['Meaty Treats', 'Joint Chews']);
  });

  it('leaves out a window the dates cut, and says "none" when nothing is inside', () => {
    expect(spanTopProducts('lazada', '2026-10-07', '2026-10-18', [a, b]).skipped).toEqual([expect.objectContaining({reason: 'outside'})]);
    expect(spanTopProducts('lazada', '2026-10-07', '2026-10-10', [a])).toMatchObject({status: 'none', products: []});
  });

  it('places Shopee by the sales export window and falls back to the products facet', () => {
    const thirty = withList(W1, 'shopee', [sku('Meaty Treats', 900, 30)], {from: '2026-09-12', to: '2026-10-11', label: ''});
    expect(spanTopProducts('shopee', '2026-10-01', '2026-10-18', [thirty]).status).toBe('none'); // the 30-day export starts before the span
    expect(spanTopProducts('shopee', '2026-09-01', '2026-10-18', [thirty]).products).toEqual([sku('Meaty Treats', 900, 30)]);
    const viaProducts = {...W1, digest: {shopee: {products: {headline: '', figures: [], recommendations: [], window: {from: '2026-10-05', to: '2026-10-11', label: ''}, topProducts: [sku('Duck Feet', 40, 2)]}}}} as WindowDigest;
    expect(spanTopProducts('shopee', '2026-10-05', '2026-10-11', [viaProducts]).products).toEqual([sku('Duck Feet', 40, 2)]);
  });

  it('skips a digest with no list, and never double counts overlapping windows', () => {
    const wide = withList(week('2026-10-05', '2026-10-19', '2026-10-20T01:00:00.000Z'), 'lazada', [sku('Meaty Treats', 999, 99)]);
    const r = spanTopProducts('lazada', '2026-10-05', '2026-10-18', [a, b, wide]);
    expect(r.products).toEqual([sku('Meaty Treats', 999, 99)]); // newest wins, the two weeks overlap it
    expect(r.skipped.map((s) => s.reason)).toEqual(['overlap', 'overlap']);
    expect(spanTopProducts('lazada', '2026-10-05', '2026-10-11', [W1]).status).toBe('none'); // W1 has no product list
  });
});

describe('spanWindows: figures that cannot be placed safely', () => {
  it('a Shopee figure with no export dates is skipped and named, never placed by the digest week', () => {
    const noDates = week('2026-10-05', '2026-10-12', '2026-10-12T01:00:00.000Z', {shopee: undefined});
    const r = spanAds('shopee', '2026-10-05', '2026-10-11', [noDates]);
    expect(r).toMatchObject({status: 'none', spend: null});
    expect(r.skipped).toEqual([expect.objectContaining({reason: 'no_window'})]);
    expect(r.warnings.join(' ')).toContain('cannot be placed');
    expect(spanAds('lazada', '2026-10-05', '2026-10-11', [noDates]).spend).toBe(300); // Lazada shares the digest window
  });

  it('a Lazada window that starts at 08:00 PH is not "inside" a span that starts the next day', () => {
    const late = {window_from: '2026-10-05T00:00:00.000Z', window_to: '2026-10-12T00:00:00.000Z', created_at: '2026-10-12T01:00:00.000Z', digest: {comparison: {lazada: {revenue: 1, orders: 1, aov: 1, units: 1, adSpend: 300, roas: 4}}}} as WindowDigest; // Mon 08:00 PH to Mon 08:00 PH
    expect(spanAds('lazada', '2026-10-06', '2026-10-12', [late])).toMatchObject({status: 'none'}); // Monday 5 Oct 08:00 to 24:00 is outside
    expect(spanAds('lazada', '2026-10-05', '2026-10-12', [late])).toMatchObject({status: 'ok', spend: 300});
  });

  it('many windows with no figures give one note, not one each', () => {
    const none = (from: string, to: string) => week(from, to, `${to}T01:00:00.000Z`, {comparison: {}});
    const r = spanAds('lazada', '2026-10-05', '2026-10-25', [none('2026-10-05', '2026-10-12'), none('2026-10-12', '2026-10-19'), none('2026-10-19', '2026-10-26')]);
    expect(r.skipped).toHaveLength(3);
    expect(r.warnings.filter((w) => w.includes('no figures'))).toHaveLength(1);
    expect(r.warnings.join(' ')).toContain('3 windows have no figures');
  });
});
