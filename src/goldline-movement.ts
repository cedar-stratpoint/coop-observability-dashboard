// Stock movement for Goldline (pure, unit-tested) — the engine behind the stock
// forecast, the Action Feed and store Health.
//
// Goldline has no daily sales feed per item: the POS export uses numeric SKU codes
// that aren't mapped to the form's item codes yet. So movement is ESTIMATED from the
// semi-monthly counts themselves:
//     sold in a cycle ≈ last count's on hand + this cycle's delivery − this on hand
// Every figure derived from it (velocity, days of cover, stock-out date, suggested
// order) says so on screen. On hand uses the same rule as Inventory (onHandOf).

import {onHandOf, type InventoryRowIn} from './goldline-inventory';

export const REORDER_UNDER_DAYS = 10; // "reorder now" — under 10 days of cover (plan §07g)
export const TARGET_COVER_CYCLES = 2; // order up to two cycles of cover
export const ANOMALY_FACTOR = 3; // a cycle selling ≥ 3× the usual
export const ANOMALY_MIN_UNITS = 5; // …and at least this many units (ignore 1 → 3)

const DAY = 86_400_000;
export const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);
export const periodLength = (start: string, end: string) => daysBetween(start, end) + 1;
export const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + Math.round(n) * DAY).toISOString().slice(0, 10);

/** One store's count for one form period. */
export type Count = {period_start: string; period_end: string; rows: InventoryRowIn[]};

export type ItemMovement = {
  item_code: string;
  onHand: number | null; // latest count
  cyclesSold: number[]; // estimated units sold per cycle, oldest → newest (only where computable)
  velocity: number | null; // avg units per cycle over the last ≤3 computable cycles
  coverDays: number | null; // days the current on hand lasts at that velocity
  stockOutDate: string | null; // from the latest count's period end
  suggestedOrder: number; // to reach TARGET_COVER_CYCLES of cover (0 = none)
  status: 'out' | 'reorder' | 'watch' | 'healthy' | 'no_history' | 'not_counted';
  deadStock: boolean; // on hand, but nothing moved across the last 2 cycles
  anomaly: null | {kind: 'spike'; sold: number; usual: number} | {kind: 'rose_without_delivery'; by: number};
};

/**
 * Movement per item for one store, from its counts (any order; sorted here). The
 * latest count drives on hand / status; earlier counts provide the cycles sold.
 */
export function storeMovement(counts: Count[]): {latest: Count | null; cycleDays: number | null; counts: number; items: ItemMovement[]} {
  const sorted = [...counts].sort((a, b) => a.period_end.localeCompare(b.period_end));
  const latest = sorted[sorted.length - 1] ?? null;
  if (!latest) return {latest: null, cycleDays: null, counts: 0, items: []};
  const cycleDays = periodLength(latest.period_start, latest.period_end);

  const byCount = sorted.map((c) => new Map(c.rows.map((r) => [r.item_code, r])));
  const codes = new Set(latest.rows.map((r) => r.item_code));

  const items: ItemMovement[] = [...codes].map((code) => {
    const now = byCount[byCount.length - 1].get(code)!;
    const onHand = onHandOf(now).onHand;

    // Units sold between this item's consecutive counts. If a cycle was skipped (or the
    // item was missing from a count), the gap spans more than one cycle, so the figure
    // is normalized to one cycle's worth (sold × cycle ÷ days between the counts).
    // A negative figure (count rose with no delivery) is NOT a zero-sales cycle — it's
    // skipped, and reported as an anomaly when it's the newest cycle.
    const cyclesSold: number[] = [];
    let rose: number | null = null;
    let newestIsLatest = false; // whether the last entry is the cycle ending at the latest count
    let prevIdx = -1;
    for (let k = 0; k < byCount.length; k++) {
      const cur = byCount[k].get(code);
      if (!cur || onHandOf(cur).onHand == null) continue;
      if (prevIdx >= 0) {
        const prev = byCount[prevIdx].get(code)!;
        const a = onHandOf(prev).onHand as number;
        const b = onHandOf(cur).onHand as number;
        const gap = daysBetween(sorted[prevIdx].period_end, sorted[k].period_end);
        const sold = a + (cur.delivery ?? 0) - b;
        if (gap > 0 && sold >= 0) {
          cyclesSold.push((sold * cycleDays) / gap);
          newestIsLatest = k === byCount.length - 1;
        } else if (sold < 0 && k === byCount.length - 1) {
          rose = -sold; // newest cycle: count went up with no delivery to explain it
        }
      }
      prevIdx = k;
    }

    const recent = cyclesSold.slice(-3);
    const velocity = recent.length ? recent.reduce((x, y) => x + y, 0) / recent.length : null;
    const perDay = velocity != null && cycleDays > 0 ? velocity / cycleDays : null;
    const coverDays = onHand == null || perDay == null ? null : perDay > 0 ? onHand / perDay : onHand > 0 ? Infinity : 0;
    const stockOutDate =
      coverDays == null || !Number.isFinite(coverDays) ? null : addDays(latest.period_end, Math.max(0, Math.floor(coverDays)));
    const target = perDay == null ? 0 : Math.ceil(perDay * cycleDays * TARGET_COVER_CYCLES);
    const suggestedOrder = onHand == null ? 0 : Math.max(0, target - onHand);

    let status: ItemMovement['status'];
    if (onHand == null) status = 'not_counted';
    else if (onHand <= 0) status = 'out';
    else if (coverDays == null) status = 'no_history';
    else if (coverDays < REORDER_UNDER_DAYS) status = 'reorder';
    else if (coverDays <= cycleDays) status = 'watch';
    else status = 'healthy';

    const lastTwo = cyclesSold.slice(-2);
    const deadStock = onHand != null && onHand > 0 && newestIsLatest && lastTwo.length === 2 && lastTwo.every((s) => s === 0);

    let anomaly: ItemMovement['anomaly'] = null;
    if (rose != null && rose > 0) anomaly = {kind: 'rose_without_delivery', by: rose};
    else if (cyclesSold.length >= 2 && newestIsLatest) {
      // Only the newest cycle can be a current spike.
      const last = cyclesSold[cyclesSold.length - 1];
      const before = cyclesSold.slice(-4, -1);
      const usual = before.reduce((x, y) => x + y, 0) / before.length;
      if (last >= ANOMALY_MIN_UNITS && last >= ANOMALY_FACTOR * Math.max(usual, 1)) anomaly = {kind: 'spike', sold: last, usual};
    }

    return {item_code: code, onHand, cyclesSold, velocity, coverDays, stockOutDate, suggestedOrder, status, deadStock, anomaly};
  });

  return {latest, cycleDays, counts: sorted.length, items};
}

