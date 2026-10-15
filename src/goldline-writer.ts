// Goldline "writer profile" (pure, unit-tested). Claude can't be fine-tuned on one
// person's handwriting, so the reader learns it in-context instead, from pages a
// human already reviewed and committed:
//   1. a REFERENCE page: a confirmed scan of the same form page by the same writer,
//      sent with its confirmed values, so the model sees how this person forms digits;
//   2. WRITER NOTES: the digits the reader misread before (reader's value vs the value
//      the reviewer confirmed), so known confusions (e.g. this writer's 8 read as 5)
//      are called out on every read.
// Phase 1 has one writer across the pilot stores, so the profile is company-wide and
// prefers the same store when it's known. The review gate is unchanged: nothing the
// reader produces is saved to inventory until a person confirms it.

import {COLUMN_KEYS, type ColumnKey} from './goldline-extract';

export type Counts = Partial<Record<ColumnKey, number | null>> & {item_code: string};

/** One cell the reviewer changed: what the reader read vs what was confirmed. */
export type Correction = {uploadId: string; itemCode: string; column: ColumnKey; read: number | null; confirmed: number | null};

/** Reader accuracy over a set of reviewed pages (handwritten cells only). */
export type ReaderStats = {pages: number; cells: number; corrected: number};

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : null);

/**
 * Compare the reader's rows with the confirmed rows for ONE upload. Only items present
 * in both are compared (an item missing from inventory was overwritten by a later
 * upload, so it no longer reflects this review). `cells` counts values that were
 * written (confirmed) or that the reader saw (a stray mark read as a number): the
 * denominator for accuracy, so every correction is inside it.
 */
export function diffUpload(uploadId: string, reader: Counts[], confirmed: Counts[]): {cells: number; corrections: Correction[]} {
  const byCode = new Map(reader.map((r) => [r.item_code, r]));
  let cells = 0;
  const corrections: Correction[] = [];
  for (const c of confirmed) {
    const r = byCode.get(c.item_code);
    if (!r) continue;
    for (const col of COLUMN_KEYS) {
      const want = num(c[col]);
      const got = num(r[col]);
      if (want !== null || got !== null) cells++; // written, or read as written: both can be wrong
      if (want !== got) corrections.push({uploadId, itemCode: c.item_code, column: col, read: got, confirmed: want});
    }
  }
  return {cells, corrections};
}

/** Digit-level confusions from corrections: "5 read where 8 was written", counted.
 *  Only a same-length number with exactly ONE differing digit is a digit confusion;
 *  a swap (15 vs 51) or several wrong digits would only add noise to the notes, so
 *  those count as other misreads, like a dropped or added digit. */
export function digitConfusions(corrections: Correction[]): {pairs: Map<string, number>; blanksRead: number; missed: number; lengthChanges: number} {
  const pairs = new Map<string, number>();
  let blanksRead = 0;
  let missed = 0;
  let lengthChanges = 0;
  for (const c of corrections) {
    if (c.confirmed === null) {
      blanksRead++;
      continue;
    }
    if (c.read === null) {
      missed++;
      continue;
    }
    const a = String(Math.abs(c.read));
    const b = String(Math.abs(c.confirmed));
    const diff = a.length === b.length ? [...a].flatMap((ch, i) => (ch !== b[i] ? [i] : [])) : [];
    if (diff.length !== 1) {
      lengthChanges++;
      continue;
    }
    const k = `${a[diff[0]]}>${b[diff[0]]}`;
    pairs.set(k, (pairs.get(k) ?? 0) + 1);
  }
  return {pairs, blanksRead, missed, lengthChanges};
}

const times = (n: number) => (n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`);

/** The writer-notes text sent with each read; null when there's nothing learned yet. */
export function buildWriterNotes(corrections: Correction[], stats: ReaderStats, maxPairs = 12): string | null {
  if (!corrections.length) return null;
  const {pairs, blanksRead, missed, lengthChanges} = digitConfusions(corrections);
  const lines: string[] = [];
  [...pairs.entries()]
    .sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))
    .slice(0, maxPairs)
    .forEach(([k, n]) => {
      const [read, wrote] = k.split('>');
      lines.push(`- This writer's ${wrote} was misread as ${read} (${times(n)}). When a digit looks like ${read}, check whether it is this writer's ${wrote}.`);
    });
  if (blanksRead) lines.push(`- A mark in an empty cell was read as a number ${times(blanksRead)}. Stray marks, dashes and ticks are not counts.`);
  if (missed) lines.push(`- A written number was missed (read as empty) ${times(missed)}. Look closely at faint or small numbers.`);
  if (lengthChanges) lines.push(`- A number was misread by more than one digit, or a digit was dropped or added (${times(lengthChanges)}). Count the digits in each cell.`);
  // Recent concrete examples help more than counts alone.
  const examples = corrections
    .filter((c) => c.read !== null && c.confirmed !== null)
    .slice(0, 6)
    .map((c) => `${c.itemCode} ${c.column}: read ${c.read}, written ${c.confirmed}`);
  return [
    `WRITER NOTES: learned from ${stats.pages} page(s) of this writer that a person reviewed (${stats.cells} handwritten numbers, ${stats.corrected} corrected).`,
    ...lines,
    ...(examples.length ? [`Recent corrections: ${examples.join('; ')}.`] : []),
  ].join('\n');
}

/** A candidate reference page: a committed upload of the same form page. */
export type ReferenceCandidate = {uploadId: string; storeCode: string | null; createdAt: string; cells: number};

/** The handwritten-cell floor for a useful reference (page 4 is often near-blank). */
export const MIN_REFERENCE_CELLS = 8;

/** Pick the reference: the newest well-filled page from the same store, else from any
 *  store (one writer in Phase 1). Null when no reviewed page qualifies yet. */
export function pickReference(cands: ReferenceCandidate[], storeCode: string | null): ReferenceCandidate | null {
  const ok = cands.filter((c) => c.cells >= MIN_REFERENCE_CELLS).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (!ok.length) return null;
  return (storeCode ? ok.find((c) => c.storeCode === storeCode) : undefined) ?? ok[0];
}

/** The text that sits after the reference scan: its confirmed values, filled rows only. */
export function buildReferenceText(page: number, rows: Counts[]): string {
  const fmt = (v: number | null | undefined) => (v === null || v === undefined ? '_' : String(v));
  const filled = rows.filter((r) => COLUMN_KEYS.some((k) => num(r[k]) !== null));
  return [
    `REFERENCE: the scan above is an earlier copy of PAGE ${page}, filled in by the same person and already checked by a reviewer.`,
    'Its confirmed values, as item: stockroom/drawer/selling_area/delivery/ending_on_hand (_ = empty):',
    `  ${filled.map((r) => `${r.item_code} ${COLUMN_KEYS.map((k) => fmt(num(r[k]))).join('/')}`).join(' · ')}`,
    "Use it only to learn how this person writes each digit. Do NOT copy its values: the next scan is a different count.",
  ].join('\n');
}
