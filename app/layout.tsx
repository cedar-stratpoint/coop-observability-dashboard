import type {Metadata, Viewport} from 'next';
import type {ReactNode} from 'react';
import {Suspense} from 'react';
import {Inter, Newsreader} from 'next/font/google';
import {cn} from '@/lib/utils';
import {getDigests, usingMock} from '@/src/data';
import {getNavContext} from '@/src/active-context';
import {DashboardShell} from '@/components/analyst/dashboard-shell';
import {IntroSplash} from '@/components/analyst/intro-splash';
import {auth} from '@/auth';
import {devAuthEnabled, DEV_SESSION} from '@/src/dev-auth';
import './globals.css';

// Coop identity: Inter for UI/data, Newsreader for the editorial serif display.
const sans = Inter({subsets: ['latin'], weight: ['400', '500', '600', '700'], variable: '--font-sans'});
// Newsreader is only ever used at weight 400, upright (all `font-serif` usages are
// `font-normal`; no serif-italic anywhere — body italics are Inter). Loading just
// 400/normal drops ~6 unused font files (300/500/600 + the italic set).
const serif = Newsreader({subsets: ['latin'], weight: ['400'], style: ['normal'], variable: '--font-serif'});

export const metadata: Metadata = {
  title: 'Coop · BrandOS — Zoomy',
  description: 'The Brand Operating System — store-ops analytics for Zoomy across Shopee, Lazada and the website.',
};

// Mobile: opt into device-width + safe-area insets, and tint the browser chrome
// to the Coop canvas. Inert on desktop (themeColor/viewport-fit have no layout
// effect there). We keep the default scale/user-scalable — no fixed width, no
// maximum-scale — so desktop zoom and a11y are unchanged.
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: [
    {media: '(prefers-color-scheme: light)', color: '#F8F4F1'},
    {media: '(prefers-color-scheme: dark)', color: '#17150F'},
  ],
};

export default async function RootLayout({children}: {children: ReactNode}) {
  // Only authenticated views get the shell + data; the sign-in page renders bare.
  const session = devAuthEnabled() ? DEV_SESSION : await auth();
  const authed = Boolean(session?.user);
  // The shell (header + week sidebar + tab nav) is shared across all tab routes,
  // so it fetches the week list once here; getDigests() is React-cached so the
  // page doesn't re-fetch. useSearchParams inside the shell needs a Suspense boundary.
  const nav = authed ? await getNavContext() : null;
  // Zoomy's digests must load ONLY for a Zoomy viewer — otherwise the RSC payload
  // would ship Zoomy data to a Goldline user / data-blind Coop Admin on every route
  // (even /uploads), above the per-section guards. Local dev-auth bypass (null nav)
  // and legacy authed staff with no membership stay on Zoomy; a resolved non-Zoomy
  // company gets none.
  // (Dev bypass with no DEV_AUTH_AS has no nav → Zoomy, as before; with DEV_AUTH_AS it
  // follows the stand-in membership like a real session.)
  const isZoomyViewer = authed && (!nav || nav.companyId === 'zoomy');
  const digests = isZoomyViewer ? await getDigests() : [];
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Seed the theme class before first paint (no flash). Coop is light-first
            (cream canvas), so default to light unless the user explicitly chose dark. */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "(function(){try{var t=localStorage.getItem('zoomy-theme');document.documentElement.classList.toggle('dark',t==='dark');if(sessionStorage.getItem('coop-splash-seen'))document.documentElement.classList.add('coop-splash-seen');}catch(e){}})();",
          }}
        />
      </head>
      <body className={cn(sans.variable, serif.variable, 'font-sans antialiased')}>
        {authed ? (
          <>
            <IntroSplash />
            <Suspense>
              <DashboardShell digests={digests} usingMock={usingMock()} nav={nav ?? undefined} user={{name: session!.user?.name, email: session!.user?.email, image: session!.user?.image}}>
                {children}
              </DashboardShell>
            </Suspense>
          </>
        ) : (
          children
        )}
      </body>
    </html>
  );
}
