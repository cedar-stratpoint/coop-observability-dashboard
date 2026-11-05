'use client';

import {useCallback, useEffect, useId, useLayoutEffect, useRef, useState} from 'react';
import {createPortal} from 'react-dom';
import {Info} from 'lucide-react';
import {cn} from '@/lib/utils';

const W = 280, GAP = 8, EDGE = 8;

/**
 * The accessible variant of the ⓘ (the older `info-tip.tsx` is hover/focus only and used widely; this one also opens on tap, closes on Escape / outside tap,
 * wires aria-describedby and has a 32px+ touch target). Used for the Business Health Report's explanatory copy (`src/plan-help.ts`).
 * The tip is portalled to <body> with fixed positioning, so no overflow container or sticky header clips it.
 */
export function HelpTip({text, label = 'More info', className}: {text: string; label?: string; className?: string}) {
  const id = useId();
  const btn = useRef<HTMLButtonElement>(null);
  const tip = useRef<HTMLDivElement>(null);
  const pinned = useRef(false);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{left: number; top: number} | null>(null);
  const close = useCallback(() => { pinned.current = false; setOpen(false); }, []);
  const place = useCallback(() => {
    if (!btn.current || !tip.current) return;
    const r = btn.current.getBoundingClientRect(), h = tip.current.offsetHeight, w = tip.current.offsetWidth;
    const left = Math.min(Math.max(EDGE, r.left + r.width / 2 - w / 2), window.innerWidth - w - EDGE);
    const below = r.bottom + GAP + h <= window.innerHeight - EDGE || r.top - GAP - h < EDGE;
    setPos({left, top: below ? r.bottom + GAP : r.top - GAP - h});
  }, []);
  useLayoutEffect(() => { if (open) place(); else setPos(null); }, [open, text, place]);

  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { close(); btn.current?.focus(); } };
    const down = (e: PointerEvent) => { const t = e.target as Node; if (!btn.current?.contains(t) && !tip.current?.contains(t)) close(); };
    document.addEventListener('keydown', key);
    document.addEventListener('pointerdown', down);
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => { document.removeEventListener('keydown', key); document.removeEventListener('pointerdown', down); window.removeEventListener('scroll', place, true); window.removeEventListener('resize', place); };
  }, [open, close, place]);

  return (
    <>
      <button ref={btn} type="button" aria-label={label} aria-expanded={open} aria-describedby={open ? id : undefined}
        onPointerEnter={(e) => { if (e.pointerType === 'mouse') setOpen(true); }}
        onPointerLeave={(e) => { if (e.pointerType === 'mouse' && !pinned.current) setOpen(false); }}
        onFocus={() => setOpen(true)} onBlur={close}
        onClick={() => { if (open && pinned.current) close(); else { pinned.current = true; setOpen(true); } }}
        className={cn('-m-1.5 inline-flex size-8 shrink-0 items-center justify-center rounded-full align-middle text-muted-foreground transition-colors hover:text-primary focus-visible:text-primary focus-visible:outline-2 focus-visible:outline-primary motion-reduce:transition-none max-md:size-9 [&_svg]:size-3.5', open && 'text-primary', className)}>
        <Info aria-hidden />
      </button>
      {open && createPortal(
        <div ref={tip} id={id} role="tooltip" style={{position: 'fixed', left: pos?.left ?? 0, top: pos?.top ?? 0, maxWidth: W, visibility: pos ? 'visible' : 'hidden'}}
          className="pointer-events-none z-[70] w-max rounded-md border border-border bg-popover px-3 py-2 text-left text-xs font-normal normal-case leading-snug tracking-normal text-popover-foreground shadow-md">
          {text}
        </div>, document.body)}
    </>
  );
}
