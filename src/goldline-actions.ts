// The Action Feed (plan §07h), pure and unit-tested: turns one store's stock movement
// into a prioritized to-do list — reorders, anomalies, dead stock and missing counts —
// ranked by severity, then by the pesos at stake.

import type {ItemMovement} from './goldline-movement';

export type ActionKind = 'gap' | 'reorder' | 'anomaly' | 'dead';
export type Severity = 'critical' | 'warn' | 'info';

export type Action = {
  id: string;
  kind: ActionKind;
  severity: Severity;
  title: string;
  detail: string;
  impact: number; // ₱ at stake, for ranking
  itemCode: string | null;
  cta: {label: string; href: string};
};

export type CatalogInfo = {name: string; price: number | null};

const SEV_RANK: Record<Severity, number> = {critical: 0, warn: 1, info: 2};
const peso = (n: number) => `₱${Math.round(n).toLocaleString('en-US')}`;
const fmtDay = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', {month: 'short', day: 'numeric', timeZone: 'UTC'});

export function buildActions(input: {
  storeCode: string;
  items: ItemMovement[];
  catalog: Record<string, CatalogInfo>;
  countedCurrent: boolean;
  currentPeriod: {start: string; end: string} | null;
  lastCountEnd: string | null;
}): Action[] {
  const {storeCode, items, catalog, countedCurrent, currentPeriod, lastCountEnd} = input;
  const out: Action[] = [];
  const stockHref = `/stock?store=${encodeURIComponent(storeCode)}`;
  const forecastHref = `/stock?store=${encodeURIComponent(storeCode)}`;
  const nameOf = (code: string) => catalog[code]?.name ?? code;
  const priceOf = (code: string) => catalog[code]?.price ?? 0;

  if (!countedCurrent && currentPeriod) {
    out.push({
      id: `gap-${storeCode}`,
      kind: 'gap',
      severity: 'critical',
      title: `Inventory form not in for ${fmtDay(currentPeriod.start)} to ${fmtDay(currentPeriod.end)}`,
      detail: lastCountEnd ? `Last count ended ${fmtDay(lastCountEnd)} · chase the beauty consultant` : 'No count on record yet · chase the beauty consultant',
      impact: Number.MAX_SAFE_INTEGER, // a missing count hides everything else
      itemCode: null,
      cta: {label: 'Upload', href: '/uploads'},
    });
  }

  // A store whose form isn't in for this period gets only the gap action — reorders /
  // anomalies from its older count would be stale advice.
  for (const m of countedCurrent ? items : []) {
    const name = nameOf(m.item_code);
    const perCycleValue = (m.velocity ?? 0) * priceOf(m.item_code);
    if (m.status === 'out') {
      out.push({
        id: `out-${m.item_code}`,
        kind: 'reorder',
        severity: 'critical',
        title: `${name} is out of stock`,
        detail:
          m.velocity != null && m.velocity > 0
            ? `Sells ~${Math.round(m.velocity)} a cycle · suggested order ${m.suggestedOrder}`
            : 'No sales history yet · restock to your usual level',
        impact: Math.max(perCycleValue, priceOf(m.item_code)),
        itemCode: m.item_code,
        cta: {label: 'Order', href: forecastHref},
      });
    } else if (m.status === 'reorder') {
      out.push({
        id: `reorder-${m.item_code}`,
        kind: 'reorder',
        severity: 'warn',
        title: `${name}, ~${Math.max(0, Math.floor(m.coverDays ?? 0))} days of cover`,
        detail: `Runs out around ${m.stockOutDate ? fmtDay(m.stockOutDate) : 'soon'} · order ${m.suggestedOrder} before the next delivery`,
        impact: perCycleValue,
        itemCode: m.item_code,
        cta: {label: 'Order', href: forecastHref},
      });
    }
    if (m.anomaly?.kind === 'spike') {
      out.push({
        id: `spike-${m.item_code}`,
        kind: 'anomaly',
        severity: 'warn',
        title: `${name} sold ${Math.round(m.anomaly.sold / Math.max(m.anomaly.usual, 1))}× its usual`,
        detail: `${m.anomaly.sold} this cycle vs ~${Math.round(m.anomaly.usual)} · check the handwritten count`,
        impact: m.anomaly.sold * priceOf(m.item_code),
        itemCode: m.item_code,
        cta: {label: 'Review', href: stockHref},
      });
    } else if (m.anomaly?.kind === 'rose_without_delivery') {
      out.push({
        id: `rose-${m.item_code}`,
        kind: 'anomaly',
        severity: 'warn',
        title: `${name} count went up by ${m.anomaly.by} with no delivery`,
        detail: 'Likely a misread count or a delivery that wasn’t written down',
        impact: m.anomaly.by * priceOf(m.item_code),
        itemCode: m.item_code,
        cta: {label: 'Review', href: stockHref},
      });
    }
    if (m.deadStock) {
      const tied = (m.onHand ?? 0) * priceOf(m.item_code);
      out.push({
        id: `dead-${m.item_code}`,
        kind: 'dead',
        severity: 'info',
        title: `${name}: no sales in 2 cycles`,
        detail: `${tied > 0 ? `${peso(tied)} tied up` : `${m.onHand} on hand`} · pull or transfer`,
        impact: tied,
        itemCode: m.item_code,
        cta: {label: 'Plan', href: stockHref},
      });
    }
  }

  return out.sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity] || b.impact - a.impact || a.id.localeCompare(b.id));
}
