'use client';

import {useEffect, useState, type RefObject} from 'react';
import {ArrowDown} from 'lucide-react';
import {summarizeConfidence, toneText, type Band} from '@/src/review-confidence';
import {Button} from '@/components/ui/button';
import {cn} from '@/lib/utils';

// A condensed, sticky echo of the Document confidence summary. Once the full summary scrolls up
// under the app header, this keeps the score + verdict + "review flagged" pinned in view while
// the reviewer works down a long rows table — so they never lose the headline. It lives in the
// review content column (not inside the Document card) so it stays pinned past the card, and it
// is hidden until it would pin, so there is no empty bar at rest. Driven by a `watch` sentinel
// placed at the end of the full summary.

const TONE: Record<Band, string> = {
  high: 'var(--status-good)',
  medium: 'var(--status-warn)',
  low: 'var(--status-crit)',
};

export function ConfidenceSticky({
  watch,
  docConfidence,
  rowConfidences,
  page,
  onReviewFlagged,
}: {
  /** A sentinel at the end of the full summary; the bar shows once it scrolls above the header. */
  watch: RefObject<HTMLElement | null>;
  docConfidence: number | null;
  rowConfidences: Array<number | null | undefined>;
  page?: number | null;
  onReviewFlagged: () => void;
}) {
  const s = summarizeConfidence(docConfidence, rowConfidences);
  const tone = s.band ? TONE[s.band] : undefined;
  const [stuck, setStuck] = useState(false);

  useEffect(() => {
    const el = watch.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    // The app header is 3.5rem (56px); once the sentinel crosses above that line the full
    // summary is gone, so pin the condensed bar.
    const io = new IntersectionObserver(([e]) => setStuck(!e.isIntersecting), {rootMargin: '-60px 0px 0px 0px'});
    io.observe(el);
    return () => io.disconnect();
  }, [watch]);

  if (s.score == null) return null;

  return (
    <div
      aria-hidden={!stuck}
      className={cn(
        'pointer-events-none sticky top-[calc(3.5rem+0.4rem)] z-20 overflow-hidden transition-[max-height,opacity,transform] duration-200 ease-out motion-reduce:transition-none',
        stuck ? 'max-h-24 translate-y-0 opacity-100' : 'max-h-0 -translate-y-1 opacity-0',
      )}
    >
      <div
        className={cn('flex items-center gap-3 rounded-xl border bg-card/95 px-4 py-2.5 shadow-md backdrop-blur-sm', stuck && 'pointer-events-auto')}
        style={tone ? {borderColor: `color-mix(in oklab, ${tone} 38%, transparent)`} : undefined}
      >
        <span className="flex items-baseline gap-0.5 font-heading font-semibold tabular-nums" style={tone ? {color: tone} : undefined}>
          <span className="text-2xl">{Math.round(s.score * 100)}</span>
          <span className="text-sm">%</span>
        </span>
        <span
          className="inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-semibold"
          style={tone ? {color: toneText(tone), background: `color-mix(in oklab, ${tone} 16%, transparent)`} : undefined}
        >
          {s.verdict}
        </span>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground max-sm:hidden">{s.guidance}</span>
        {page ? <span className="shrink-0 text-xs text-muted-foreground max-md:hidden">page {page} of 5</span> : null}
        {s.counts.low > 0 && (
          <Button variant="outline" size="xs" onClick={onReviewFlagged} className="shrink-0">
            <ArrowDown className="size-3" /> {s.counts.low} flagged
          </Button>
        )}
      </div>
    </div>
  );
}