/**
 * The company's current form period: among periods ending in the last ~2 cycles of
 * the newest one, the one the most stores counted (ties → the later one). One store
 * with an odd or mistyped period can't make every other store look "missing".
 */
export function pickCurrentPeriod(snaps: Array<{store_code: string; period_start: string; period_end: string}>): {start: string; end: string} | null {
  if (!snaps.length) return null;
  const newest = snaps.reduce((m, s) => (s.period_end > m ? s.period_end : m), snaps[0].period_end);
  const stores = new Map<string, {start: string; end: string; stores: Set<string>}>();
  for (const s of snaps) {
    if (daysBetween(s.period_end, newest) > 31) continue;
    const k = `${s.period_start}|${s.period_end}`;
    const e = stores.get(k) ?? {start: s.period_start, end: s.period_end, stores: new Set<string>()};
    e.stores.add(s.store_code);
    stores.set(k, e);
  }
  const best = [...stores.values()].sort((a, b) => b.stores.size - a.stores.size || b.end.localeCompare(a.end))[0];
  return best ? {start: best.start, end: best.end} : null;
}

/** A store's latest count is "this period" if it ends within 3 days of the period end. */
export const PERIOD_TOLERANCE_DAYS = 3;
export const isCurrentCount = (countEnd: string | null | undefined, period: {end: string} | null) =>
  Boolean(countEnd && period && Math.abs(daysBetween(countEnd, period.end)) <= PERIOD_TOLERANCE_DAYS);

// ── Store health ─────────────────────────────────────────────────────────────

export type FormTimeliness = 'on_time' | 'late' | 'missing';
/** On time = committed within 3 days after the period ends. */
export const SUBMIT_GRACE_DAYS = 3;

/** Calendar date of a timestamp in Manila (stores' local time), YYYY-MM-DD. */
const manilaDate = (ts: string) => new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Manila'}).format(new Date(ts));

export function formTimeliness(periodEnd: string | null, committedAt: string | null): FormTimeliness {
  if (!periodEnd || !committedAt) return 'missing';
  const lag = daysBetween(periodEnd, manilaDate(committedAt));
  return lag <= SUBMIT_GRACE_DAYS ? 'on_time' : 'late';
}

export type StoreHealth = {
  score: number | null; // 0–100; null when the store has no count for the period
  inStockRate: number | null; // counted items with stock / counted items
  medianCoverDays: number | null;
  deadStockValue: number;
  stockValue: number;
  low: number; // reorder + out
  out: number;
  form: FormTimeliness;
};

/**
 * One store's health for the company's current period. Weights (sum 100):
 *   in-stock rate 40 · cover 25 (full marks at ≥ 1 cycle) · stock not dead 15 ·
 *   form submitted on time 20 (late = half).
 * Cover and dead stock need history; without it those parts score neutral (full
 * marks) so a new store isn't punished for having only one count.
 */
export function storeHealth(
  movement: ReturnType<typeof storeMovement>,
  priceOf: (code: string) => number | null,
  form: FormTimeliness,
): StoreHealth {
  const items = movement.items.filter((i) => i.status !== 'not_counted');
  if (!movement.latest || !items.length || form === 'missing') {
    return {score: null, inStockRate: null, medianCoverDays: null, deadStockValue: 0, stockValue: 0, low: 0, out: 0, form};
  }
  const inStock = items.filter((i) => (i.onHand ?? 0) > 0).length / items.length;
  const covers = items.map((i) => i.coverDays).filter((c): c is number => c != null && Number.isFinite(c)).sort((a, b) => a - b);
  const medianCoverDays = covers.length ? covers[Math.floor(covers.length / 2)] : null;
  let stockValue = 0;
  let deadStockValue = 0;
  for (const i of items) {
    const v = (i.onHand ?? 0) * (priceOf(i.item_code) ?? 0);
    stockValue += v;
    if (i.deadStock) deadStockValue += v;
  }
  const cycle = movement.cycleDays ?? 15;
  const coverPart = medianCoverDays == null ? 1 : Math.min(1, medianCoverDays / cycle);
  const livePart = stockValue > 0 ? 1 - deadStockValue / stockValue : 1;
  const formPart = form === 'on_time' ? 1 : 0.5;
  const score = Math.round(100 * (0.4 * inStock + 0.25 * coverPart + 0.15 * livePart + 0.2 * formPart));
  return {
    score,
    inStockRate: inStock,
    medianCoverDays,
    deadStockValue,
    stockValue,
    low: items.filter((i) => i.status === 'reorder' || i.status === 'out').length,
    out: items.filter((i) => i.status === 'out').length,
    form,
  };
}
