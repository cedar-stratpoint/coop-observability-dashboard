'use client';

import {useCallback, useEffect, useLayoutEffect, useRef, useState} from 'react';
import * as pdfjs from 'pdfjs-dist';
import {Loader2, Maximize2, Minus, Plus, RotateCw} from 'lucide-react';

// pdfjs runs its parser in a worker; self-hosted from /public so there's no CDN/CSP hop.
if (typeof window !== 'undefined') {
  pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';
}

export type ScanHighlight = {top: number; height: number; label: string; approximate?: boolean};
/** A light box on the row the reviewer is pointing at in the rows beside the scan (page fractions).
 *  `angle`/`px` tilt it with a slanted page around the ITEM# column; `label` is a small tag on it. */
export type ScanPointBox = {top: number; height: number; angle?: number; px?: number; label?: string};

const ZMIN = 1;
const ZMAX = 4;
const clampZoom = (z: number) => Math.min(ZMAX, Math.max(ZMIN, z));

/**
 * The scan's first page rendered to a canvas, with the row highlight drawn in the page's
 * own coordinate space — so it stays locked on the right band while you zoom and pan
 * (the old iframe overlay drifted because the browser PDF viewer zoomed independently).
 * Falls back to the browser PDF viewer if the page can't be rendered.
 *
 * `rotation` turns the page (180 for a scan the reader found upside down); the highlight is in
 * upright-page coordinates, so it needs no flipping. `onRotate` adds a Rotate 180° button.
 *
 * Zoom: the buttons, a trackpad pinch (Chrome/Edge/Firefox send it as ctrl+wheel, Safari as
 * gesture events) or a two-finger pinch on touch screens, always around the point under the
 * pointer. A mouse drags to pan; a plain click (not a drag) calls `onEnlarge`. `fit="page"`
 * fits the whole page in the box (the enlarged view); the default fits its width (side pane).
 */
