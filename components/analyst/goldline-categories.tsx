'use client';

import {useState} from 'react';
import {ChevronDown} from 'lucide-react';
import type {OverviewCategory} from '@/src/goldline-overview';
import {cn} from '@/lib/utils';

const TOP = 5;
const compactPeso = (n: number) => `₱${new Intl.NumberFormat('en', {notation: 'compact', maximumFractionDigits: 1}).format(n)}`;

// "Top categories" on the Goldline Overview: net sales by product line for the
// current window, as horizontal bars scaled to the leader, with each line's share of
// the window's net sales. Uncategorized (SKUs not mapped in products yet) always sits
// last and reads as muted, so it never looks like a real product line. "View all"
// expands past the top five in place.
export function GoldlineCategories({categories, unmappedSkus}: {categories: OverviewCategory[]; unmappedSkus: number}) {
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? categories : categories.slice(0, TOP);
  const max = Math.max(0, ...categories.map((c) => c.net));
  const total = categories.reduce((a, c) => a + c.net, 0);

  return (
    <section aria-label="Top categories" className="flex min-w-0 flex-col gap-5 rounded-xl border bg-card px-6 py-5 max-sm:px-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-heading text-lg font-semibold tracking-tight">Top categories</h2>
        <p className="text-xs text-muted-foreground">Net sales by product line</p>
      </div>
      <ol className="flex flex-col gap-4">
        {shown.map((c, i) => {
          const pct = max ? Math.max(0.02, c.net / max) : 0;
          const share = total ? Math.round((c.net / total) * 1000) / 10 : 0;
          return (
            <li key={c.name} className="flex flex-col gap-1.5">
              <div className="flex items-baseline justify-between gap-3">
                <span className="flex min-w-0 items-baseline gap-2.5">
                  <span className="w-4 shrink-0 text-right text-xs text-muted-foreground tabular-nums">{i + 1}</span>
                  <span className={cn('truncate text-sm', c.uncategorized && 'italic text-muted-foreground')} title={c.name}>
                    {c.name}
                  </span>
                </span>
                <span className="shrink-0 text-sm tabular-nums">
                  {compactPeso(c.net)} <span className="text-xs text-muted-foreground">{share}%</span>
                </span>
              </div>
              <div className="ml-6.5 h-2 overflow-hidden rounded-full bg-muted" aria-hidden>
                <div className={cn('h-full rounded-full', c.uncategorized ? 'bg-muted-foreground/35' : i === 0 ? 'bg-primary' : 'bg-primary/55')} style={{width: `${Math.round(pct * 100)}%`}} />
              </div>
            </li>
          );
        })}
      </ol>
      <div className="mt-auto flex flex-wrap items-center justify-between gap-3 border-t pt-4">
        <p className="text-xs text-muted-foreground">
          {unmappedSkus > 0
            ? `${unmappedSkus} ${unmappedSkus === 1 ? 'SKU isn’t' : 'SKUs aren’t'} mapped to a product line yet, so ${unmappedSkus === 1 ? 'it’s' : 'they’re'} grouped as Uncategorized.`
            : `${categories.length} product lines this period.`}
        </p>
        {categories.length > TOP && (
          <button
            type="button"
            onClick={() => setShowAll((v) => !v)}
            aria-expanded={showAll}
            className="inline-flex items-center gap-1 rounded-sm text-xs font-medium text-primary outline-none transition-transform duration-150 ease-out focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.97]"
          >
            {showAll ? 'Show top 5' : `View all ${categories.length}`}
            <ChevronDown aria-hidden className={cn('size-3.5 transition-transform duration-150', showAll && 'rotate-180')} />
          </button>
        )}
      </div>
    </section>
  );
}
