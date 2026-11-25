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

/**
 * A card that is a link (Overview tiles and cards). Hover is seen many times a day, so it
 * stays small: the border warms to the accent, a soft shadow lifts the card 2px, and the
 * card's "open" cue (a `group-hover/card` child) slides in. Press scales to 0.99. Strong
 * ease-out under 200ms. Tailwind v4 only applies hover where the device can hover, and
 * reduced motion keeps the color change but drops the lift and the scale.
 */
export const GL_CARD_LINK =
  'group/card relative block outline-none transition-[border-color,background-color,box-shadow,translate,scale] duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] hover:-translate-y-0.5 hover:border-primary/40 hover:bg-[color-mix(in_oklab,var(--card),var(--primary)_4%)] hover:shadow-[0_10px_28px_-14px_color-mix(in_oklab,var(--foreground)_30%,transparent)] active:translate-y-0 active:scale-[0.99] active:duration-100 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background motion-reduce:hover:translate-y-0 motion-reduce:active:scale-100';

/** The "open" cue inside a GL_CARD_LINK: muted at rest (so touch users still see it), accent on hover. */
export const GL_CARD_CUE =
  'inline-flex items-center gap-0.5 text-xs font-medium text-muted-foreground transition-colors duration-200 group-hover/card:text-primary [&>svg]:transition-transform [&>svg]:duration-200 [&>svg]:ease-[cubic-bezier(0.23,1,0.32,1)] group-hover/card:[&>svg]:translate-x-0.5 motion-reduce:group-hover/card:[&>svg]:translate-x-0';
