'use client';

import {ArrowDown, Info} from 'lucide-react';
import {summarizeConfidence, toneText, type Band} from '@/src/review-confidence';
import {metricValueClass} from '@/components/analyst/metric';
import {Button} from '@/components/ui/button';
import {cn} from '@/lib/utils';

// The review page's confidence summary: how sure the OCR was, said three ways so it
// reads at a glance — a big colored score, a plain verdict + what to do next, and the
// spread across rows (high / medium / low), since an average can hide a few bad rows.
// "Review N flagged rows" jumps straight to them.

const TONE: Record<Band, string> = {
  high: 'var(--status-good)',
  medium: 'var(--status-warn)',
  low: 'var(--status-crit)',
};
const BAND_LABEL: Record<Band, string> = {high: 'High', medium: 'Medium', low: 'Low'};

export function DocumentConfidence({
  docConfidence,
  rowConfidences,
  onReviewFlagged,
}: {
  docConfidence: number | null;
  rowConfidences: Array<number | null | undefined>;
  onReviewFlagged: () => void;
}) {
  const s = summarizeConfidence(docConfidence, rowConfidences);
  const tone = s.band ? TONE[s.band] : undefined;
  const bands: Band[] = ['high', 'medium', 'low'];

  return (
    <section
      aria-label="Reading confidence"
      className="flex flex-col gap-4 rounded-xl border p-4"
      style={
        tone
          ? {borderColor: `color-mix(in oklab, ${tone} 35%, transparent)`, background: `color-mix(in oklab, ${tone} 6%, transparent)`}
          : undefined
      }
    >
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
        <div className="flex items-baseline gap-1" style={tone ? {color: tone} : undefined}>
          <span className={cn(metricValueClass, 'text-5xl')}>{s.score == null ? '—' : Math.round(s.score * 100)}</span>
          {s.score != null && <span className="text-2xl font-medium">%</span>}
        </div>
        <div className="flex min-w-[14rem] flex-1 flex-col gap-1">
          <span
            className="inline-flex w-fit items-center rounded-full px-2.5 py-0.5 text-xs font-semibold"
            style={tone ? {color: toneText(tone), background: `color-mix(in oklab, ${tone} 16%, transparent)`} : undefined}
          >
            {s.verdict}
          </span>
          <p className="text-sm text-foreground">{s.guidance}</p>
        </div>
        {s.counts.low > 0 && (
          <Button variant="outline" size="sm" onClick={onReviewFlagged}>
            <ArrowDown className="size-3.5" />
            Review {s.counts.low} flagged {s.counts.low === 1 ? 'row' : 'rows'}
          </Button>
        )}
      </div>

      {s.total > 0 && (
        <div className="flex flex-col gap-2">
          <div
            className="flex h-2.5 w-full gap-0.5 overflow-hidden rounded-full"
            role="img"
            aria-label={`Rows by confidence: ${s.counts.high} high, ${s.counts.medium} medium, ${s.counts.low} low, of ${s.total}`}
          >
            {bands.map((b) =>
              s.counts[b] ? (
                <span key={b} className="h-full first:rounded-l-full last:rounded-r-full" style={{flexGrow: s.counts[b], background: TONE[b]}} />
              ) : null,
            )}
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            {bands.map((b) => (
              <span key={b} className="inline-flex items-center gap-1.5">
                <span aria-hidden className="size-2 rounded-full" style={{background: TONE[b]}} />
                <span className="font-medium text-foreground tabular-nums">{s.counts[b]}</span> {BAND_LABEL[b].toLowerCase()}
              </span>
            ))}
            <span className="ml-auto inline-flex items-center gap-1">
              <Info className="size-3" aria-hidden />
              The reader&apos;s own estimate, not a guarantee. The scan is the source of truth.
            </span>
          </div>
        </div>
      )}
    </section>
  );
}
