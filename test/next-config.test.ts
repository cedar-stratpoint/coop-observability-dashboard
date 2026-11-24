// libpg-query (WASM) must stay an external server package: bundled, its .wasm is missing from the build and the Explore parser cannot start
// (found by `next build` on Day 6: "ENOENT .next/server/app/api/chat/libpg-query.wasm"). See next.config.mjs.
import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';

describe('next.config', () => {
  it('keeps libpg-query out of the server bundle (serverExternalPackages)', () => {
    const src = readFileSync('next.config.mjs', 'utf8');
    expect(src).toMatch(/serverExternalPackages:\s*\[[^\]]*'libpg-query'/);
  });

  it('ships libpg-query.wasm with the chat route (outputFileTracingIncludes)', () => {
    const src = readFileSync('next.config.mjs', 'utf8');
    expect(src).toMatch(/outputFileTracingIncludes:\s*\{\s*'\/api\/chat':\s*\[[^\]]*libpg-query\/wasm\/\*\.wasm/);
  });

  it('ships pdf-to-img (its pdfjs-dist + fonts) and the @napi-rs/canvas binary with the Goldline read routes', () => {
    const src = readFileSync('next.config.mjs', 'utf8');
    expect(src).toMatch(/'\/api\/goldline\/\*':\s*\[[^\]]*pdf-to-img\/\*\*\/\*[^\]]*@napi-rs\/\*\*\/\*/);
  });

  // Next 16 dev blocks cross-origin dev requests (the /_next/hmr websocket included) unless the hostname is localhost or listed
  // (node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/allowedDevOrigins.md). Found live: 127.0.0.1:3100 never hydrated.
  it('allows 127.0.0.1 as a dev origin so the page hydrates there (allowedDevOrigins, dev only)', () => {
    const src = readFileSync('next.config.mjs', 'utf8');
    expect(src).toMatch(/allowedDevOrigins:\s*\[[^\]]*'127\.0\.0\.1'/);
  });
});
