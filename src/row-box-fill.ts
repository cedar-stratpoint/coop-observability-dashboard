// A row the position request missed still needs a pointer on the scan (older Legacy reads lack
// exactly their flagged rows: they weren't on the list sent for positions). The page prints its
// rows at an even pitch, so a missing row is placed between its located neighbours by counting
// printed lines, heading bars included. Estimates only; null when the neighbours don't allow a
// safe one. Pure.

export type Box = {y_top: number; y_bottom: number};
type Row = {item_code: string; box?: Box | null};

const norm = (s: string | null | undefined) => (s ?? '').toUpperCase().replace(/[^A-Z0-9]+/g, '');
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const usable = (b: Box | null | undefined): b is Box => Boolean(b && b.y_bottom > b.y_top);

/** The estimated box per row index, for rows without one. `headingOf` is the printed band; a band
 *  whose only line is its item (heading = product name) has no bar of its own. */
export function estimateRowBoxes(rows: Row[], headingOf: (code: string) => string | null | undefined, nameOf: (code: string) => string | null | undefined): Record<number, Box> {
  let line = -1;
  let prev: string | null = null;
  const lines = rows.map((r) => {
    const h = headingOf(r.item_code) ?? null;
    if (h !== prev && h && norm(h) !== norm(nameOf(r.item_code))) line++; // the heading bar
    prev = h;
    return ++line;
  });
  const anchors = rows.flatMap((r, i) => (usable(r.box) ? [{line: lines[i], y: (r.box.y_top + r.box.y_bottom) / 2, h: r.box.y_bottom - r.box.y_top}] : []));
  if (anchors.length < 4 || anchors.length === rows.length) return {};
  const steps = anchors.slice(1).map((a, k) => (a.y - anchors[k].y) / (a.line - anchors[k].line)).filter((d) => d > 0);
  if (steps.length < 3) return {};
  const pitch = median(steps);
  const height = median(anchors.map((a) => a.h));
  const out: Record<number, Box> = {};
  rows.forEach((r, i) => {
    if (usable(r.box)) return;
    const before = [...anchors].reverse().find((a) => a.line < lines[i]);
    const after = anchors.find((a) => a.line > lines[i]);
    let y: number | null = null;
    if (before && after) {
      const p = (after.y - before.y) / (after.line - before.line);
      // Neighbours spaced nothing like the rest of the page: the lines between aren't what we think.
      if (p > pitch * 0.6 && p < pitch * 1.6) y = before.y + p * (lines[i] - before.line);
    } else if (before && lines[i] - before.line <= 4) y = before.y + pitch * (lines[i] - before.line);
    else if (after && after.line - lines[i] <= 4) y = after.y - pitch * (after.line - lines[i]);
    if (y == null || y - height / 2 < 0 || y + height / 2 > 1) return;
    out[i] = {y_top: y - height / 2, y_bottom: y + height / 2};
  });
  return out;
}
