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

/** Remember this list (URL, scroll, the row being opened) before following a row's link. */
export function leaveList(listKey: string, rowId: string | null, href: string) {
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

/** A row id safe for `data-kept-id`, which is space-separated: encode keys that may hold
 *  spaces (filenames, BA names). Use the same encoded value for the attribute and `leave`. */
export const keptId = (key: string) => encodeURIComponent(key);

/**
 * The list side of the return trip. Call `leave(rowId, href)` when a row opens (onClick on the
 * row's link). Rows carry `data-kept-id` (one id, or several space-separated, e.g. a page and
 * its re-reads); the element inside matching `[data-row]` (or the first link) gets focus.
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
    returnToRow(entry.rowId, entry.scrollY);
  }, [listKey]);

  const leave = useCallback((rowId: string | null, href: string) => leaveList(listKey, rowId, href), [listKey]);
  return {leave};
}

/** The previous history entry's same-origin path + query, via the Navigation API (Chromium,
 *  Safari 26.2+, Firefox 147+). Null when unknown: callers then just navigate forward. */
export function previousEntryUrl(): string | null {
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
 * Bring a list back to where you left it: scroll, then mark + focus the row. A list can finish
 * laying out a beat after mount (e.g. a per-viewer page size read from storage re-slices it), so
 * the row is looked for over a few frames before giving up; the scroll is applied each try.
 */
function returnToRow(rowId: string | null, scrollY: number | null) {
  let tries = 0;
  const attempt = () => {
    if (scrollY != null) window.scrollTo({top: scrollY, behavior: 'instant'});
    if (!rowId) return;
    const row = [...document.querySelectorAll<HTMLElement>(`[data-kept-id~="${CSS.escape(rowId)}"]`)].find(visible);
    if (!row) {
      if (tries++ < 30) requestAnimationFrame(attempt);
      return;
    }
    const r = row.getBoundingClientRect();
    if (r.top < 64 || r.bottom > window.innerHeight) row.scrollIntoView({block: 'center', behavior: 'instant'});
    markKept(row);
    (row.querySelector<HTMLElement>('[data-row]') ?? row.querySelector<HTMLElement>('a[href],button'))?.focus({preventScroll: true});
  };
  requestAnimationFrame(attempt);
}

/**
 * An in-page drill-in (a list that swaps to one item's view without changing route) as a real
 * Back step: opening pushes `?<param>=<key>`, so the browser's Back closes it; `close()` steps
 * back when that entry is ours (else drops the param in place, e.g. after a deep link). When it
 * closes, the list's scroll comes back and the item is marked (`data-kept-id={keptId(key)}`).
 */
export function useDrillIn(param: string): [string | null, (key: string) => void, () => void] {
  const open = useSearchParams().get(param);
  const opened = useRef<{key: string; scrollY: number} | null>(null);
  const last = useRef(open);

  useEffect(() => {
    const was = last.current;
    last.current = open;
    if (!was || open) return;
    returnToRow(keptId(was), opened.current?.key === was ? opened.current.scrollY : null);
  }, [open]);

  const openIt = useCallback(
    (key: string) => {
      opened.current = {key, scrollY: window.scrollY};
      const q = new URLSearchParams(window.location.search);
      q.set(param, key);
      window.history.pushState(null, '', `${window.location.pathname}?${q}`);
    },
    [param],
  );
  const close = useCallback(() => {
    const q = new URLSearchParams(window.location.search);
    const key = q.get(param);
    q.delete(param);
    const target = `${window.location.pathname}${q.size ? `?${q}` : ''}`;
    if ((key && opened.current?.key === key) || previousEntryUrl() === target) window.history.back();
    else window.history.replaceState(null, '', target);
  }, [param]);
  return [open, openIt, close];
}

/**
 * For a detail page that moves between rows in place (a ‹ › stepper using replace): keep the
 * list's remembered row in step, so coming back marks the row you were last on, not the first.
 */
export function useTrackReturnRow(listKey: string, rowId: string, detailPrefix: string) {
  useEffect(() => {
    const entry = readEntry(listKey);
    if (!entry || !cameFrom(entry, detailPrefix) || entry.rowId === rowId) return;
    try {
      store()?.setItem(returnKey(listKey), JSON.stringify({...entry, rowId, to: normPath(window.location.pathname)}));
    } catch {
      /* ignore */
    }
  }, [listKey, rowId, detailPrefix]);
}

/** Mark that the next list mount is a return to `listKey` (for a custom Back control). */
export function markReturn(listKey: string) {
  try {
    store()?.setItem(ARRIVE_KEY, listKey);
  } catch {
    /* ignore */
  }
}

/** Where a detail page's Back should land: the remembered list URL when this page was opened
 *  from it, else `fallback`. Client-only (reads per-tab storage). */
export function returnTarget(listKey: string, fallback: string, detailPrefix?: string): string {
  const entry = readEntry(listKey);
  const next = cameFrom(entry, detailPrefix) ? returnHref(entry, fallback) : fallback;
  return isLocalPath(next) ? next : fallback;
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
  replace,
  title,
  'aria-label': ariaLabel,
}: {
  listKey: string;
  fallback: string;
  detailPrefix?: string;
  /** When not stepping back through history, replace this entry instead of pushing (a
   *  breadcrumb going up, so the detail page doesn't stay behind in history). */
  replace?: boolean;
  title?: string;
  className?: string;
  children: ReactNode;
  'aria-label'?: string;
}) {
  const router = useRouter();
  const [href, setHref] = useState(fallback);
  useEffect(() => {
    setHref(returnTarget(listKey, fallback, detailPrefix));
  }, [listKey, fallback, detailPrefix]);
  return (
    <Link
      href={href}
      scroll={false}
      replace={replace}
      title={title}
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

/**
 * One press, one step for sheets and dialogs: while `open`, the dialog owns one history entry
 * (same URL), so the browser's Back (or a mouse back button / trackpad swipe) closes the dialog
 * instead of leaving the page. Closing any other way (X, Escape, Cancel, save) steps back off
 * that entry. Only for dialogs that don't navigate as they close (a push racing the step back
 * could land on the wrong page).
 */
export function useBackToClose(open: boolean, onClose: () => void) {
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });
  useEffect(() => {
    if (!open) return;
    let pushed: string | null = null; // the URL our entry was pushed at
    let popped = false;
    // Deferred a tick: a dev Strict Mode mount/unmount/mount then pushes once, not push+back+push.
    const t = window.setTimeout(() => {
      pushed = window.location.href;
      window.history.pushState(null, '', pushed);
    }, 0);
    const onPop = () => {
      if (!pushed || popped) return;
      popped = true;
      onCloseRef.current();
    };
    window.addEventListener('popstate', onPop);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener('popstate', onPop);
      // Still on our entry (no navigation happened meanwhile): step back off it.
      if (pushed && !popped && window.location.href === pushed) window.history.back();
    };
  }, [open]);
}
