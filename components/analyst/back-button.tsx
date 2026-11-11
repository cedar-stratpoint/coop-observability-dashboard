import Link from 'next/link';
import {ChevronLeft} from 'lucide-react';

/**
 * The "‹ Uploads" breadcrumb: a direct link up to a fixed destination (the uploads list).
 *
 * It used to step back through history (`router.back()`) to land on wherever you came from,
 * filter and scroll intact. But these boards are filter-heavy: every view tab, version card,
 * store chip and BA filter you click is a history entry, so Back just walked back through the
 * filters you pressed instead of leaving the page. A breadcrumb names a fixed ancestor, so this
 * goes straight there regardless of how you got here.
 */
export function BackButton({fallback, label, className}: {fallback: string; label: string; className?: string}) {
  return (
    <Link href={fallback} className={className ?? 'inline-flex shrink-0 items-center gap-1 transition-colors hover:text-foreground'}>
      <ChevronLeft className="size-4" /> {label}
    </Link>
  );
}
