'use client';

import {useCallback, useLayoutEffect, useRef, useState, type RefObject} from 'react';
import {flushSync} from 'react-dom';

// Taking a row out of a list without the rest "teleporting" (Nov 27, from the Flags hub):
// the row fades, the rows below slide up into its place, and the caller offers Undo.
//
//  • useLeaving: which keys are fading (`leaving`) and which are hidden (`gone`) until the
//    server (or the parent's state) agrees. Block lists pair it with `leaveRow(out)`, which
//    folds the row's height to zero, so the rows below follow it up on their own.
//  • useSlideUp: for layouts that can't fold a row's height (table rows), measure the rows
//    just before the change and glide each one from where it was to where it lands. Only
//    runs when armed, so typing in a search box or editing a cell never animates.
//
//  • viewTransition / useHeldData: for grids, where a card can change column or section. The
//    browser snapshots the page, the update applies, and each named card (`vtName`) glides
//    from its old box to its new one; a card that is gone fades out. useHeldData keeps
//    showing the current data until a refresh lands, then swaps it inside a transition, so a
//    server-driven move animates too. Browsers without View Transitions just update.
//
// Reduced motion: nothing moves or fades; the row goes at once (Undo still offered).

export const LEAVE_MS = 200;
/** Strong ease-out: the row answers at once, then settles. */
export const LEAVE_EASE = 'cubic-bezier(0.23, 1, 0.32, 1)';
/** Tailwind classes for a block list item that folds away: wrap its content in one
 *  `min-h-0 overflow-hidden` child so the height can reach zero. */
export const leaveRow = (out: boolean) =>
  `grid grid-cols-[minmax(0,1fr)] transition-[grid-template-rows,opacity] duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none ${out ? 'grid-rows-[0fr] opacity-0' : 'grid-rows-[1fr]'}`;

export function reducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

export function useLeaving(ms = LEAVE_MS) {
  const [leaving, setLeaving] = useState<Set<string>>(new Set());
  const [gone, setGone] = useState<Set<string>>(new Set());
  /** Fade these out, then hide them. */
  const remove = useCallback(
    (keys: string[]) => {
      setLeaving((s) => new Set([...s, ...keys]));
      window.setTimeout(() => setGone((s) => new Set([...s, ...keys])), reducedMotion() ? 0 : ms);
    },
    [ms],
  );
  /** Bring them back (Undo, or the server said no). */
  const restore = useCallback((keys: string[]) => {
    setGone((s) => new Set([...s].filter((k) => !keys.includes(k))));
    setLeaving((s) => new Set([...s].filter((k) => !keys.includes(k))));
  }, []);
  /** Forget every local removal (fresh data from the server). */
  const reset = useCallback(() => {
    setGone(new Set());
    setLeaving(new Set());
  }, []);
  return {leaving, gone, remove, restore, reset};
}

/** Glide the `[data-flip-key]` elements inside `ref` from their old spot to their new one
 *  after the next render. Call the returned `arm()` right before the state change. Elements
 *  that are new after the change fade in instead. */
export function useSlideUp(ref: RefObject<HTMLElement | null>, ms = 220) {
  const before = useRef<Map<string, number> | null>(null);
  const arm = useCallback(() => {
    if (reducedMotion() || !ref.current) return;
    const m = new Map<string, number>();
    for (const el of ref.current.querySelectorAll<HTMLElement>('[data-flip-key]')) {
      if (el.offsetParent !== null) m.set(el.dataset.flipKey!, el.getBoundingClientRect().top);
    }
    before.current = m;
  }, [ref]);
  // No deps: checks after every render, but does work only once armed.
  useLayoutEffect(() => {
    const was = before.current;
    if (!was || !ref.current) return;
    before.current = null;
    for (const el of ref.current.querySelectorAll<HTMLElement>('[data-flip-key]')) {
      if (el.offsetParent === null) continue;
      const top = was.get(el.dataset.flipKey!);
      if (top == null) {
        el.animate([{opacity: 0}, {opacity: 1}], {duration: ms, easing: LEAVE_EASE});
        continue;
      }
      const dy = top - el.getBoundingClientRect().top;
      if (Math.abs(dy) < 1) continue;
      el.animate([{transform: `translateY(${dy}px)`}, {transform: 'none'}], {duration: ms, easing: LEAVE_EASE});
    }
  });
  return arm;
}

type VTDocument = Document & {startViewTransition?: (update: () => void) => unknown};

/** Run a state update inside a View Transition (instant where unsupported or reduced motion). */
export function viewTransition(update: () => void) {
  const d = typeof document === 'undefined' ? null : (document as VTDocument);
  if (!d?.startViewTransition || reducedMotion()) return update();
  d.startViewTransition(() => flushSync(update));
}

/** A `view-transition-name` for a card: a CSS-safe name from any key (codes, file names). */
export function vtName(prefix: string, key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (Math.imul(31, h) + key.charCodeAt(i)) | 0;
  return `${prefix}-${(h >>> 0).toString(36)}`;
}

/** Show `data` as it was until fresh data arrives; when armed, swap it in a View Transition.
 *  Unarmed refreshes (polling, other edits) swap at once, before paint. */
export function useHeldData<T>(data: T): {shown: T; arm: () => void} {
  const [shown, setShown] = useState(data);
  // armed: the next fresh data should animate. holding: a swap is under way, so keep showing
  // the old data until the transition's update runs (its snapshot must see the old layout).
  const armed = useRef(false);
  const holding = useRef(false);
  useLayoutEffect(() => {
    if (data === shown || holding.current) return;
    if (!armed.current) return setShown(data);
    armed.current = false;
    holding.current = true;
    viewTransition(() => {
      holding.current = false;
      setShown(data);
    });
  }, [data, shown]);
  const arm = useCallback(() => {
    armed.current = true;
  }, []);
  return {shown: data === shown || armed.current || holding.current ? shown : data, arm};
}
