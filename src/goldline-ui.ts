// Shared Goldline layout classes (plain strings — usable from server and client
// components). Mobile-only (below md): desktop is untouched.

/** KPI tile grids: tighter tiles on phones so the page's content starts sooner. */
export const GL_TILES_MOBILE =
  'max-md:gap-2.5 max-md:[&_[data-slot=card]]:py-0 max-md:[&_[data-slot=card-content]]:px-3.5 max-md:[&_[data-slot=card-content]]:py-3';

/** A filter/segmented row that scrolls sideways on phones instead of wrapping labels. */
export const GL_SCROLL_ROW_MOBILE =
  'md:contents max-md:-mx-4 max-md:w-[calc(100%+2rem)] max-md:flex max-md:overflow-x-auto max-md:px-4 max-md:pb-1 max-md:[scrollbar-width:none] max-md:[&::-webkit-scrollbar]:hidden max-md:[&_button]:whitespace-nowrap max-md:[&_[role=group]]:shrink-0';

/**
 * Page frame for the Goldline work pages: the full width of the content area (Oct 27:
 * no narrow centred column), capped only on very wide screens so lines stay readable.
 */
export const GL_PAGE = 'mx-auto flex w-full max-w-[112rem] flex-col gap-6 px-4 py-6 lg:px-8';

// Watsons sends branch names in capitals ("SM MALL OF ASIA 7"); a long column of
// capitals is hard on the eyes, so names show in title case. Two-letter words (SM, DS)
// stay capitals; the original is kept as the row's tooltip.
const SMALL = new Set(['of', 'and', 'the', 'at', 'in', 'de', 'del']);
export const titleName = (name: string) => {
  if (/[a-z]/.test(name)) return name;
  let first = true;
  return name.toLowerCase().replace(/[a-z0-9]+/g, (w) => {
    const out = first || !SMALL.has(w) ? (w.length <= 2 && !SMALL.has(w) && /^[a-z]+$/.test(w) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)) : w;
    first = false;
    return out;
  });
};
