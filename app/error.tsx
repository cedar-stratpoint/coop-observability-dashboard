'use client';

// Segment-level error boundary. Catches render/data errors thrown by any page
// below the root layout, so a crashed section shows this calm Coop-branded panel
// (inside the dashboard shell, with the nav still usable) instead of bubbling up
// to the bare global-error screen. Next 16 passes `retry` (not `reset`).
import {useEffect} from 'react';
import Link from 'next/link';

export default function ErrorPage({error, retry}: {error: Error & {digest?: string}; retry: () => void}) {
  useEffect(() => {
    // Surface it in the console for anyone debugging; the digest ties a prod
    // error back to the server logs.
    console.error(error);
  }, [error]);

  return (
    <div className="flex min-h-[70vh] flex-col items-center justify-center px-6 py-16 text-center">
      <div className="coop-intro-rise flex max-w-md flex-col items-center">
        <span aria-hidden className="mb-8 select-none font-sans text-2xl font-extrabold leading-none tracking-tight text-foreground">
          co<span style={{color: 'var(--primary)'}}>o</span>p
        </span>

        <WarningMark />

        <h1 className="mt-7 font-serif text-[2rem] font-normal leading-tight tracking-tight text-foreground">Something broke on our end</h1>
        <p className="mt-3 text-[15px] leading-relaxed text-muted-foreground">
          A server error stopped this page from loading. It is on us, not you. Try again in a moment, or head back to the overview.
        </p>

        <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
          <button
            type="button"
            onClick={() => retry()}
            className="inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md"
          >
            <RetryGlyph />
            Try again
          </button>
          <Link
            href="/"
            className="inline-flex items-center rounded-full border border-border bg-card px-5 py-2.5 text-sm font-medium text-foreground shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md"
          >
            Back to overview
          </Link>
        </div>

        {error.digest ? (
          <p className="mt-10 select-all font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground/70">
            Error {error.digest}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function WarningMark() {
  // Warm clay roundel — a soft signal, not an alarm.
  return (
    <span
      className="flex h-16 w-16 items-center justify-center rounded-full"
      style={{background: 'color-mix(in oklab, var(--destructive) 12%, transparent)'}}
      aria-hidden
    >
      <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="var(--destructive)" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
        <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
        <line x1="12" y1="9" x2="12" y2="13" />
        <line x1="12" y1="17" x2="12.01" y2="17" />
      </svg>
    </span>
  );
}

function RetryGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
      <path d="M3 21v-5h5" />
    </svg>
  );
}
