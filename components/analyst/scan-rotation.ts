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
