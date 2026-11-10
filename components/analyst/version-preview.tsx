'use client';

import {useEffect, useState} from 'react';
import {ChevronLeft, ChevronRight, Eye, X} from 'lucide-react';
import {formVersionPreview} from '@/src/goldline-form-versions';
import {cn} from '@/lib/utils';

// "See what a form version looks like": a small Preview affordance on each version summary card
// that opens a full-screen modal with that version's reference form, all its pages labeled, each
// clickable to enlarge. Images are the clean reference examples in public/form-versions/.

export function VersionPreviewButton({version, className}: {version: string; className?: string}) {
  const preview = formVersionPreview(version);
  const [open, setOpen] = useState(false);
  if (!preview) return null;
  return (
    <>
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen(true);
        }}
        aria-label={`Preview a ${preview.label} form`}
        title={`See what a ${preview.label} form looks like`}
        className={cn(
          'inline-flex size-7 items-center justify-center rounded-full border border-border bg-background/80 text-muted-foreground backdrop-blur-sm transition-colors hover:border-foreground/25 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          className,
        )}
      >
        <Eye className="size-3.5" aria-hidden />
      </button>
      {open && <VersionPreviewModal version={version} onClose={() => setOpen(false)} />}
    </>
  );
}

function VersionPreviewModal({version, onClose}: {version: string; onClose: () => void}) {
  const preview = formVersionPreview(version);
  const [zoom, setZoom] = useState<number | null>(null);
  const total = preview?.pages.length ?? 0;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (zoom != null) setZoom(null);
        else onClose();
      } else if (zoom != null && e.key === 'ArrowLeft') {
        setZoom((z) => (z == null ? z : (z + total - 1) % total));
      } else if (zoom != null && e.key === 'ArrowRight') {
        setZoom((z) => (z == null ? z : (z + 1) % total));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [zoom, total, onClose]);

  if (!preview) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-black/75 p-3 backdrop-blur-sm transition-opacity duration-150 ease-out starting:opacity-0 sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-label={`${preview.label} form preview`}
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-baseline gap-2">
          <h2 className="font-heading text-lg font-semibold text-white">{preview.label} form</h2>
          <span className="truncate text-sm text-white/60">
            {preview.subtitle} · {preview.pages.length} pages
          </span>
        </div>
        <button
          type="button"
          autoFocus
          onClick={onClose}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-white/10 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-white/20"
        >
          <X className="size-4" /> Close
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
          {preview.pages.map((p, i) => (
            <figure key={p.page} className="flex flex-col gap-2">
              <button
                type="button"
                onClick={() => setZoom(i)}
                aria-label={`Enlarge page ${p.page}`}
                className="group relative block overflow-hidden rounded-xl border border-white/15 bg-white focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-white/40"
              >
                <span
                  role="img"
                  aria-label={`${preview.label} form, page ${p.page} of ${preview.pages.length}`}
                  style={{backgroundImage: `url("${p.img}")`}}
                  className="block aspect-[3/4] w-full bg-white bg-cover bg-top transition-transform duration-200 group-hover:scale-[1.02]"
                />
                <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/55 to-transparent p-2 text-left text-[11px] font-medium text-white opacity-0 transition-opacity group-hover:opacity-100">
                  Click to enlarge
                </span>
              </button>
              <figcaption className="px-0.5">
                <span className="text-sm font-medium text-white">Page {p.page}</span>
                {p.sections && <span className="mt-0.5 block text-[11px] leading-snug text-white/55">{p.sections}</span>}
              </figcaption>
            </figure>
          ))}
        </div>
      </div>

      {/* Backdrop click closes (behind the content). */}
      <button type="button" aria-label="Close preview" onClick={onClose} className="absolute inset-0 -z-10 cursor-default" />

      {zoom != null && preview.pages[zoom] && (
        <div className="fixed inset-0 z-10 flex flex-col bg-black/90 p-3 sm:p-6" role="dialog" aria-modal="true" aria-label={`Page ${preview.pages[zoom].page}`}>
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="min-w-0 truncate text-sm font-medium text-white">
              Page {preview.pages[zoom].page} of {preview.pages.length}
              {preview.pages[zoom].sections ? ` · ${preview.pages[zoom].sections}` : ''}
            </span>
            <div className="flex shrink-0 items-center gap-2">
              <button type="button" onClick={() => setZoom((z) => (z == null ? z : (z + total - 1) % total))} aria-label="Previous page" className="rounded-lg bg-white/10 p-1.5 text-white transition-colors hover:bg-white/20">
                <ChevronLeft className="size-5" />
              </button>
              <button type="button" onClick={() => setZoom((z) => (z == null ? z : (z + 1) % total))} aria-label="Next page" className="rounded-lg bg-white/10 p-1.5 text-white transition-colors hover:bg-white/20">
                <ChevronRight className="size-5" />
              </button>
              <button type="button" autoFocus onClick={() => setZoom(null)} aria-label="Back to all pages" className="rounded-lg bg-white/10 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-white/20">
                <X className="size-4" />
              </button>
            </div>
          </div>
          <div
            role="img"
            aria-label={`${preview.label} form, page ${preview.pages[zoom].page}`}
            style={{backgroundImage: `url("${preview.pages[zoom].img}")`}}
            className="min-h-0 flex-1 rounded-lg bg-white bg-contain bg-center bg-no-repeat"
          />
        </div>
      )}
    </div>
  );
}
