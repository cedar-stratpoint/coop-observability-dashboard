import {ChevronLeft} from 'lucide-react';
import {ReturnLink} from '@/components/analyst/back-nav';

/**
 * The "‹ Uploads" breadcrumb: a link up to the uploads list.
 *
 * It used to step back through history (`router.back()`), but every filter click on these
 * boards was a history entry, so Back walked back through the filters instead of leaving the
 * page; it then became a fixed link, which forgot the list's filters and scroll. Filters now use
 * replaceState (never Back steps), and this is a ReturnLink: from a scan you opened on the list,
 * it returns to the list exactly as you left it (filters, scroll, the tile marked); from a deep
 * link it is the fixed `fallback`, as before.
 */
export function BackButton({fallback, label, className}: {fallback: string; label: string; className?: string}) {
  return (
    <ReturnLink listKey="uploads" fallback={fallback} className={className ?? 'inline-flex shrink-0 items-center gap-1 transition-colors hover:text-foreground'}>
      <ChevronLeft className="size-4" /> {label}
    </ReturnLink>
  );
}
