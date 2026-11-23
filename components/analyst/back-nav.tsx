'use client';

// "Back goes back": the client half (pure helpers + rationale in src/back-nav.ts).
//
//   useListParams    a list's filters live in the URL, written with replaceState, so a
//                    filter click never becomes a Back step and a reload keeps them.
//   useReturnTrip    a list remembers where you were when you open a row, and when you come
//                    back (our Back link or the browser's) restores scroll and marks the row.
//   ReturnLink       the detail page's "‹ List" link: goes to the remembered list URL when
//                    you came from it, else the fixed parent, as before.

import {useCallback, useEffect, useRef, useState, type ReactNode} from 'react';
import Link from 'next/link';
import {useRouter, useSearchParams} from 'next/navigation';
import {isLocalPath, mergeListParams, parseReturnEntry, readListParams, returnHref, returnKey, type ListDefaults, type ReturnEntry} from '@/src/back-nav';

const ARRIVE_KEY = 'coop:return:arrive';

// The browser's own Back/Forward fires popstate just before Next swaps the route in, so a
// list that mounts right after one was reached through history. Recorded once per page load.
let poppedAt = 0;
if (typeof window !== 'undefined') {
  window.addEventListener('popstate', () => {
    poppedAt = Date.now();
  });
}

function store(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null; // blocked storage: everything degrades to the old fixed Back link
  }
}

function readEntry(listKey: string): ReturnEntry | null {
  try {
    return parseReturnEntry(store()?.getItem(returnKey(listKey)) ?? null, Date.now());
  } catch {
    return null;
  }
}

