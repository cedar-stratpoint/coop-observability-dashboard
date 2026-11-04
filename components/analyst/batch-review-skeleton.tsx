// Instant placeholder for the batch-review route (loading.tsx) while the server reads
// the batch, its pages, the catalog and stores. Mirrors BatchReview's shape — header,
// the store/period card, the grouped page-tab rows, and the review table — so the page
// paints immediately and nothing jumps when the real content streams in. No client JS.

import {cn} from '@/lib/utils';

function Bar({className}: {className?: string}) {
  return <div className={cn('rounded-md bg-muted motion-safe:animate-pulse', className)} />;
}

export function BatchReviewSkeleton() {
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-5 px-4 pt-6 pb-6" role="status" aria-busy="true" aria-label="Loading this form">
      {/* Header: back link + title */}
      <div className="flex flex-col gap-2">
        <Bar className="h-3 w-28" />
        <div className="flex flex-wrap items-center gap-3">
          <Bar className="h-7 w-56" />
          <Bar className="h-4 w-40" />
        </div>
      </div>

      {/* Store, period and BA card */}
      <div className="flex flex-col gap-3 rounded-xl border bg-card p-6">
        <Bar className="h-3 w-64" />
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1.5">
            <Bar className="h-2.5 w-12" />
            <Bar className="h-9 w-40" />
          </div>
          <div className="flex flex-col gap-1.5">
            <Bar className="h-2.5 w-10" />
            <Bar className="h-9 w-36" />
          </div>
          <div className="flex flex-col gap-1.5">
            <Bar className="h-2.5 w-10" />
            <Bar className="h-9 w-36" />
          </div>
          <div className="flex min-w-48 flex-1 flex-col gap-1.5">
            <Bar className="h-2.5 w-24" />
            <Bar className="h-9 w-full" />
          </div>
        </div>
      </div>

      {/* Page-tab strip: a few labelled rows, each with chips */}
      <div className="flex flex-col gap-1.5 rounded-xl border bg-card p-4">
        {Array.from({length: 5}, (_, i) => (
          <div key={i} className="flex items-center gap-2 py-1">
            <Bar className="h-3 w-14" />
            <Bar className="h-7 w-16 rounded-full" />
            {i % 2 === 0 && <Bar className="h-7 w-16 rounded-full" />}
          </div>
        ))}
      </div>

      {/* Review table: a header row and item rows */}
      <div className="flex flex-col overflow-hidden rounded-xl border bg-card">
        <div className="flex items-center gap-3 border-b px-4 py-3">
          <Bar className="h-7 w-full max-w-md" />
          <Bar className="ml-auto h-7 w-28" />
        </div>
        {Array.from({length: 7}, (_, i) => (
          <div key={i} className="flex items-center gap-4 border-b px-4 py-3 last:border-b-0">
            <div className="flex flex-1 flex-col gap-1.5">
              <Bar className="h-3.5 w-36" />
              <Bar className="h-2.5 w-52" />
            </div>
            <Bar className="h-8 w-12 rounded-md" />
            <Bar className="h-8 w-12 rounded-md max-md:hidden" />
            <Bar className="h-8 w-12 rounded-md max-md:hidden" />
            <Bar className="h-8 w-12 rounded-md" />
          </div>
        ))}
      </div>
      <span className="sr-only">Loading this form…</span>
    </div>
  );
}
