// Instant placeholder shown while a server-rendered page loads (route loading.tsx).
// Mirrors the Goldline page shape — title, tiles, a table — so navigation feels
// immediate and nothing jumps when the real page arrives. No client JS.

import {cn} from '@/lib/utils';

function Bar({className}: {className?: string}) {
  return <div className={cn('rounded-md bg-muted motion-safe:animate-pulse', className)} />;
}

export function PageSkeleton({label, tiles = 4, rows = 8, chart = false}: {label: string; tiles?: number; rows?: number; chart?: boolean}) {
  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-6 px-4 py-6" role="status" aria-busy="true" aria-label={`Loading ${label}`}>
      <div className="flex flex-col gap-3">
        <Bar className="h-7 w-48" />
        <Bar className="h-8 w-64" />
        <div className="h-0.5 w-24 rounded-full bg-gradient-to-r from-primary/40 to-transparent" aria-hidden />
      </div>
      {tiles > 0 && (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {Array.from({length: tiles}, (_, i) => (
            <div key={i} className="flex h-28 flex-col justify-center gap-3 rounded-xl border bg-card px-4">
              <Bar className="h-3 w-24" />
              <Bar className="h-6 w-16" />
              <Bar className="h-3 w-32" />
            </div>
          ))}
        </div>
      )}
      {chart && <Bar className="h-80 w-full rounded-xl" />}
      <div className="flex flex-col overflow-hidden rounded-xl border bg-card">
        <div className="flex items-center gap-2 border-b px-4 py-3">
          <Bar className="h-7 w-72" />
          <Bar className="ml-auto h-7 w-48" />
        </div>
        {Array.from({length: rows}, (_, i) => (
          <div key={i} className="flex items-center gap-4 border-b px-4 py-3 last:border-b-0">
            <div className="flex flex-1 flex-col gap-1.5">
              <Bar className="h-3.5 w-40" />
              <Bar className="h-2.5 w-56" />
            </div>
            <Bar className="h-5 w-16 rounded-full" />
            <Bar className="h-3.5 w-10" />
            <Bar className="h-3.5 w-10 max-md:hidden" />
            <Bar className="h-3.5 w-14 max-md:hidden" />
          </div>
        ))}
      </div>
      <span className="sr-only">Loading {label}…</span>
    </div>
  );
}
