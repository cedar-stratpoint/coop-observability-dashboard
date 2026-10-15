import {getDigests} from '@/src/data';
import {requireZoomyData} from '@/src/active-context';
import {getBrief} from '@/src/salesSignals';
import {pickIndex} from '@/src/week';
import {ChannelOverview, type Channel} from '@/components/analyst/channel-compare';
import {HomeLanding} from '@/components/analyst/home-landing';
import {OfflineChannelCard} from '@/components/analyst/offline-channel-card';
import {getPosOrders} from '@/src/pos-sales';
import {computeKpis, filterOrdersByRange, offlineCompareMetrics} from '@/src/pos-sales-compute';
import {getDailyTarget} from '@/src/pos-target';
import {progress as computeProgress, todaysRevenue} from '@/src/pos-target-compute';
import type {SalesKpis} from '@/src/pos-sales-types';
import type {DailyProgress} from '@/src/pos-target-types';
import {getCrmOrders} from '@/src/crm-data';
import {resolveCustomRange, websiteRangeMetrics, inRange, dailyRangeMetrics} from '@/src/custom-range';
import {fmtRange} from '@/src/week';

export const dynamic = 'force-dynamic'; // reflect the latest archive when live

// All channels, including offline, are selected by default on the compare
// Overview (PO decision 2026-09-07). Offline is filtered to the same window as
// the digest (the period, or the custom range inside it), so the headline totals
// share one basis. Trend arrows still exclude offline (see CombinedKpis).
const ALL_CHANNELS: Channel[] = ['shopee', 'lazada', 'website', 'offline'];
const DEFAULT_CHANNELS: Channel[] = ['shopee', 'lazada', 'website', 'offline'];

// Offline 30-day KPIs for the Overview home card. Isolated + fail-soft: an
// offline data hiccup must never break the core (digest-driven) Overview — on
// any error the card is simply omitted.
async function offlineKpis(): Promise<SalesKpis | null> {
  try {
    const orders = filterOrdersByRange(await getPosOrders(), '30d');
    return computeKpis(orders);
  } catch {
    return null;
  }
}

// Offline metrics for the period's (or custom range's) window, for the Compare
// Channels chart. Same fail-soft contract: null on any error so the chart just omits offline.
async function offlineCompare(range: {from: string; to: string}): Promise<ReturnType<typeof offlineCompareMetrics>> {
  try {
    const orders = await getPosOrders();
    return offlineCompareMetrics(orders.filter((o) => inRange(o.created_at, range)));
  } catch {
    return null;
  }
}

// Today's revenue (Manila day) vs the owner-set goal, for the landing's compact
// health bar. Same fail-soft contract: null on any error hides the bar.
// getPosOrders is React-cached, so this shares the fetch with offlineKpis().
async function offlineDailyProgress(): Promise<DailyProgress | null> {
  try {
    const target = await getDailyTarget();
    return computeProgress(todaysRevenue(await getPosOrders()), target.amount);
  } catch {
    return null;
  }
}

export default async function Page(props: {searchParams: Promise<{week?: string; channel?: string; from?: string; to?: string}>}) {
  await requireZoomyData(); // Zoomy-only overview — bounce a non-Zoomy viewer to /uploads
  const searchParams = await props.searchParams;
  // Customer PII is masked inside getDigests() (server-only) rather than here, so
  // every route is fail-closed — see src/data.ts + src/pii.ts.
  const digests = await getDigests();
  const idx = pickIndex(digests, searchParams.week);
  const row = digests[idx];
  if (!row) return <div className="p-10 text-muted-foreground">No digests archived yet.</div>;
  const priorRow = digests[idx + 1] ?? null; // the next-older period, for KPI deltas

  // Home ("What should we do today?") is the default; a ?channel opens the unified
  // overview — 'all' (or an unknown value) selects every channel, a single channel
  // starts filtered to it (drills into its detail).
  const ch = searchParams.channel;
  if (!ch) {
    const [kpis, progress] = await Promise.all([offlineKpis(), offlineDailyProgress()]);
    return (
      <>
        <HomeLanding row={row} progress={progress} />
        {kpis && (
          <div className="mx-auto -mt-6 max-w-5xl px-6 pb-12 md:px-10">
            <OfflineChannelCard kpis={kpis} />
          </div>
        )}
      </>
    );
  }
  const initial = ALL_CHANNELS.includes(ch as Channel) ? [ch as Channel] : DEFAULT_CHANNELS;
  // ?from&to (PH days) narrow the overview inside the period: Website from live CRM
  // orders, Offline from POS orders, Shopee/Lazada from the digest's per-day series
  // (when the row has one — older rows stay full-period only).
  const range = resolveCustomRange(row.window_from, row.window_to, searchParams.from, searchParams.to);
  const offline = await offlineCompare(range ?? {from: row.window_from, to: row.window_to});
  const custom = range
    ? {
        label: fmtRange(range.fromDay, range.toDay),
        ...websiteRangeMetrics(await getCrmOrders(), range),
        shopee: dailyRangeMetrics(row.digest.daily?.shopee, range),
        lazada: dailyRangeMetrics(row.digest.daily?.lazada, range),
      }
    : null;
  return <ChannelOverview brief={getBrief()} row={row} priorRow={priorRow} initialChannels={initial} offline={offline} custom={custom} />;
}
