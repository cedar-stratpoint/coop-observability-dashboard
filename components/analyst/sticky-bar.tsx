'use client';

// A condensed bar that pins under the app header once a page's full header and filters scroll
// away (Nov 25, owner QA: "the header follows, collapsed, so it doesn't take much of the screen").
// Used by the scan's Per file list and Reconcile. Zero height in the flow, so nothing shifts when
// it appears; inert and aria-hidden while hidden; a 150ms fade with a 4px rise, none under reduced
// motion. Place <StickyBar> first in the page column and the returned `sentinel` element right
// after the full filters: the bar shows once the sentinel passes under the header.

import {useEffect, useRef, useState, type ReactNode} from 'react';
import {ArrowUp} from 'lucide-react';
import {cn} from '@/lib/utils';

/** The app header is 3.5rem; a little under that line counts as "scrolled away". */
const HEADER_PX = 60;

export function useStuckSentinel() {
  const ref = useRef<HTMLDivElement>(null);
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(([e]) => setStuck(!e.isIntersecting && e.boundingClientRect.top < HEADER_PX + 4), {rootMargin: `-${HEADER_PX}px 0px 0px 0px`});
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return {ref, stuck};
}

export function scrollToTop() {
  const reduce = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  window.scrollTo({top: 0, behavior: reduce ? 'auto' : 'smooth'});
}

/**
 * `gapClass` cancels the page column's flex gap around the zero-height bar (e.g. "-mb-6" for gap-6),
 * so the page keeps its spacing at rest.
 */
export function StickyBar({stuck, gapClass, children}: {stuck: boolean; gapClass: string; children: ReactNode}) {
  const bar = useRef<HTMLDivElement>(null);
  // React 18 has no `inert` prop: set it on the element so a hidden bar is out of the tab order.
  useEffect(() => {
    if (bar.current) bar.current.inert = !stuck;
  }, [stuck]);
  return (
    <div className={cn('sticky top-[calc(3.5rem+0.4rem)] z-20 h-0', gapClass)}>
      <div
        ref={bar}
        aria-hidden={!stuck}
        className={cn(
          'absolute inset-x-0 top-0 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-border bg-card/95 px-3 py-2 shadow-sm backdrop-blur-sm',
          'transition-[opacity,transform] duration-150 ease-out motion-reduce:transition-none',
          stuck ? 'translate-y-0 opacity-100' : 'pointer-events-none -translate-y-1 opacity-0',
        )}
      >
        {children}
      </div>
    </div>
  );
}

export function TopButton() {
  return (
    <button
      type="button"
      onClick={scrollToTop}
      aria-label="Back to the top"
      className="inline-flex h-8 items-center gap-1 rounded-lg border border-border bg-background px-2.5 text-xs font-medium text-muted-foreground transition-[transform,border-color,color] duration-150 ease-out active:scale-[0.97] [@media(hover:hover)]:hover:border-foreground/25 [@media(hover:hover)]:hover:text-foreground"
    >
      <ArrowUp aria-hidden className="size-3.5" /> Top
    </button>
  );
}