export function ScanPageViewer({
  url,
  highlight,
  className,
  rotation = 0,
  onRotate,
  onEnlarge,
  fit = 'width',
  pointBox,
}: {
  url: string;
  highlight?: ScanHighlight;
  className?: string;
  rotation?: 0 | 180;
  onRotate?: () => void;
  onEnlarge?: () => void;
  fit?: 'width' | 'page';
  pointBox?: ScanPointBox | null;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const [base, setBase] = useState<{w: number; h: number} | null>(null); // page size in PDF units
  const [box, setBox] = useState<{w: number; h: number}>({w: 0, h: 0}); // the scroll box's size
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');

  // Track the box size so the page re-fits when the pane or window is resized.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBox({w: el.clientWidth, h: el.clientHeight}));
    ro.observe(el);
    setBox({w: el.clientWidth, h: el.clientHeight});
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    setState('loading');
    setZoom(1);
    // If pdfjs can't load/render in a reasonable time (an environment that blocks the
    // worker, say), fall back to the browser PDF viewer instead of spinning forever.
    const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('pdf render timed out')), 10000));
    (async () => {
      try {
        const doc = await Promise.race([pdfjs.getDocument({url}).promise, timeout]);
        const page = await doc.getPage(1);
        if (cancelled) return;
        const turn = ((page.rotate ?? 0) + rotation) % 360;
        const vp1 = page.getViewport({scale: 1, rotation: turn});
        // Render once, sharp enough for ~2x zoom of a page up to ~1000 px wide on screen.
        const wrapW = Math.min(Math.max(scrollRef.current?.clientWidth ?? 760, 600), 1000);
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const vp = page.getViewport({scale: (wrapW / vp1.width) * 2 * dpr, rotation: turn});
        const canvas = canvasRef.current;
        if (!canvas) return;
        canvas.width = Math.ceil(vp.width);
        canvas.height = Math.ceil(vp.height);
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        await page.render({canvasContext: ctx, viewport: vp}).promise;
        if (cancelled) return;
        setBase({w: vp1.width, h: vp1.height});
        setState('ready');
      } catch {
        if (!cancelled) setState('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [url, rotation]);

  // Display size at zoom 1: fit the width, or the whole page.
  const size = (() => {
    if (!base || !box.w) return null;
    const s = fit === 'page' && box.h ? Math.min(box.w / base.w, box.h / base.h) : box.w / base.w;
    return {w: base.w * s, h: base.h * s};
  })();

  // Zoom around a screen point: remember where it sits on the page, then scroll it back under the pointer.
  const anchor = useRef<{fx: number; fy: number; cx: number; cy: number} | null>(null);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const zoomAt = useCallback((next: number, clientX?: number, clientY?: number) => {
    const page = pageRef.current;
    const scroller = scrollRef.current;
    const z = clampZoom(next);
    if (!page || !scroller || Math.abs(z - zoomRef.current) < 0.001) return;
    const r = page.getBoundingClientRect();
    const s = scroller.getBoundingClientRect();
    const cx = clientX ?? s.left + s.width / 2;
    const cy = clientY ?? s.top + s.height / 2;
    anchor.current = {fx: (cx - r.left) / r.width, fy: (cy - r.top) / r.height, cx, cy};
    setZoom(z);
  }, []);
  useLayoutEffect(() => {
    const a = anchor.current;
    const page = pageRef.current;
    const scroller = scrollRef.current;
    if (!a || !page || !scroller) return;
    anchor.current = null;
    const r = page.getBoundingClientRect();
    scroller.scrollLeft += r.left + a.fx * r.width - a.cx;
    scroller.scrollTop += r.top + a.fy * r.height - a.cy;
  }, [zoom]);

  // Trackpad pinch and ctrl+wheel (needs a non-passive listener), Safari gesture events, touch pinch.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return; // a plain two-finger scroll still scrolls
      e.preventDefault();
      zoomAt(zoomRef.current * Math.exp(-e.deltaY * 0.01), e.clientX, e.clientY);
    };
    let gestureStart = 1;
    type GestureLike = Event & {scale: number; clientX: number; clientY: number};
    const onGestureStart = (e: Event) => {
      e.preventDefault();
      gestureStart = zoomRef.current;
    };
    const onGestureChange = (e: Event) => {
      e.preventDefault();
      const g = e as GestureLike;
      zoomAt(gestureStart * g.scale, g.clientX, g.clientY);
    };
    const prevent = (e: Event) => e.preventDefault();
    el.addEventListener('wheel', onWheel, {passive: false});
    el.addEventListener('gesturestart', onGestureStart);
    el.addEventListener('gesturechange', onGestureChange);
    el.addEventListener('gestureend', prevent);
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('gesturestart', onGestureStart);
      el.removeEventListener('gesturechange', onGestureChange);
      el.removeEventListener('gestureend', prevent);
    };
  }, [zoomAt]);

  // Mouse drag to pan; two touch points pinch; a click that didn't move enlarges.
  const pointers = useRef(new Map<number, {x: number; y: number}>());
  const drag = useRef<{x: number; y: number; l: number; t: number; moved: boolean} | null>(null);
  const pinch = useRef<{d: number; z: number} | null>(null);
  const [dragging, setDragging] = useState(false);
  const dist = () => {
    const [a, b] = [...pointers.current.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  };
  const onPointerDown = (e: React.PointerEvent) => {
    pointers.current.set(e.pointerId, {x: e.clientX, y: e.clientY});
    if (e.pointerType === 'touch' && pointers.current.size === 2) {
      pinch.current = {d: dist(), z: zoomRef.current};
      drag.current = null;
      return;
    }
    if (e.pointerType === 'mouse' && e.button === 0 && scrollRef.current) {
      drag.current = {x: e.clientX, y: e.clientY, l: scrollRef.current.scrollLeft, t: scrollRef.current.scrollTop, moved: false};
    } else if (e.pointerType !== 'mouse') {
      drag.current = {x: e.clientX, y: e.clientY, l: 0, t: 0, moved: false}; // a tap, unless it moves
    }
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, {x: e.clientX, y: e.clientY});
    if (pinch.current && pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      if (pinch.current.d > 0) zoomAt(pinch.current.z * (dist() / pinch.current.d), (a.x + b.x) / 2, (a.y + b.y) / 2);
      return;
    }
    const d = drag.current;
    if (!d) return;
    if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) {
      d.moved = true;
      if (e.pointerType === 'mouse') {
        setDragging(true);
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      }
    }
    if (d.moved && e.pointerType === 'mouse' && scrollRef.current) {
      scrollRef.current.scrollLeft = d.l - (e.clientX - d.x);
      scrollRef.current.scrollTop = d.t - (e.clientY - d.y);
    }
  };
  const endPointer = (e: React.PointerEvent, cancelled = false) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    const d = drag.current;
    drag.current = null;
    setDragging(false);
    if (!cancelled && d && !d.moved && onEnlarge && (e.target as HTMLElement).closest('[data-scan-page]')) onEnlarge();
  };

  // Keep the pointed-at row in view: scroll only when its box is outside the visible part.
  useEffect(() => {
    const scroller = scrollRef.current;
    const page = pageRef.current;
    if (!pointBox || !size || !scroller || !page || drag.current) return;
    const top = page.offsetTop + pointBox.top * size.h * zoom;
    const bottom = top + pointBox.height * size.h * zoom;
    const margin = 40;
    if (top >= scroller.scrollTop + margin && bottom <= scroller.scrollTop + scroller.clientHeight - margin) return;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    scroller.scrollTo({top: Math.max(0, top - scroller.clientHeight / 2 + (bottom - top) / 2), behavior: reduce ? 'auto' : 'smooth'});
  }, [pointBox?.top, pointBox?.height, size?.h]); // eslint-disable-line react-hooks/exhaustive-deps

  // Bring the "Show in scan" band into view.
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!highlight || !size || !scroller) return;
    const y = highlight.top * size.h * zoom;
    scroller.scrollTo({top: Math.max(0, y - scroller.clientHeight / 3), behavior: 'smooth'});
  }, [highlight, size?.h]); // eslint-disable-line react-hooks/exhaustive-deps

  if (state === 'error') {
    return <iframe src={url} title="Scan" className={className ?? 'h-full w-full'} />;
  }

  return (
    <div className={`relative flex flex-col ${className ?? ''}`}>
      <div
        ref={scrollRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(e) => endPointer(e)}
        onPointerCancel={(e) => endPointer(e, true)}
        style={{touchAction: 'pan-x pan-y'}}
        className={`relative flex flex-1 overflow-auto overscroll-contain rounded-md bg-[color:var(--muted)] select-none ${dragging ? 'cursor-grabbing' : onEnlarge ? 'cursor-zoom-in' : 'cursor-grab'}`}
      >
        {state === 'loading' && (
          <div className="absolute inset-0 grid place-items-center">
            <Loader2 className="size-6 animate-spin text-muted-foreground" aria-label="Loading scan" />
          </div>
        )}
        <div
          ref={pageRef}
          data-scan-page
          className={fit === 'page' ? 'm-auto shrink-0' : 'mx-auto shrink-0'}
          style={size ? {width: size.w * zoom, height: size.h * zoom} : undefined}
        >
          <div className="relative origin-top-left" style={size ? {width: size.w, height: size.h, transform: `scale(${zoom})`} : undefined}>
            <canvas ref={canvasRef} className="block" style={size ? {width: size.w, height: size.h} : {width: '100%'}} />
            {pointBox && size && (
              <div
                aria-hidden
                className="pointer-events-none absolute right-0 left-0 rounded-[3px] transition-[top,height,transform] duration-150 ease-out motion-reduce:transition-none"
                style={{
                  top: `${Math.max(0, pointBox.top - 0.002) * 100}%`,
                  height: `${(pointBox.height + 0.004) * 100}%`,
                  background: 'color-mix(in oklab, var(--primary) 14%, transparent)',
                  boxShadow: 'inset 0 0 0 1.5px color-mix(in oklab, var(--primary) 70%, transparent)',
                  ...(pointBox.angle && Math.abs(pointBox.angle) > 0.05
                    ? {transformOrigin: `${((pointBox.px ?? 0.1) * 100).toFixed(2)}% 50%`, transform: `rotate(${pointBox.angle}deg)`}
                    : {}),
                }}
              >
                {/* No tag on the scan: it covered handwriting or got truncated on tight margins. The
                    highlighted row in the list names the item. */}
              </div>
            )}
            {highlight && size && (
              <div
                className="pointer-events-none absolute right-0 left-0 motion-safe:animate-[pulse_1.6s_ease-in-out_2]"
                style={{
                  top: `${Math.max(0, highlight.top) * 100}%`,
                  height: `${highlight.height * 100}%`,
                  background: 'color-mix(in oklab, var(--primary) 16%, transparent)',
                  boxShadow: '0 0 0 2px var(--primary), 0 0 0 9999px rgba(0,0,0,0.35)',
                }}
              >
                <span className="absolute left-1 -top-1 -translate-y-full rounded bg-[color:var(--primary)] px-1.5 py-0.5 text-[10px] font-semibold whitespace-nowrap text-white">
                  {highlight.label}
                  {highlight.approximate ? ' · approximate' : ''}
                </span>
              </div>
            )}
          </div>
        </div>
      </div>
      <div className="absolute right-3 bottom-3 flex items-center gap-0.5 rounded-lg border border-border bg-background/95 p-1 shadow-md backdrop-blur">
        {onEnlarge && (
          <button
            type="button"
            onClick={onEnlarge}
            aria-label="Enlarge scan"
            title="Enlarge"
            className="grid size-7 place-items-center rounded-md text-muted-foreground transition-[color,background-color,transform] duration-150 ease-out hover:bg-muted hover:text-foreground active:scale-[0.97]"
          >
            <Maximize2 className="size-4" />
          </button>
        )}
        {onRotate && (
          <button
            type="button"
            onClick={onRotate}
            aria-label="Rotate 180°"
            title="Rotate 180°"
            className="grid size-7 place-items-center rounded-md text-muted-foreground transition-[color,background-color,transform] duration-150 ease-out hover:bg-muted hover:text-foreground active:scale-[0.97]"
          >
            <RotateCw className="size-4" />
          </button>
        )}
        {(onEnlarge || onRotate) && <span aria-hidden className="mx-0.5 h-4 w-px bg-border" />}
        <button
          type="button"
          onClick={() => zoomAt(Math.round((zoom - 0.25) * 100) / 100)}
          disabled={zoom <= ZMIN}
          aria-label="Zoom out"
          className="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
        >
          <Minus className="size-4" />
        </button>
        <button
          type="button"
          onClick={() => zoomAt(1)}
          title="Back to fit"
          className="w-11 rounded-md py-1 text-center text-xs font-medium tabular-nums transition-colors hover:bg-muted"
        >
          {Math.round(zoom * 100)}%
        </button>
        <button
          type="button"
          onClick={() => zoomAt(Math.round((zoom + 0.25) * 100) / 100)}
          disabled={zoom >= ZMAX}
          aria-label="Zoom in"
          className="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
        >
          <Plus className="size-4" />
        </button>
      </div>
    </div>
  );
}
