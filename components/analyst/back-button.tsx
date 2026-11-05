'use client';

import {useRouter} from 'next/navigation';
import {ChevronLeft} from 'lucide-react';

/**
 * Go back to the page you actually came from, not a fixed destination. A breadcrumb
 * "‹ Uploads" that always pushes /uploads throws away where you were (Per-BA, a filter,
 * a scroll position); stepping back through history returns you there. `fallback` is used
 * only when there's no in-app history to step back to (a fresh deep link).
 */
export function BackButton({fallback, label, className}: {fallback: string; label: string; className?: string}) {
  const router = useRouter();
  return (
    <button
      type="button"
      onClick={() => {
        if (typeof window !== 'undefined' && window.history.length > 1) router.back();
        else router.push(fallback);
      }}
      className={className ?? 'inline-flex shrink-0 items-center gap-1 transition-colors hover:text-foreground'}
    >
      <ChevronLeft className="size-4" /> {label}
    </button>
  );
}
