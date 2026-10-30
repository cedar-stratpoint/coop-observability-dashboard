import {TrendingDown, TrendingUp} from 'lucide-react';
import {Card, CardContent} from '@/components/ui/card';
import {cn} from '@/lib/utils';

// ── The dashboard's one metric-value typography ──────────────────────────────
// Every KPI / figure / stat number renders in this face so a value reads the
// same in every view. Before this, each tile picked its own: the warm serif in
// the home brief and channel-compare totals, but font-mono in the overview
// KpiTiles and plain sans in the offline and repricer stats. Size and color are
// still per-context; only the face, weight, tracking, and figure style are fixed
// here. Import this instead of re-typing a value className.
export const metricValueClass = 'font-serif font-normal leading-tight tracking-tight tabular-nums';

/** The house up/down delta chip — green when up, clay when down. */
export function MetricDelta({pct}: {pct: number}) {
  const up = pct >= 0;
  const Icon = up ? TrendingUp : TrendingDown;
  return (
    <span
      className="inline-flex items-center gap-0.5 text-xs font-medium tabular-nums"
      style={{color: up ? 'var(--status-good)' : 'var(--status-crit)'}}
    >
      <Icon className="size-3.5" />
      {up ? '+' : ''}
      {pct}%
    </span>
  );
}

/**
 * The canonical KPI tile: a card with an uppercase label (optional icon + delta)
 * and the house metric value. This is the standard case; tiles with extra chrome
 * (the figure tiles' percentage progress bar, the repricer's stat variants) share
 * `metricValueClass` directly rather than this wrapper, so the number still reads
 * identically everywhere.
 */
export function Metric({
  icon: Icon,
  label,
  value,
  unit,
  delta,
  sub,
  valueClassName,
}: {
  icon?: React.ComponentType<{className?: string}>;
  label: string;
  value: string;
  unit?: string;
  delta?: number;
  sub?: React.ReactNode;
  valueClassName?: string;
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="mb-2 flex items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            {Icon && <Icon className="size-3.5" />}
            {label}
          </span>
          {delta != null && <MetricDelta pct={delta} />}
        </div>
        <div className="flex items-baseline gap-0.5">
          <span className={cn(metricValueClass, 'text-2xl', valueClassName)}>{value}</span>
          {unit && <span className="text-[17px] font-medium leading-none text-muted-foreground">{unit}</span>}
        </div>
        {sub && <div className="mt-1 text-xs text-muted-foreground">{sub}</div>}
      </CardContent>
    </Card>
  );
}