const normPath = (p: string) => {
  try {
    return decodeURIComponent(p.split(/[?#]/)[0]);
  } catch {
    return p.split(/[?#]/)[0];
  }
};

/**
 * A list's filter/sort/page state, kept in the URL. `defaults` must be a stable (module-level)
 * object; every value is a string, and values at their default stay out of the URL. Updates
 * use history.replaceState: no server round trip, no history entry.
 */
export function useListParams<D extends ListDefaults>(defaults: D): [D, (patch: Partial<D>) => void] {
  const spStr = useSearchParams().toString();
  const [state, setState] = useState<D>(() => readListParams(spStr, defaults));
  // The query string we last wrote. A URL change we didn't make (a link, the store picker, the
  // browser) is adopted as the new state instead of being overwritten.
  const written = useRef(spStr);
  const [seen, setSeen] = useState(spStr);
  if (spStr !== seen) {
    setSeen(spStr);
    if (spStr !== written.current) {
      written.current = spStr;
      setState(readListParams(spStr, defaults));
    }
  }

  useEffect(() => {
    const qs = mergeListParams(window.location.search.slice(1), defaults, state);
    if (qs === window.location.search.slice(1)) return;
    written.current = qs;
    window.history.replaceState(null, '', `${window.location.pathname}${qs ? `?${qs}` : ''}`);
  }, [defaults, state]);

  const set = useCallback((patch: Partial<D>) => setState((s) => ({...s, ...patch})), []);
  return [state, set];
}

/** Briefly mark the row you came back to: an accent rail + tint that fades (CSS in globals). */
function markKept(el: HTMLElement) {
  el.dataset.kept = 'on';
  window.setTimeout(() => {
    el.dataset.kept = 'fading';
    window.setTimeout(() => {
      if (el.dataset.kept === 'fading') delete el.dataset.kept;
    }, 900);
  }, 1400);
}

const visible = (el: Element) => el.getClientRects().length > 0;

/**
 * The list side of the return trip. Call `leave(rowId, href)` when a row opens (onClick on the
 * row's link). Rows carry `data-kept-id={rowId}`; the element inside matching `[data-row]` (or
 * the first link) gets focus on return.
 */
export function useReturnTrip(listKey: string) {
  useEffect(() => {
    const s = store();
    const viaLink = s?.getItem(ARRIVE_KEY) === listKey;
    if (viaLink) s?.removeItem(ARRIVE_KEY);
    const viaHistory = Date.now() - poppedAt < 3000;
    if (!viaLink && !viaHistory) return;
    poppedAt = 0;

    const entry = readEntry(listKey);
    const here = `${window.location.pathname}${window.location.search}`;
    // Our Back link skips Next's scroll-to-top, so a list we can't restore starts at the top.
    if (!entry || entry.url !== here) {
      if (viaLink) window.scrollTo({top: 0, behavior: 'instant'});
      return;
    }
    // Not cancelled on cleanup: the arrival flag is one-shot, so a dev Strict Mode re-run (or a
    // fast re-render) must not throw the restore away.
    requestAnimationFrame(() => {
      window.scrollTo({top: entry.scrollY, behavior: 'instant'});
      if (!entry.rowId) return;
      const row = [...document.querySelectorAll<HTMLElement>(`[data-kept-id="${CSS.escape(entry.rowId)}"]`)].find(visible);
      if (!row) return;
      const r = row.getBoundingClientRect();
      if (r.top < 64 || r.bottom > window.innerHeight) row.scrollIntoView({block: 'center', behavior: 'instant'});
      markKept(row);
      const target = row.querySelector<HTMLElement>('[data-row]') ?? row.querySelector<HTMLElement>('a[href],button');
      target?.focus({preventScroll: true});
    });
  }, [listKey]);

  const leave = useCallback(
    (rowId: string | null, href: string) => {
      const entry: ReturnEntry = {
        url: `${window.location.pathname}${window.location.search}`,
        scrollY: window.scrollY,
        rowId,
        at: Date.now(),
        to: normPath(href),
      };
      try {
        store()?.setItem(returnKey(listKey), JSON.stringify(entry));
      } catch {
        /* full or blocked: Back falls back to the fixed parent */
      }
    },
    [listKey],
  );
  return {leave};
}

/** The previous history entry's same-origin path + query, via the Navigation API (Chromium,
 *  Safari 26.2+, Firefox 147+). Null when unknown: callers then just navigate forward. */
function previousEntryUrl(): string | null {
  const nav = (window as unknown as {navigation?: {currentEntry?: {index: number} | null; entries?: () => Array<{url: string | null}>}}).navigation;
  const i = nav?.currentEntry?.index;
  if (!nav?.entries || i == null || i < 1) return null;
  const url = nav.entries()[i - 1]?.url;
  if (!url) return null;
  const u = new URL(url);
  return u.origin === window.location.origin ? u.pathname + u.search : null;
}

/** Whether this detail page was opened from the list's remembered row (not a deep link). */
function cameFrom(entry: ReturnEntry | null, detailPrefix?: string): boolean {
  if (!entry?.to) return false;
  const here = normPath(window.location.pathname);
  return detailPrefix ? here.startsWith(detailPrefix) && entry.to.startsWith(detailPrefix) : here === entry.to;
}

/**
 * The detail page's "‹ List" link. When you opened this page from the list, it returns to that
 * list exactly as you left it; from a deep link it is the fixed `fallback`, as before.
 * `detailPrefix` widens "this page" to a family of pages (e.g. a review stepper that moves
 * between `/uploads/<id>` pages with replace).
 */
export function ReturnLink({
  listKey,
  fallback,
  detailPrefix,
  className,
  children,
  'aria-label': ariaLabel,
}: {
  listKey: string;
  fallback: string;
  detailPrefix?: string;
  className?: string;
  children: ReactNode;
  'aria-label'?: string;
}) {
  const router = useRouter();
  const [href, setHref] = useState(fallback);
  useEffect(() => {
    const entry = readEntry(listKey);
    const came = cameFrom(entry, detailPrefix);
    const next = came ? returnHref(entry, fallback) : fallback;
    setHref(isLocalPath(next) ? next : fallback);
  }, [listKey, fallback, detailPrefix]);
  return (
    <Link
      href={href}
      scroll={false}
      className={className}
      aria-label={ariaLabel}
      onClick={(e) => {
        try {
          store()?.setItem(ARRIVE_KEY, listKey);
        } catch {
          /* ignore */
        }
        // The list is exactly the previous history entry: step back to it, so the browser's own
        // Back afterwards leaves the list instead of returning here (one press, one step).
        if (!e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey && e.button === 0 && previousEntryUrl() === new URL(e.currentTarget.href).pathname + new URL(e.currentTarget.href).search) {
          e.preventDefault();
          router.back();
        }
      }}
    >
      {children}
    </Link>
  );
}
