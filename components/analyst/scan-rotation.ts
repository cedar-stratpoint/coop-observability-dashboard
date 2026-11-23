'use client';

import {useCallback, useEffect, useState} from 'react';

// Upright scans in review. The reader turns an upside-down page only in memory while
// reading; the stored file keeps the scanner's orientation (28 of 98 pages on the
// October scan were upside down). Review shows each page turned by what the
// classifier detected, and the reviewer can flip any page the detection got wrong.
// That manual flip is remembered per upload, in this browser only.

const KEY = 'goldline-scan-flip';

/** Rotation to show a page at: the detected orientation, flipped once more when the reviewer asked. Pure. */
export function effectiveRotation(detected: number | null | undefined, flipped: boolean): 0 | 180 {
  const base = detected === 180 ? 180 : 0;
  return ((base + (flipped ? 180 : 0)) % 360) as 0 | 180;
}

function readFlips(): Record<string, true> {
  try {
    const raw = window.localStorage.getItem(KEY);
    const v = raw ? JSON.parse(raw) : {};
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

function writeFlips(flips: Record<string, true>) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(flips));
  } catch {
    // Storage blocked (private window): the flip still applies until the page reloads.
  }
}

/** The rotation for one upload's scan, and a toggle for the reviewer's Rotate 180° button. */
export function useScanRotation(uploadId: string | null | undefined, detected: number | null | undefined) {
  const [flips, setFlips] = useState<Record<string, true>>({});
  // Read after mount so the server render and the first client render agree.
  useEffect(() => setFlips(readFlips()), []);
  const flipped = Boolean(uploadId && flips[uploadId]);
  const toggle = useCallback(() => {
    if (!uploadId) return;
    setFlips((prev) => {
      const next = {...prev};
      if (next[uploadId]) delete next[uploadId];
      else next[uploadId] = true;
      writeFlips(next);
      return next;
    });
  }, [uploadId]);
  return {deg: effectiveRotation(detected, flipped), flipped, toggle};
}

type BoxRow = {item_code?: string; alt?: string | null; box?: {y_top: number; y_bottom: number} | null} | null | undefined;

/** The box to draw on the scan for the row the reviewer points at: its located box, tilted by the
 *  page's slant, and turned with the page when the reviewer flipped it (boxes are measured on the
 *  page as the reader saw it, upright). Labelled with the item code. Pure. */
export function scanPointBox(row: BoxRow, slant: {angle: number; px: number} | null | undefined, flipped: boolean) {
  const b = row?.box;
  if (!b || !(b.y_bottom > b.y_top)) return null;
  const height = b.y_bottom - b.y_top;
  const top = flipped ? 1 - b.y_bottom : b.y_top;
  const px = slant ? (flipped ? 1 - slant.px : slant.px) : undefined;
  // Code only: the reader's note is long and already shows on the highlighted row in the list.
  const label = row?.item_code || undefined;
  return {top, height, angle: slant?.angle, px, label};
}
