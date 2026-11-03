import Link from 'next/link';

export const metadata = {title: 'Not found · Coop'};

// 404 UI, shown by Next when a route has no match or a segment calls notFound().
// Renders inside the root layout (the shell for signed-in viewers), styled to the
// same calm Coop identity as the sign-in and error screens.
export default function NotFound() {
  return (
    <div className="flex min-h-[70vh] flex-col items-center justify-center px-6 py-16 text-center">
      <div className="coop-intro-rise flex max-w-md flex-col items-center">
        <span aria-hidden className="mb-8 select-none font-sans text-2xl font-extrabold leading-none tracking-tight text-foreground">
          co<span style={{color: 'var(--primary)'}}>o</span>p
        </span>

        <span className="select-none font-serif text-[4.5rem] font-normal leading-none tracking-tight text-foreground">404</span>

        <h1 className="mt-5 font-serif text-[1.9rem] font-normal leading-tight tracking-tight text-foreground">This page wandered off</h1>
        <p className="mt-3 text-[15px] leading-relaxed text-muted-foreground">
          The page you are after has moved or never existed. Let us get you back to familiar ground.
        </p>

        <Link
          href="/"
          className="mt-9 inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md"
        >
          <HomeGlyph />
          Back to overview
        </Link>
      </div>
    </div>
  );
}

function HomeGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 9.5 12 3l9 6.5" />
      <path d="M5 10v10h14V10" />
    </svg>
  );
}
