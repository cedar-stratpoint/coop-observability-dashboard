// Band prices (QA San Pablo, Nov 25). PURE so it unit-tests.
//
// A heading band prints one unit price (ULTRA STAY MATTE LIQUID LIP COLOR, ₱225). Consultants
// sometimes write their own price beside it (180) and total the band at that price
// (36 pcs × 180 = ₱6,480). Coop read both but never said so: the band check only spoke when the
// numbers disagreed, and here they agree at the written price. So every read now saves each
// band's paper total and written price with the page, and a band whose paper says a different
// price gets ONE flag, on the band. The reviewer picks the price for this form ("Use ₱180" or
// "Keep ₱225"); the catalog never changes. Unanswered, the form commits at the printed price.
//
// Two ways a band says "another price":
//  - written: the reader saw a handwritten price that differs from the printed one;
//  - implied: no price was read, but the paper total only works at another whole price
//    (₱6,480 ÷ 36 pcs = ₱180) and not at the printed one.

/** What the paper says for one band, as read. */
export type PaperTotal = {family: string; amount: number | null; written_price?: number | null};

/** One band as saved on the page (extractions.rows.bands). */
export type PaperBand = {
  /** The printed heading, as on the form. */
  group: string;
  /** Handwritten "Total Amount of Ending Inventory" for the band, pesos; null when none read. */
  amount: number | null;
  /** Handwritten unit price beside the band, when the reader saw one; else null. */
  written_price: number | null;
  /** The band's printed unit price. */
  printed_price: number | null;
  /** Pieces on hand across the band's rows at read time. */
  pieces: number;
  /** Why the band is flagged, or null when the paper agrees with the printed price. */
  kind: 'written' | 'implied' | null;
  /** The other price the paper points at (written, or implied by the total). */
  offer_price: number | null;
  /** Row index of the band's first row on the page: where its one flag sits. */
  first_index: number | null;
  /** Item codes in the band, page order. */
  codes: string[];
  /** The reviewer's pick for this form: the offered or printed price. Absent = not answered. */
  use_price?: number | null;
};

type Item = {code: string; group: string | null; price: number | null};
type Row = {item_code: string; ending_on_hand?: number | null};

