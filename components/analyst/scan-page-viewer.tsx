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
export type ScanPointBox = {top: number; height: number; angle?: number; px?: number; label?: string; estimated?: boolean};

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
  tilt = 0,
}: {
  url: string;
  highlight?: ScanHighlight;
  className?: string;
  rotation?: 0 | 180;
  onRotate?: () => void;
  onEnlarge?: () => void;
  fit?: 'width' | 'page';
  pointBox?: ScanPointBox | null;
  /** The page's slant in degrees: the line that follows the mouse leans with the printed rows. */
  tilt?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const [base, setBase] = useState<{w: number; h: number} | null>(null); // page size in PDF units
  const [box, setBox] = useState<{w: number; h: number}>({w: 0, h: 0}); // the scroll box's size
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  // Download progress (0..100) while loading, null when the size isn't known yet.
  const [pct, setPct] = useState<number | null>(null);
  // Bumped by "Try again" on the fallback, to re-run the load.
  const [attempt, setAttempt] = useState(0);

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
    setPct(null);
    setZoom(1);
    // Fall back to the browser PDF viewer only when the load STALLS (no bytes for STALL_MS:
    // a blocked worker, a dead connection), never just because it is slow. A scan page is
    // ~2.7 MB, so a fixed 10 s limit gave up on ordinary connections and showed the page
    // un-rotated in the browser viewer. Progress resets the clock.
    const STALL_MS = 20000;
    let stall: ReturnType<typeof setTimeout> | undefined;
    let rejectStall: (e: Error) => void = () => {};
    const stalled = new Promise<never>((_, reject) => {
      rejectStall = reject;
    });
    stalled.catch(() => {});
    const arm = () => {
      clearTimeout(stall);
      stall = setTimeout(() => rejectStall(new Error('pdf load stalled')), STALL_MS);
    };
    arm();
    const task = pdfjs.getDocument({url});
    task.onProgress = ({loaded, total}: {loaded: number; total: number}) => {
      arm();
      if (!cancelled && total > 0) setPct(Math.min(99, Math.round((loaded / total) * 100)));
    };
    let render: {cancel: () => void} | null = null;
    (async () => {
      try {
        const doc = await Promise.race([task.promise, stalled]);
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
        const r = page.render({canvasContext: ctx, viewport: vp});
        render = r;
        arm();
        await Promise.race([r.promise, stalled]);
        if (cancelled) return;
        setBase({w: vp1.width, h: vp1.height});
        setState('ready');
      } catch {
        // A cancelled load (the reviewer stepped to another page) is not a failure.
        if (!cancelled) setState('error');
      } finally {
        clearTimeout(stall);
      }
    })();
    return () => {
      cancelled = true;
      clearTimeout(stall);
      // Stop the half-drawn page so the next one never shares the canvas with it.
      render?.cancel();
      void task.destroy();
    };
  }, [url, rotation, attempt]);

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
  // A thin line under the mouse, along the printed rows, to see which row a number sits on (the
  // answer key's ruler). Moved directly, so following the mouse never re-renders the page.
  const rulerRef = useRef<HTMLDivElement>(null);
  const rulerAt = useRef<{x: number; y: number} | null>(null);
  const moveRuler = (at: {x: number; y: number} | null) => {
    rulerAt.current = at;
    const line = rulerRef.current;
    const r = pageRef.current?.getBoundingClientRect();
    if (!line) return;
    const on = Boolean(at && r && state === 'ready' && at.x >= r.left && at.x <= r.right && at.y >= r.top && at.y <= r.bottom);
    line.style.opacity = on ? '1' : '0';
    if (!on || !at || !r) return;
    line.style.top = `${at.y - r.top}px`;
    line.style.transformOrigin = `${at.x - r.left}px 0`;
    line.style.transform = `rotate(${tilt}deg)`;
  };
  const onPointerMove = (e: React.PointerEvent) => {
    moveRuler(e.pointerType === 'mouse' && !drag.current?.moved ? {x: e.clientX, y: e.clientY} : null);
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
    // The browser's own PDF viewer: always shows the file, but can't turn it upright or draw
    // the row box, so offer another go at the full viewer.
    return (
      <div className={`flex flex-col gap-2 ${className ?? ''}`}>
        <div className="flex items-center justify-between gap-2 rounded-md bg-muted/60 px-3 py-1.5 text-xs text-muted-foreground">
          <span>Showing the plain file: it may be upside down.</span>
          <button
            type="button"
            onClick={() => setAttempt((a) => a + 1)}
            className="shrink-0 rounded-md px-1.5 py-0.5 font-medium text-foreground transition-colors hover:bg-muted"
          >
            Try again
          </button>
        </div>
        <iframe src={url} title="Scan" className="min-h-[60vh] w-full flex-1" />
      </div>
    );
  }

  return (
    <div className={`relative flex flex-col ${className ?? ''}`}>
      <div
        ref={scrollRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(e) => endPointer(e)}
        onPointerCancel={(e) => endPointer(e, true)}
        onPointerLeave={() => moveRuler(null)}
        onScroll={() => moveRuler(rulerAt.current)}
        style={{touchAction: 'pan-x pan-y'}}
        className={`relative flex flex-1 overflow-auto overscroll-contain rounded-md bg-[color:var(--muted)] select-none ${dragging ? 'cursor-grabbing' : onEnlarge ? 'cursor-zoom-in' : 'cursor-grab'}`}
      >
        {state === 'loading' && (
          <div className="absolute inset-0 grid place-items-center">
            <div className="flex flex-col items-center gap-2 text-xs text-muted-foreground tabular-nums">
              <Loader2 className="size-6 animate-spin" aria-label="Loading scan" />
              {pct != null && <span>Loading the scan · {pct}%</span>}
            </div>
          </div>
        )}
        <div
          ref={pageRef}
          data-scan-page
          className={`relative overflow-clip ${fit === 'page' ? 'm-auto shrink-0' : 'mx-auto shrink-0'}`}
          style={size ? {width: size.w * zoom, height: size.h * zoom} : undefined}
        >
          <div ref={rulerRef} data-scan-ruler aria-hidden className="pointer-events-none absolute -right-8 -left-8 z-10 h-[2px] bg-emerald-700 opacity-0" />
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
                  ...(pointBox.estimated
                    ? {outline: '1.5px dashed color-mix(in oklab, var(--primary) 80%, transparent)', outlineOffset: '-1.5px'}
                    : {boxShadow: 'inset 0 0 0 1.5px color-mix(in oklab, var(--primary) 70%, transparent)'}),
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
