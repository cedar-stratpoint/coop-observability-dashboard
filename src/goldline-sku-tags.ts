import {MANIFESTS} from './goldline-extract';

// Plain-language tags for SKU linking (Oct 27). Justin and his dad read these, so
// each tag says what happened and what to do next, instead of short labels like
// "Needs a pick". Pure, so the page and the tests share it.

export type SkuStatus = 'check' | 'choose' | 'rejected' | 'linked' | 'noSales' | 'formOnly' | 'decommissioned';
export type Tone = 'good' | 'warn' | 'crit' | 'info';

type StatusInput = {
  linked: {source: 'code' | 'match' | 'admin' | null} | null;
  suggestion: {tier: 'high' | 'medium' | 'low'} | null;
  review: {action: 'approved' | 'rejected' | 'linked' | 'unlinked' | null} | null;
};

export const SKU_TAGS: Record<SkuStatus, {label: string; help: string; tone: Tone}> = {
  check: {
    label: 'Coop found a likely match: check it',
    help: 'Coop thinks these are the same product. Approve if it is right, Reject if it is not.',
    tone: 'warn',
  },
  choose: {
    label: 'No match found: choose the item',
    help: 'Coop could not tell which of our items this is. Pick it from the list.',
    tone: 'crit',
  },
  rejected: {
    label: 'Rejected: choose the right item',
    help: 'Someone turned Coop’s match down. Pick the right item, or leave it for later.',
    tone: 'crit',
  },
  linked: {
    label: 'Linked',
    help: 'This SKU’s Watsons sales count for the item.',
    tone: 'good',
  },
  noSales: {
    label: 'No units sold: nothing to decide',
    help: 'Watsons lists these codes in its files, but none sold in the 12 months, so they change no count. Link one only if you know the item.',
    tone: 'info',
  },
  decommissioned: {
    label: 'Decommissioned',
    help: 'Marked as no longer made or sold. Left out of SKU matching and restock. Bring one back if that changes.',
    tone: 'info',
  },
  formOnly: {
    label: 'Sold at Watsons?',
    help: 'On our inventory forms, but no Watsons SKU is linked and Coop found no likely match. Some may be under “Choose our item” with a shortened Watsons name; picking one there links it.',
    tone: 'info',
  },
};

/** Which tag a Watsons SKU gets. A new suggestion after a reject shows as "check it". */
export function skuStatus(r: StatusInput): Exclude<SkuStatus, 'formOnly' | 'noSales' | 'decommissioned'> {
  if (r.linked) return 'linked';
  if (r.suggestion) return 'check';
  if (r.review?.action === 'rejected') return 'rejected';
  return 'choose';
}

/** The line under "Linked": how the link was made. */
export function linkedHow(r: StatusInput): string {
  switch (r.linked?.source) {
    case 'code':
      return 'Our item code is in the Watsons name';
    case 'match':
      return 'Matched by Coop (name and price agree)';
    case 'admin':
      return r.review?.action === 'approved' ? 'Coop’s match, approved' : 'Linked by hand';
    default:
      return 'Linked';
  }
}

/** How sure Coop is about a suggestion, in words. */
export function sureness(tier: 'high' | 'medium' | 'low'): string {
  return tier === 'low' ? 'Coop is not sure. Check it carefully.' : 'Coop is fairly sure.';
}

export const ACTION_WORD: Record<'approved' | 'rejected' | 'linked' | 'unlinked', string> = {
  approved: 'Approved',
  rejected: 'Rejected',
  linked: 'Linked by hand',
  unlinked: 'Unlinked',
};

export type FormSpot = {page: number; row: number};

/** Where an item is printed on the inventory form: page and row (1-based, printed order). */
export function formSpots(): Map<string, FormSpot> {
  const out = new Map<string, FormSpot>();
  for (const [page, items] of Object.entries(MANIFESTS)) {
    items.forEach((it, i) => {
      if (!out.has(it.code)) out.set(it.code, {page: Number(page), row: i + 1});
    });
  }
  return out;
}

export const formSpotText = (s: FormSpot | null | undefined) => (s ? `Page ${s.page} · row ${s.row}` : 'Not on the form');

/**
 * A Watsons name, easier to read: drops the leading "NICHIDO" every name carries, title
 * cases the rest, and keeps codes (words with letters and digits, like ELB160) in capitals.
 * The raw name stays available as a tooltip; Watsons cuts names short, so "Penci" stays.
 */
export function watsonsName(raw: string): string {
  const rest = raw.replace(/^\s*NICHIDO\s+/i, '').trim() || raw.trim();
  if (/[a-z]/.test(rest)) return rest;
  return rest
    .toLowerCase()
    .replace(/[a-z0-9#/&'+-]+/g, (w, i: number) => {
      if (/\d/.test(w) && /[a-z]/.test(w)) return w.toUpperCase(); // codes: ELB160, CS0164, 5G
      if (i > 0 && SMALL_WORDS.has(w)) return w;
      return w[0].toUpperCase() + w.slice(1);
    });
}
const SMALL_WORDS = new Set(['and', 'or', 'of', 'the', 'with', 'w', 'n', 'for', 'in', 'to']);
