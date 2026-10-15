// Shared Goldline layout classes (plain strings — usable from server and client
// components). Mobile-only (below md): desktop is untouched.

/** KPI tile grids: tighter tiles on phones so the page's content starts sooner. */
export const GL_TILES_MOBILE =
  'max-md:gap-2.5 max-md:[&_[data-slot=card]]:py-0 max-md:[&_[data-slot=card-content]]:px-3.5 max-md:[&_[data-slot=card-content]]:py-3';

/** A filter/segmented row that scrolls sideways on phones instead of wrapping labels. */
export const GL_SCROLL_ROW_MOBILE =
  'md:contents max-md:-mx-4 max-md:w-[calc(100%+2rem)] max-md:flex max-md:overflow-x-auto max-md:px-4 max-md:pb-1 max-md:[scrollbar-width:none] max-md:[&::-webkit-scrollbar]:hidden max-md:[&_button]:whitespace-nowrap max-md:[&_[role=group]]:shrink-0';
