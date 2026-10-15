// BoxMe (Online) block on /inventory/[sku]: warehouse stock for this SKU, its
// next expiry and cover, the per-warehouse split, and the daily available-units
// trend from boxme_stock_daily. Server component; data from getBoxmeSkuDetail.

import Link from 'next/link';
import {cn} from '@/lib/utils';
import {fmtDate, fmtLasts, fmtManilaWhen, syncPill} from '@/src/boxme-format';
import {MIN_HISTORY_DAYS} from '@/src/boxme-inventory-compute';
import type {BoxmeSkuDetail} from '@/src/boxme-inventory-data';
import {STATUS} from '@/src/inventory-status';

const n = (v: number) => v.toLocaleString('en-US');

export function BoxmeSkuCard({detail}: {detail: BoxmeSkuDetail | null}) {
  if (!detail) {
    return (
      <div className="mt-5 rounded-xl border border-dashed bg-muted/30 px-5 py-4 text-sm text-muted-foreground">
        <span className="font-medium text-foreground">BoxMe (Online):</span> this product is not stocked at the BoxMe warehouse.
      </div>
    );
  }
  const {row: r, sync, history} = detail;
  const now = new Date();
  const pill = syncPill(sync, now);
  const s = STATUS[r.status];
  const cells = [
    {label: 'Available', value: n(r.available), big: true},
    {label: 'Awaiting pick', value: n(r.awaiting)},
    {label: 'Incoming', value: n(r.incoming)},
    {label: 'Damaged', value: n(r.damaged)},
  ];

  return (
    <section aria-labelledby="boxme-heading" className="mt-5 rounded-xl border bg-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="boxme-heading" className="text-sm font-semibold">BoxMe (Online) warehouse stock</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {pill.label}{detail.usingMock && ' · demo data'} · <Link href="/inventory?channel=online" className="text-primary hover:underline">all BoxMe stock</Link>
          </p>
        </div>
        <span className={cn('inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold', s.bg, s.text)}>
          <span className={cn('size-1.5 rounded-full', s.dot)} />{s.label}
        </span>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
        {cells.map((c) => (
          <div key={c.label}>
            <div className="text-[10px] font-semibold uppercase tracking-[0.09em] text-muted-foreground">{c.label}</div>
            <div className={cn('mt-1 tabular-nums', c.big ? 'font-heading text-[28px] leading-none' : 'text-lg font-medium leading-none')}>{c.value}</div>
          </div>
        ))}
      </div>

      <div className="mt-4 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
        <span>
          Next expiry{' '}
          {r.nextExpiry ? (
            <span className={cn('font-medium', r.nextExpiry.soon ? 'text-amber-700 dark:text-amber-300' : 'text-foreground')}>
              {fmtDate(r.nextExpiry.date)} ({n(r.nextExpiry.quantity)} units, {r.nextExpiry.daysLeft} d)
            </span>
          ) : <span className="text-foreground">none</span>}
        </span>
        <span>
          Lasts{' '}
          <span className="font-medium text-foreground">
            {r.available <= 0 ? 'Out' : r.soldPerDay == null ? `building history (${r.historyDays} of ${MIN_HISTORY_DAYS} days)` : r.soldPerDay === 0 ? 'no recent sales' : `${fmtLasts(r.lastsDays)} at ${Math.round(r.soldPerDay * 10) / 10}/day`}
          </span>
        </span>
        <span>Low under <span className="font-medium text-foreground">{n(r.threshold)}</span></span>
      </div>

      {r.byWarehouse.length > 1 && (
        <ul className="mt-3 flex flex-col gap-1 border-t pt-3 text-xs">
          {r.byWarehouse.map((w) => (
            <li key={w.pickup_id} className="flex justify-between gap-2">
              <span className="font-mono text-muted-foreground">{w.label}</span>
              <span className="tabular-nums">{n(w.available)} available · {n(w.stock)} on hand</span>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-4 border-t pt-4">
        <div className="mb-2 flex items-baseline justify-between text-xs">
          <span className="font-medium">Available units, daily</span>
          {sync.lastGoodAt && <span className="text-muted-foreground">as of {fmtManilaWhen(sync.lastGoodAt, now)}</span>}
        </div>
        <TrendLine history={history} />
      </div>
    </section>
  );
}

/** Small area line of daily available units, scaled from zero. The SVG stretches
 *  to the card width (no text inside it); labels are HTML so they never distort. */
function TrendLine({history}: {history: BoxmeSkuDetail['history']}) {
  if (history.length < 2) {
    return <p className="text-xs text-muted-foreground">The trend appears after a few daily syncs.</p>;
  }
  const W = 600, H = 80, TOP = 6, BOTTOM = 78;
  const max = Math.max(1, ...history.map((h) => h.available));
  const x = (i: number) => (i / (history.length - 1)) * W;
  const y = (v: number) => BOTTOM - (v / max) * (BOTTOM - TOP);
  const pts = history.map((h, i) => `${x(i).toFixed(1)},${y(h.available).toFixed(1)}`).join(' ');
  const first = history[0], last = history[history.length - 1];
  return (
    <figure className="m-0">
      <div className="relative">
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="block h-20 w-full text-primary" role="img"
          aria-label={`Available units from ${n(first.available)} on ${fmtDate(first.date)} to ${n(last.available)} on ${fmtDate(last.date)}`}>
          <polygon points={`0,${BOTTOM} ${pts} ${W},${BOTTOM}`} fill="currentColor" fillOpacity={0.1} />
          <polyline points={pts} fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
          <line x1={0} x2={W} y1={BOTTOM} y2={BOTTOM} className="stroke-border" strokeWidth={1} vectorEffect="non-scaling-stroke" />
        </svg>
        <span className="absolute right-0 -top-1 rounded bg-card/90 px-1 font-heading text-[15px] leading-none tabular-nums">{n(last.available)}</span>
      </div>
      <figcaption className="mt-1 flex justify-between text-[11px] text-muted-foreground">
        <span>{fmtDate(first.date)}</span>
        <span>{fmtDate(last.date)}</span>
      </figcaption>
    </figure>
  );
}