const keyOf = (s: string) => s.toUpperCase().replace(/[^A-Z0-9#&]+/g, '');
const peso = (n: number) => `₱${n.toLocaleString('en-US')}`;
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Printed items grouped into consecutive heading bands, each with one price when all agree. */
function bandsOf(items: Item[]): Array<{group: string; price: number | null; items: Item[]}> {
  const out: Array<{group: string; price: number | null; items: Item[]}> = [];
  for (const it of items) {
    if (!it.group) continue;
    const last = out[out.length - 1];
    if (last && last.group === it.group) last.items.push(it);
    else out.push({group: it.group, price: null, items: [it]});
  }
  for (const b of out) {
    const prices = new Set(b.items.map((i) => i.price));
    b.price = prices.size === 1 ? b.items[0].price : null;
  }
  return out;
}

/** The paper total written for a band: same heading, or one clearly containing the other. */
function paperFor(group: string, paper: PaperTotal[]): PaperTotal | null {
  const k = keyOf(group);
  return paper.find((t) => {
    const tk = keyOf(t.family ?? '');
    return tk === k || (tk.length > 4 && (tk.includes(k) || k.includes(tk)));
  }) ?? null;
}

/**
 * Each printed band with its paper total and the price check. Rows are matched to printed lines
 * by code in page order (several accessories share one code). Only bands with one printed price
 * and something on paper (a total or a written price) are returned.
 */
export function checkBands(items: Item[], rows: Row[], paper: PaperTotal[]): PaperBand[] {
  const queue = new Map<string, number[]>();
  rows.forEach((r, i) => queue.set(r.item_code, [...(queue.get(r.item_code) ?? []), i]));
  const indexOf = new Map<Item, number>();
  for (const it of items) {
    const i = queue.get(it.code)?.shift();
    if (i != null) indexOf.set(it, i);
  }
  const out: PaperBand[] = [];
  for (const band of bandsOf(items)) {
    const printed = band.price;
    if (printed == null || !(printed > 0)) continue;
    const p = paperFor(band.group, paper);
    if (!p) continue;
    const amount = num(p.amount) != null && (p.amount as number) > 0 ? (p.amount as number) : null;
    const written = num(p.written_price) != null && (p.written_price as number) > 0 ? (p.written_price as number) : null;
    if (amount == null && written == null) continue;
    const idx = band.items.map((it) => indexOf.get(it)).filter((i): i is number => i != null);
    const pieces = idx.reduce((a, i) => a + (num(rows[i].ending_on_hand) ?? 0), 0);
    let kind: PaperBand['kind'] = null;
    let offer: number | null = null;
    if (written != null && written !== printed) {
      kind = 'written';
      offer = written;
    } else if (written == null && amount != null && pieces > 0 && Math.abs(amount - pieces * printed) > 1) {
      // Only a whole peso price in a believable range: a misread count makes nonsense prices,
      // and those stay with the ordinary "total doesn't match" note.
      const implied = amount / pieces;
      const whole = Math.round(implied);
      if (Math.abs(implied - whole) < 1e-6 && whole !== printed && whole >= printed * 0.25 && whole <= printed * 2) {
        kind = 'implied';
        offer = whole;
      }
    }
    out.push({
      group: band.group,
      amount,
      written_price: written,
      printed_price: printed,
      pieces,
      kind,
      offer_price: offer,
      first_index: idx.length ? Math.min(...idx) : null,
      codes: band.items.map((it) => it.code),
    });
  }
  return out;
}

/** True when a band is flagged and nobody has picked its price yet. */
export const bandOpen = (b: PaperBand): boolean => b.kind != null && b.offer_price != null && b.first_index != null && b.use_price == null;

/** Row indexes carrying an open band flag (one per band, on its first row). */
export function bandFlagRows(bands: readonly PaperBand[] | null | undefined): number[] {
  return (bands ?? []).filter(bandOpen).map((b) => b.first_index as number);
}

/** A page's rows that need review: low confidence, plus one row per open band flag. Sorted. */
export function flaggedRowIndexes(
  page: {rows?: ReadonlyArray<{confidence?: unknown}> | null; bands?: readonly PaperBand[] | null} | null | undefined,
  below: number,
): number[] {
  const set = new Set<number>();
  (page?.rows ?? []).forEach((r, i) => {
    const c = typeof r.confidence === 'number' && Number.isFinite(r.confidence) ? r.confidence : 1;
    if (c < below) set.add(i);
  });
  for (const i of bandFlagRows(page?.bands)) if (i < (page?.rows?.length ?? 0)) set.add(i);
  return [...set].sort((a, b) => a - b);
}

/** The band's flag in words, for the row line and the reports (≤ 200 chars). */
export function bandNote(b: PaperBand): string {
  if (b.kind == null || b.offer_price == null || b.printed_price == null) return '';
  const head = b.kind === 'written'
    ? `${peso(b.offer_price)} written beside the band, printed ${peso(b.printed_price)}`
    : `Paper total fits ${peso(b.offer_price)} a piece, not the printed ${peso(b.printed_price)}`;
  const total = b.amount != null ? `. Paper total ${peso(b.amount)}` : '';
  return `${head}${total}`.slice(0, 200);
}

/** The prices a reviewer may pick for a band: its printed price or the one the paper offers. */
export function allowedPrices(b: PaperBand): number[] {
  return [b.printed_price, b.offer_price].filter((p): p is number => p != null && p > 0);
}

/** The price each code on the page is valued at for this form: the band's pick when it differs
 *  from the printed price. */
export function pickedPrices(bands: readonly PaperBand[] | null | undefined): Map<string, number> {
  const out = new Map<string, number>();
  for (const b of bands ?? []) {
    if (b.use_price == null || b.use_price === b.printed_price) continue;
    for (const c of b.codes) out.set(c, b.use_price);
  }
  return out;
}

/** Overlay the picked prices on a code → {unitPrice} catalog (review totals and headings). */
export function withPickedPrices<C extends {unitPrice: number | null}>(catalog: Record<string, C>, bands: readonly PaperBand[] | null | undefined): Record<string, C> {
  const picked = pickedPrices(bands);
  if (!picked.size) return catalog;
  const out: Record<string, C> = {...catalog};
  for (const [code, price] of picked) if (out[code]) out[code] = {...out[code], unitPrice: price};
  return out;
}

/** Stamp the picked price on committed rows (inventory.extra.unit_price), so the count keeps
 *  the price this form was valued at. Rows of bands without a pick are left as they are. */
export function stampPickedPrices<R extends {item_code: string; extra?: Record<string, number | null> | null}>(rows: R[], bands: readonly PaperBand[] | null | undefined): R[] {
  const picked = pickedPrices(bands);
  if (!picked.size) return rows;
  return rows.map((r) => {
    const p = picked.get(r.item_code);
    return p == null ? r : {...r, extra: {...(r.extra ?? {}), unit_price: p}};
  });
}

/** Clean bands from stored JSON (never trust the shape of an old or hand-edited page). */
export function cleanBands(v: unknown): PaperBand[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((b): b is Record<string, unknown> => Boolean(b) && typeof b === 'object' && typeof (b as {group?: unknown}).group === 'string')
    .map((b) => ({
      group: b.group as string,
      amount: num(b.amount),
      written_price: num(b.written_price),
      printed_price: num(b.printed_price),
      pieces: num(b.pieces) ?? 0,
      kind: b.kind === 'written' || b.kind === 'implied' ? b.kind : null,
      offer_price: num(b.offer_price),
      first_index: num(b.first_index),
      codes: Array.isArray(b.codes) ? b.codes.filter((c): c is string => typeof c === 'string') : [],
      ...(num(b.use_price) != null ? {use_price: num(b.use_price)} : {}),
    }));
}
