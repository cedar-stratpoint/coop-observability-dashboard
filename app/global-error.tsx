'use client';

// Root error boundary. Active only when the root layout itself fails, so it
// replaces <html>/<body> and cannot depend on globals.css, the @theme tokens, or
// the Inter/Newsreader fonts (all loaded by the layout that just crashed). Every
// style here is therefore self-contained and inlined, with light/dark driven by
// prefers-color-scheme (the layout's theme-seeding script is gone too). This is
// the screen that replaces Next's bare default "This page couldn't load". Next 16
// passes `retry` (not `reset`).
import {useEffect} from 'react';

const STYLES = `
  .coop-ge {
    --bg: #F8F4F1; --ink: #1B1A16; --muted: #8A857A; --primary: #3F6E56;
    --on-primary: #F7F5EF; --clay: #B4462F; --border: #E7E1D8; --card: #FFFFFF;
    color-scheme: light;
  }
  @media (prefers-color-scheme: dark) {
    .coop-ge {
      --bg: #17150F; --ink: #EDE9E1; --muted: #A9A395; --primary: #7FB08E;
      --on-primary: #16241C; --clay: #D9765C; --border: rgba(255,255,255,0.12); --card: #201D16;
      color-scheme: dark;
    }
  }
  .coop-ge {
    margin: 0;
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 4rem 1.5rem;
    text-align: center;
    background: var(--bg);
    color: var(--ink);
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .coop-ge__inner { max-width: 28rem; display: flex; flex-direction: column; align-items: center; animation: coop-ge-rise 0.9s cubic-bezier(0.2,0.7,0.2,1) both; }
  .coop-ge__mark { font-weight: 800; font-size: 1.5rem; letter-spacing: -0.02em; margin-bottom: 2rem; user-select: none; }
  .coop-ge__mark span { color: var(--primary); }
  .coop-ge__roundel { width: 4rem; height: 4rem; border-radius: 9999px; display: flex; align-items: center; justify-content: center; background: color-mix(in oklab, var(--clay) 12%, transparent); }
  .coop-ge__title { font-family: Newsreader, Georgia, "Times New Roman", serif; font-weight: 400; font-size: 2rem; line-height: 1.15; letter-spacing: -0.01em; margin: 1.75rem 0 0; }
  .coop-ge__body { font-size: 15px; line-height: 1.65; color: var(--muted); margin: 0.75rem 0 0; }
  .coop-ge__btn {
    margin-top: 2.25rem; display: inline-flex; align-items: center; gap: 0.5rem;
    border: none; cursor: pointer; border-radius: 9999px; padding: 0.7rem 1.4rem;
    font-size: 0.875rem; font-weight: 500; font-family: inherit;
    background: var(--primary); color: var(--on-primary);
    box-shadow: 0 1px 2px rgba(0,0,0,0.08);
    transition: transform 0.18s ease, box-shadow 0.18s ease;
  }
  .coop-ge__btn:hover { transform: translateY(-2px); box-shadow: 0 6px 16px rgba(0,0,0,0.12); }
  .coop-ge__digest { margin-top: 2.5rem; font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 11px; text-transform: uppercase; letter-spacing: 0.18em; color: var(--muted); user-select: all; }
  @keyframes coop-ge-rise { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
  @media (prefers-reduced-motion: reduce) {
    .coop-ge__inner { animation: none; }
    .coop-ge__btn { transition: none; }
  }
`;

export default function GlobalError({error, retry}: {error: Error & {digest?: string}; retry: () => void}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <html lang="en">
      <body className="coop-ge">
        <style dangerouslySetInnerHTML={{__html: STYLES}} />
        <div className="coop-ge__inner">
          <div className="coop-ge__mark" aria-hidden>
            co<span>o</span>p
          </div>

          <div className="coop-ge__roundel" aria-hidden>
            <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="var(--clay)" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
          </div>

          <h1 className="coop-ge__title">Something broke on our end</h1>
          <p className="coop-ge__body">A server error stopped Coop from loading. It is on us, not you. Reload to try again in a moment.</p>

          <button type="button" className="coop-ge__btn" onClick={() => retry()}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
              <path d="M21 3v5h-5" />
              <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
              <path d="M3 21v-5h5" />
            </svg>
            Reload
          </button>

          {error.digest ? <p className="coop-ge__digest">Error {error.digest}</p> : null}
        </div>
      </body>
    </html>
  );
}
