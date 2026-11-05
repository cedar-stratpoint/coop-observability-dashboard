'use client';

import {useEffect, useRef, useState} from 'react';
import * as pdfjs from 'pdfjs-dist';
import {Loader2, Minus, Plus} from 'lucide-react';

// pdfjs runs its parser in a worker; self-hosted from /public so there's no CDN/CSP hop.
if (typeof window !== 'undefined') {
  pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';
}

export type ScanHighlight = {top: number; height: number; label: string; approximate?: boolean};

/**
 * The scan's first page rendered to a canvas, with the row highlight drawn in the page's
 * own coordinate space — so it stays locked on the right band while you zoom and pan
 * (the old iframe overlay drifted because the browser PDF viewer zoomed independently).
 * Falls back to the browser PDF viewer if the page can't be rendered.
 */
export function ScanPageViewer({url, highlight, className}: {url: string; highlight?: ScanHighlight; className?: string}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const [size, setSize] = useState<{w: number; h: number} | null>(null); // CSS display size at zoom 1
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');

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
        const base = page.getViewport({scale: 1});
        const wrapW = Math.min(scrollRef.current?.clientWidth ?? 760, 1000);
        const fit = wrapW / base.width; // fit the page width to the panel
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const vp = page.getViewport({scale: fit * 2 * dpr}); // render at 2x for crispness up to ~2x zoom
        const canvas = canvasRef.current;
        if (!canvas) return;
        canvas.width = Math.ceil(vp.width);
        canvas.height = Math.ceil(vp.height);
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        await page.render({canvasContext: ctx, viewport: vp}).promise;
        if (cancelled) return;
        setSize({w: base.width * fit, h: base.height * fit});
        setState('ready');
      } catch {
        if (!cancelled) setState('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [url]);

  if (state === 'error') {
    return <iframe src={url} title="Scan" className={className ?? 'h-full w-full'} />;
  }

  return (
    <div className={`relative flex flex-col ${className ?? ''}`}>
      <div ref={scrollRef} className="relative flex-1 overflow-auto rounded-md bg-[color:var(--muted)]">
        {state === 'loading' && (
          <div className="absolute inset-0 grid place-items-center">
            <Loader2 className="size-6 animate-spin text-muted-foreground" aria-label="Loading scan" />
          </div>
        )}
        <div className="mx-auto" style={size ? {width: size.w * zoom, height: size.h * zoom} : undefined}>
          <div
            className="relative origin-top-left"
            style={size ? {width: size.w, height: size.h, transform: `scale(${zoom})`} : undefined}
          >
            <canvas ref={canvasRef} className="block" style={size ? {width: size.w, height: size.h} : undefined} />
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
        <button
          type="button"
          onClick={() => setZoom((z) => Math.max(1, Math.round((z - 0.25) * 100) / 100))}
          disabled={zoom <= 1}
          aria-label="Zoom out"
          className="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
        >
          <Minus className="size-4" />
        </button>
        <span className="w-10 text-center text-xs font-medium tabular-nums">{Math.round(zoom * 100)}%</span>
        <button
          type="button"
          onClick={() => setZoom((z) => Math.min(4, Math.round((z + 0.25) * 100) / 100))}
          disabled={zoom >= 4}
          aria-label="Zoom in"
          className="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
        >
          <Plus className="size-4" />
        </button>
      </div>
    </div>
  );
}
