import withSerwistInit from '@serwist/next';
import {headerRules} from './security-headers.mjs';

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Explore's SQL parser (src/chat/explore/parse.ts) loads libpg-query's WASM by a path next to its own file. Bundled, that file is
  // missing from .next/server (the build logs ENOENT libpg-query.wasm and the route cannot parse); as an external package Node loads it
  // from node_modules and the file trace ships it. Pinned by test/next-config.test.ts.
  serverExternalPackages: ['libpg-query'],
  // The trace follows libpg-query's .js files but not the .wasm it reads by path: ship it with the chat route (Vercel U2 stays UNVERIFIED until a preview deploy).
  outputFileTracingIncludes: {'/api/chat': ['./node_modules/libpg-query/wasm/*.wasm']},
  // Dev only (ignored by build and start): Next 16 blocks cross-origin dev requests, the /_next/hmr websocket included, from any hostname but
  // localhost, so http://127.0.0.1:3100 never hydrated. Hostname only, no scheme or port. Pinned by test/next-config.test.ts.
  allowedDevOrigins: ['127.0.0.1'],
  // A small CSP (img-src, object-src, base-uri, frame-ancestors only); see security-headers.mjs.
  headers: async () => headerRules(),
  experimental: {
    // Keep dynamic pages (Uploads, scan views) in the client router cache for 30s so
    // back-navigation and repeat visits are instant instead of refetching from scratch.
    // Default is 0 (always refetch). A mutation still calls router.refresh(), which busts
    // this, so edits show immediately; the window only covers idle back/forward nav.
    staleTimes: {dynamic: 30},
  },
};

// Service worker (Serwist). Precaches static build assets only; never caches
// navigations or data (see app/sw.ts). Disabled in dev to avoid stale-cache pain.
const withSerwist = withSerwistInit({
  swSrc: 'app/sw.ts',
  swDest: 'public/sw.js',
  cacheOnNavigation: false,
  register: true,
  reloadOnOnline: true,
  disable: process.env.NODE_ENV === 'development',
});

export default withSerwist(nextConfig);
