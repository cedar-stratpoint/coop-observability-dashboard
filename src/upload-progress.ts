// Progress model for the Uploads screen (pure, unit-tested).
//
// Honesty rule: the bar only moves to a new band when the server reports a real
// milestone (see UploadStage in app/api/goldline/upload/route.ts). Inside a band it
// eases toward — but never reaches — the band's end, so a long scan keeps visibly
// moving without ever claiming to be done before it is. The upload band itself is
// a true byte percentage from the browser.

export type UploadKindGuess = 'csv' | 'pdf';
export type Phase = 'uploading' | 'stored' | 'parsing' | 'detecting' | 'reading' | 'saving' | 'done';

export type Step = {key: string; label: string; phases: Phase[]};

export const STEPS: Record<UploadKindGuess, Step[]> = {
  pdf: [
    {key: 'upload', label: 'Upload', phases: ['uploading']},
    {key: 'detect', label: 'Find the page', phases: ['stored', 'detecting']},
    {key: 'read', label: 'Read the counts', phases: ['reading']},
    {key: 'save', label: 'Save for review', phases: ['saving']},
  ],
  csv: [
    {key: 'upload', label: 'Upload', phases: ['uploading']},
    {key: 'parse', label: 'Read the rows', phases: ['stored', 'parsing']},
    {key: 'save', label: 'Save sales', phases: ['saving']},
  ],
};

/** [start, end, time-constant ms] of each phase's band, as % of the bar. */
const BANDS: Record<UploadKindGuess, Partial<Record<Phase, [number, number, number]>>> = {
  pdf: {stored: [14, 16, 1000], detecting: [16, 30, 4000], reading: [30, 92, 30000], saving: [94, 98, 1500]},
  csv: {stored: [52, 56, 800], parsing: [56, 80, 1500], saving: [82, 96, 2000]},
};
const UPLOAD_SHARE: Record<UploadKindGuess, number> = {pdf: 12, csv: 50};

/** Eases from 0 toward 1 with time constant tau; stays below 1. */
const approach = (t: number, tau: number) => (tau <= 0 ? 0 : 1 - Math.exp(-Math.max(0, t) / tau));

/** Bar position (0–100) for the current phase. */
export function progressFor(kind: UploadKindGuess, phase: Phase, uploadFraction: number, phaseElapsedMs: number): number {
  if (phase === 'done') return 100;
  if (phase === 'uploading') return UPLOAD_SHARE[kind] * Math.min(1, Math.max(0, uploadFraction));
  const band = BANDS[kind][phase];
  if (!band) return UPLOAD_SHARE[kind];
  const [start, end, tau] = band;
  return start + (end - start) * approach(phaseElapsedMs, tau);
}

/** Each step's state for the stepper, from the current phase. */
export function stepStates(kind: UploadKindGuess, phase: Phase): Array<Step & {state: 'done' | 'active' | 'pending'}> {
  const steps = STEPS[kind];
  const current = phase === 'done' ? steps.length : steps.findIndex((s) => s.phases.includes(phase));
  return steps.map((s, i) => ({...s, state: i < current ? 'done' : i === current ? 'active' : 'pending'}));
}

export const kindOfFile = (name: string): UploadKindGuess | null => {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  return ext === 'csv' ? 'csv' : ext === 'pdf' ? 'pdf' : null;
};
