import {MANIFESTS} from './goldline-extract';

// Plain-language tags for SKU linking (Oct 27). Justin and his dad read these, so
// each tag says what happened and what to do next, instead of short labels like
// "Needs a pick". Pure, so the page and the tests share it.

export type SkuStatus = 'check' | 'choose' | 'rejected' | 'linked' | 'formOnly';
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
  formOnly: {
    label: 'On our forms, not in Watsons sales',
    help: 'Items on the inventory forms with no Watsons SKU yet. They get one when it is chosen for a SKU above.',
    tone: 'info',
  },
};

/** Which tag a Watsons SKU gets. A new suggestion after a reject shows as "check it". */
export function skuStatus(r: StatusInput): Exclude<SkuStatus, 'formOnly'> {
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
