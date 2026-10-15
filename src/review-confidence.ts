// How sure the OCR read was, summarized for the review page (pure, unit-tested).
// Confidence is Claude's own per-row estimate — a routing signal, not a calibrated
// probability — so the page shows the spread across rows (an average can hide a
// few bad rows) and turns the score into a plain instruction for the reviewer.

export const LOW_BELOW = 0.6; // rows under this are flagged for human eyes
export const HIGH_FROM = 0.85;

export type Band = 'high' | 'medium' | 'low';

/** A usable row confidence: a finite number clamped to 0–1; anything else counts as
 *  1, matching how the review table already treats a missing value. */
export const rowConfidence = (c: unknown): number => (typeof c === 'number' && Number.isFinite(c) ? Math.min(1, Math.max(0, c)) : 1);

export const bandOf = (c: number): Band => (c >= HIGH_FROM ? 'high' : c >= LOW_BELOW ? 'medium' : 'low');

/** Readable text on a light tint of a status color: mixed toward the foreground so
 *  it clears AA at small sizes in both themes (raw amber on amber tint doesn't). */
export const toneText = (tone: string) => `color-mix(in oklab, ${tone} 72%, var(--foreground))`;

export type ConfidenceSummary = {
  score: number | null; // 0–1, the document's confidence (mean of rows)
  band: Band | null;
  counts: Record<Band, number>;
  total: number;
  verdict: string; // short label
  guidance: string; // what the reviewer should do
};

export function summarizeConfidence(docConfidence: number | null, rowConfidences: Array<number | null | undefined>): ConfidenceSummary {
  const counts: Record<Band, number> = {high: 0, medium: 0, low: 0};
  for (const c of rowConfidences) counts[bandOf(rowConfidence(c))]++;
  const total = rowConfidences.length;
  const score = typeof docConfidence === 'number' && Number.isFinite(docConfidence) ? Math.min(1, Math.max(0, docConfidence)) : null;
  const band = score == null ? null : bandOf(score);
  const flagged = counts.low;
  const rowsWord = (n: number) => `${n} ${n === 1 ? 'row' : 'rows'}`;

  let verdict = 'Not scored';
  let guidance = 'No confidence was recorded for this reading. Check it against the scan before committing.';
  if (band === 'high') {
    verdict = 'High confidence';
    guidance = flagged
      ? `The reading looks solid. Check the ${rowsWord(flagged)} flagged below, then commit.`
      : 'The reading looks solid. Spot-check a few rows against the scan, then commit.';
  } else if (band === 'medium') {
    verdict = 'Medium confidence';
    guidance = flagged
      ? `Review carefully: ${rowsWord(flagged)} flagged, and others may be off. Compare against the scan.`
      : 'Review carefully against the scan. Nothing is flagged, but the reading is less certain.';
  } else if (band === 'low') {
    verdict = 'Low confidence';
    guidance = 'Check every row against the scan. A clearer, flat, full-page scan usually reads much better.';
  }
  return {score, band, counts, total, verdict, guidance};
}
