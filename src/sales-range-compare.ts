// "Compare with the span before" for the Sales range view. Pure, no I/O.
// A change is shown only when the two spans can be compared fairly: the same channels have complete figures in both, and ad
// figures fully cover both. Otherwise there is no number, and a plain reason says why. Ad spend never gets a good/bad tone.
import type {RollupChannel} from './period-rollup';
import {adsTotals, sumTotals, type PreviousView, type SalesRangeView} from './sales-range';

export type CompareMetric = 'revenue' | 'orders' | 'aov' | 'adSpend' | 'roas';
export interface Delta {
  metric: CompareMetric;
  cur: number | null;
  prev: number | null;
  /** Percent change, one decimal. Null when there is nothing fair to say. */
  pct: number | null;
  direction: 'up' | 'down' | 'flat' | null;
  tone: 'good' | 'bad' | 'neutral';
}
export interface Check {
  ok: boolean;
  reason: string | null;
}
export interface Comparison {
  sales: Check;
  ads: Check;
  /** ROAS can be missing for one channel in one span; it is compared only when the same channels have it in both. */
  roas: Check;
  /** A plain note when sales are comparable but a percent is not defined (the earlier span had no sales). */
  note: string | null;
  deltas: Record<CompareMetric, Delta>;
}

/** The percent as shown: one decimal at most, from the same number the arrow is based on (so they cannot disagree). */
export function pctLabel(d: Pick<Delta, 'pct' | 'direction'>): string {
  if (d.pct === null || d.direction === null) return '';
  if (d.direction === 'flat') return '0%';
  return `${Math.abs(d.pct).toFixed(1).replace(/\.0$/, '')}%`;
}

const NAME: Record<RollupChannel, string> = {shopee: 'Shopee', lazada: 'Lazada', website: 'Website', offline: 'Offline'};
const live = (c: {revenue: number | null; orders: number | null} | undefined): boolean => Boolean(c && c.revenue !== null && c.orders !== null);

function salesCheck(cur: SalesRangeView['channels'], prev: PreviousView['channels'], selected: readonly RollupChannel[], endsToday: boolean): Check {
  // Today's website and POS orders are live and incomplete, yet report 'ok'; a part day next to full days is not a fair comparison.
  if (endsToday) return {ok: false, reason: 'Today is not finished yet, so a change would not be fair. Pick dates that end before today.'};
  let any = false;
  for (const ch of selected) {
    const a = cur.find((c) => c.channel === ch);
    const b = prev.find((c) => c.channel === ch);
    if (!live(a) && !live(b)) continue; // absent in both: not a problem
    if (live(a) !== live(b)) return {ok: false, reason: `${NAME[ch]} has figures in only one of the two spans, so a change would not be fair.`};
    if (a?.status !== 'ok') return {ok: false, reason: `${NAME[ch]} is only partly covered in this span, so a change would not be fair.`};
    if (b?.status !== 'ok') return {ok: false, reason: `${NAME[ch]} is only partly covered in the earlier span, so a change would not be fair.`};
    any = true;
  }
  return any ? {ok: true, reason: null} : {ok: false, reason: 'There are no figures to compare.'};
}

function adsCheck(cur: ReturnType<typeof adsTotals>, prev: ReturnType<typeof adsTotals>, anyMarketplace: boolean): Check {
  if (!anyMarketplace) return {ok: false, reason: 'Ad figures exist for Shopee and Lazada only.'};
  if (cur.spend === null) return {ok: false, reason: 'No full ad window sits inside this span.'};
  if (prev.spend === null) return {ok: false, reason: 'No full ad window sits inside the earlier span.'};
  if (cur.tag.kind !== 'ex') return {ok: false, reason: 'Ad figures only partly cover this span, so a change would not be fair.'};
  if (prev.tag.kind !== 'ex') return {ok: false, reason: 'Ad figures only partly cover the earlier span, so a change would not be fair.'};
  return {ok: true, reason: null};
}

function delta(metric: CompareMetric, cur: number | null, prev: number | null, ok: boolean): Delta {
  const none: Delta = {metric, cur, prev, pct: null, direction: null, tone: 'neutral'};
  if (!ok || cur === null || prev === null || prev <= 0) return none;
  const pct = Math.round(((cur - prev) / prev) * 1000) / 10;
  const direction = Math.abs(pct) < 0.5 ? 'flat' : pct > 0 ? 'up' : 'down';
  const tone = metric === 'adSpend' || direction === 'flat' ? 'neutral' : direction === 'up' ? 'good' : 'bad';
  return {metric, cur, prev, pct, direction, tone};
}

/** Change against the span before, for the channels the owner has switched on. */
export function compareSpans(cur: Pick<SalesRangeView, 'channels' | 'ads' | 'fromDay' | 'toDay' | 'bounds'>, prev: PreviousView, selected: readonly RollupChannel[]): Comparison {
  const sales = salesCheck(cur.channels, prev.channels, selected, cur.toDay >= cur.bounds.max);
  const a = sumTotals(cur.channels.filter((c) => selected.includes(c.channel)));
  const b = sumTotals(prev.channels.filter((c) => selected.includes(c.channel)));

  const mk = (x: {channel: 'shopee' | 'lazada'}) => selected.includes(x.channel);
  const curAds = [cur.ads.shopee, cur.ads.lazada].filter(mk);
  const prevAds = [prev.ads.shopee, prev.ads.lazada].filter(mk);
  const ca = adsTotals(curAds, cur.fromDay, cur.toDay);
  const pa = adsTotals(prevAds, prev.fromDay, prev.toDay);
  const ads = adsCheck(ca, pa, curAds.length > 0);
  const withRoas = (xs: typeof curAds) => xs.filter((x) => x.roas !== null).map((x) => x.channel).sort().join(',');
  const roas: Check = !ads.ok || withRoas(curAds) === withRoas(prevAds) ? {ok: ads.ok, reason: null} : {ok: false, reason: 'ROAS covers different channels in the two spans, so a change would not be fair.'};
  const note = sales.ok && (b.revenue ?? 0) <= 0 ? 'The earlier span had no sales, so a percent change is not defined.' : null;

  return {
    sales,
    ads,
    roas,
    note,
    deltas: {
      revenue: delta('revenue', a.revenue, b.revenue, sales.ok),
      orders: delta('orders', a.orders, b.orders, sales.ok),
      aov: delta('aov', a.aov, b.aov, sales.ok),
      adSpend: delta('adSpend', ca.spend, pa.spend, ads.ok),
      roas: delta('roas', ca.roas, pa.roas, roas.ok),
    },
  };
}
