// What the page review says next to Store when Coop isn't sure of the store it read (QA Nov 26:
// "Coop read Store 2944" showed with no warning, although 2944 isn't a store and the page says
// "SM Center Pulilan" = 2414). PURE so it unit-tests. No dashes in the copy (workspace UI rule).

import type {StoreCheck} from './goldline-data';

export type StoreCheckNote = {
  text: string;
  /** One click to put a store in the Store field: the likely store, or back to the code as read. */
  action: {label: string; code: string} | null;
};

/**
 * The note for a page's store check, given the store currently prefilled (`code`) and a lookup for
 * registry names. Null when there is nothing to say (no check, or the reviewer already changed the
 * store away from Coop's prefill, which the caller decides).
 */
export function storeCheckNote(
  check: StoreCheck | null | undefined,
  code: string,
  nameOf: (code: string) => string | null,
  /** The store name written on the page, said when it isn't the store suggested (QA Nov 26, p30:
   *  "Did you mean 1269 · Premier Plaza" read oddly beside a page that says Gaisano Central Surigao). */
  writtenName?: string | null,
): StoreCheckNote | null {
  if (!check) return null;
  const written = writtenName?.trim() ? ` The page says “${writtenName.trim()}”.` : '';
  const label = (c: string) => {
    const n = nameOf(c);
    return n ? `${c} · ${n}` : c;
  };
  const first = check.candidates.find((c) => c !== code) ?? null;
  switch (check.status) {
    case 'corrected': {
      if (!check.from) return null;
      return check.by === 'name'
        ? {
            text: `Coop read ${check.from} on the page, which isn’t a known store. The store name written beside it matches ${label(code)}, so Coop used that. Check it against the page.`,
            action: {label: `Undo, use ${check.from}`, code: check.from},
          }
        : {
            text: `Coop read ${check.from} on the page, which isn’t a known store, and used the nearest one, ${label(code)}. Check it against the page.`,
            action: {label: `Undo, use ${check.from}`, code: check.from},
          };
    }
    case 'name_mismatch':
      return {
        text: first
          ? `Coop read Store ${label(code)}, but the store name written on the page points to ${label(first)}. Check which one is right.`
          : `Coop read Store ${label(code)}, but the store name written on the page points to another store. Check which one is right.`,
        action: first ? {label: `Use ${label(first)}`, code: first} : null,
      };
    case 'ambiguous':
    case 'unknown':
      return {
        text: first
          ? `Coop read ${code} on the page, which isn’t a known store. The nearest code is ${label(first)}.${written} Pick the right store.`
          : `Coop read ${code} on the page, which isn’t a known store.${written} Pick the store from the form.`,
        action: first ? {label: `Use ${label(first)}`, code: first} : null,
      };
    case 'from_form': {
      const where = check.fromPage ? `page ${check.fromPage} of this same form` : 'another page of this same form';
      return check.from
        ? {
            text: `Coop read ${check.from} on this page, which isn't a known store, so it used ${label(code)} from ${where}.`.replace("isn't", 'isn’t'),
            action: {label: `Undo, use ${check.from}`, code: check.from},
          }
        : {text: `No store code is written on this page. Coop used ${label(code)} from ${where}.`, action: null};
    }
    case 'missing':
      return first
        ? {
            text: `Coop couldn’t read a store code. The store name written on the page points to ${label(first)}.`,
            action: {label: `Use ${label(first)}`, code: first},
          }
        : null;
  }
}
