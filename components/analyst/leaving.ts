'use client';

import {useCallback, useLayoutEffect, useRef, useState, type RefObject} from 'react';

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
