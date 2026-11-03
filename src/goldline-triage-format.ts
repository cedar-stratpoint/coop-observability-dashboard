// Phase 2 — pure formatting for the triage board (labels, tones, period text). No
// React, no DB, so it unit-tests. Tones reuse the Coop --status-* tokens; version
// colors are kept distinct from the semantic status colors.

import type {FormVersion} from './goldline-extract';

export const VERSION_LABEL: Record<FormVersion, string> = {
  legacy: 'Legacy',
  v1: 'V1',
  v2: 'V2',
  unknown: 'Unknown version',
};

/** A CSS color per version for its pill. Legacy = plum, V1 = steel blue, V2 = the
 *  Coop ochre/primary, unknown = muted. Distinct from the good/warn/crit status set. */
export const VERSION_COLOR: Record<FormVersion, string> = {
  legacy: 'var(--version-legacy, #6d4c9a)',
  v1: 'var(--version-v1, #3f6f99)',
  v2: 'var(--version-v2, #b06f2b)',
  unknown: 'var(--muted-foreground)',
};

/** Human labels for the segmentation flags surfaced on a card. */
export const FLAG_LABEL: Record<string, string> = {
  'duplicate-pages': 'Duplicate pages',
  incomplete: 'Missing pages',
  'unknown-version': 'Unknown version',
  'unknown-store': 'Store not matched',
  'store-corrected': 'Store auto-corrected',
  'store-unmatched': 'Store needs a pick',
  'period-missing': 'No period read',
  'period-unparsed': 'Period unreadable',
  'period-invalid-day': 'Invalid date',
  'period-partial': 'Partial cut-off',
  'period-mismatch': 'Dates disagree',
};

/** The tone (status token) a flag should read as: warn for things a reviewer should
 *  check, crit for things that block a clean commit. */
export function flagTone(flag: string): 'warn' | 'crit' | 'info' {
  if (flag === 'duplicate-pages' || flag === 'unknown-version' || flag === 'store-unmatched' || flag === 'period-invalid-day') {
    return 'crit';
  }
  if (flag === 'store-corrected') return 'info';
  return 'warn';
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function parts(iso: string | null): {y: number; m: number; d: number} | null {
  if (!iso) return null;
  const mt = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(iso.trim());
  if (!mt) return null;
  return {y: Number(mt[1]), m: Number(mt[2]), d: Number(mt[3])};
}

/**
 * A readable period label using "to" (never a dash — house copy rule). Collapses the
 * month/year when both ends share them: "Sep 1 to 15, 2026", else "Sep 16 to Oct 2,
 * 2026". Falls back gracefully when a date is missing.
 */
export function fmtTriagePeriod(start: string | null, end: string | null): string {
  const s = parts(start);
  const e = parts(end);
  if (!s && !e) return 'No period';
  if (s && !e) return `${MONTHS[s.m - 1]} ${s.d}, ${s.y}`;
  if (!s && e) return `to ${MONTHS[e.m - 1]} ${e.d}, ${e.y}`;
  if (s && e) {
    if (s.y === e.y && s.m === e.m) return `${MONTHS[s.m - 1]} ${s.d} to ${e.d}, ${s.y}`;
    if (s.y === e.y) return `${MONTHS[s.m - 1]} ${s.d} to ${MONTHS[e.m - 1]} ${e.d}, ${s.y}`;
    return `${MONTHS[s.m - 1]} ${s.d}, ${s.y} to ${MONTHS[e.m - 1]} ${e.d}, ${e.y}`;
  }
  return 'No period';
}

/** The period-bucket heading a form sits under, e.g. "Sep 2026 · first half". */
export function periodHeading(start: string | null, end: string | null): string {
  const s = parts(start) ?? parts(end);
  if (!s) return 'No period';
  const half = s.d < 16 ? 'first half' : 'second half';
  return `${MONTHS[s.m - 1]} ${s.y} · ${half}`;
}

/** Sort key for a period heading (year, month, half), so groups read chronologically. */
export function periodSortKey(start: string | null, end: string | null): string {
  const s = parts(start) ?? parts(end);
  if (!s) return '9999';
  return `${s.y}-${String(s.m).padStart(2, '0')}-${s.d < 16 ? '1' : '2'}`;
}
