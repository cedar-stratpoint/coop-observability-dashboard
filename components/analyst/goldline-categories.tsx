'use client';

import {useState} from 'react';
import {ArrowRight} from 'lucide-react';
import type {OverviewCategory} from '@/src/goldline-overview';
import {Card, CardContent, CardHeader, CardTitle} from '@/components/ui/card';
import {cn} from '@/lib/utils';

const TOP = 5;
const compactPeso = (n: number) =>
  `₱${new Intl.NumberFormat('en', {notation: 'compact', maximumFractionDigits: 1}).format(n)}`;

// "Top categories" on the Goldline Overview: net sales by product line for the
// current window, as horizontal bars scaled to the leader. Uncategorized (SKUs not
// mapped in gl_products yet) always sits last and reads as muted, so it never
// looks like a real product line. "View all" expands past the top five in place.
export function GoldlineCategories({categories, unmappedSkus}: {categories: OverviewCategory[]; unmappedSkus: number}) {
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? categories : categories.slice(0, TOP);
  const max = Math.max(0, ...categories.map((c) => c.net));

  return (
    <Card>
      <CardHeader className="flex flex-row items-baseline justify-between gap-3">
        <CardTitle>Top categories</CardTitle>
        <div className="flex items-baseline gap-3 text-xs">
          <span className="text-muted-foreground">net sales</span>
          {categories.length > TOP && (
            <button
              type="button"
              onClick={() => setShowAll((v) => !v)}
              aria-expanded={showAll}
              className="inline-flex items-center gap-1 rounded-sm font-medium text-primary outline-none transition-transform duration-150 ease-out focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.97]"
            >
              {showAll ? 'Show top 5' : `View all ${categories.length}`}
              {!showAll && <ArrowRight className="size-3.5" />}
            </button>
          )}
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3.5">
        {shown.map((c) => {
          const pct = max ? Math.max(0.02, c.net / max) : 0;
          return (
            <div key={c.name} className="grid grid-cols-[minmax(7rem,11rem)_1fr_auto] items-center gap-4">
              <span className={cn('truncate text-sm', c.uncategorized && 'italic text-muted-foreground')}>{c.name}</span>
              <div className="h-2 overflow-hidden rounded-full bg-muted" aria-hidden>
                <div
                  className={cn('h-full rounded-full', c.uncategorized ? 'bg-muted-foreground/35' : 'bg-primary')}
                  style={{width: `${Math.round(pct * 100)}%`}}
                />
              </div>
              <span className="font-mono text-xs tabular-nums text-muted-foreground">{compactPeso(c.net)}</span>
            </div>
          );
        })}
        {unmappedSkus > 0 && (
          <p className="pt-1 text-xs text-muted-foreground">
            {unmappedSkus} {unmappedSkus === 1 ? 'SKU isn’t' : 'SKUs aren’t'} mapped to a product line yet, so{' '}
            {unmappedSkus === 1 ? 'it’s' : 'they’re'} grouped as Uncategorized.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
