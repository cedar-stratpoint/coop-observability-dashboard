# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# zoomy-observability-dashboard

Coop / BrandOS dashboard (Next.js App Router, Google sign-in). Reads the Supabase archive written by `zoomy-observability` and the POS `pos_*` tables: overview, business health (QRR), channel compare, repricer, product controls, offline sales, and the "Chat with coop" assistant.

Workspace-wide conventions (Supabase/MCP targets, deployments, environments, design skills) live in the parent `../CLAUDE.md` — read it too. **All UI work here must use the design skills** (`emil-design-eng`, `impeccable`, `design-taste-frontend`) per the workspace guidance.

# Changelog

- **`CHANGELOG.md`** (repo root) is the running history of notable dashboard changes. **For any question about history, "what changed", when/why a feature or decision landed, or to log new work, read and update `CHANGELOG.md`** (the git log holds the finer-grained history). Add new entries at the top under the current date and capture the decision, not just the change. POS-side history lives in `../zoomy-pos/CHANGELOG.md`.

# Context Gathering (do this first)

- **A prebuilt knowledge graph lives in `graphify-out/`.** Before reading files broadly to answer a question about the codebase (architecture, "which page renders channel compare", "where does the repricer table get its data", "how does the chat route build its prompt", "what masks PII"), use it instead of grepping and reading whole files. This saves tokens. What's in the folder:
  - `graph.json` — the graph data. Query it with `graphify query "<question>"`; also `graphify explain "<symbol>"` and `graphify path "<A>" "<B>"`. It returns nodes, edges, and `source_location`s so you can jump straight to the right file/line.
  - `GRAPH_REPORT.md` — god nodes, community labels (e.g. Business Health Page, Repricer Page, Coop Chat UI, Digest Types, Google Auth), surprising connections, and known integrity notes.
  - `graph.html` — interactive graph, open in a browser.
- **Rebuild when code drifts:** `graphify . --update` re-extracts only changed files. Do this after substantial edits so the graph stays accurate; a stale graph is worse than none for a specific claim.
- Use the graph to *locate*, then read the actual file to *act*. Don't quote the graph as ground truth for code you're about to change without confirming against the source.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Commands

```bash
npm run dev            # next dev --webpack (http://localhost:3000)
npm run build          # next build --webpack
npm run typecheck      # tsc --noEmit
npm test               # vitest run (tests live in test/*.test.ts)
npx vitest run test/pos-format.test.ts   # single file
npx vitest run -t "name"                 # single test by name
```

No lint script. Always pass `--webpack` (the npm scripts do); Serwist's service worker (`app/sw.ts` -> `public/sw.js`) is disabled in dev.

# Architecture

- **Routing/data split.** Pages under `app/` are Server Components that call readers in `src/*-data.ts` (and `src/data.ts` for the digest archive). Writes are Server Actions in `src/*-actions.ts`. Pure logic lives in `src/*-compute.ts` / `*-types.ts` (unit-tested in `test/`); UI is in `components/analyst/` with shadcn primitives in `components/ui/`. Import alias `@/*` maps to the repo root.
- **One Supabase project, service-role key, server-only.** Digest archive and `pos_*` tables share the project, both read via `SUPABASE_URL_ARCHIVE` / `SUPABASE_SERVICE_ROLE_KEY_ARCHIVE` (never `NEXT_PUBLIC_`, never the anon key). Data modules start with `import 'server-only'` so the build fails if they reach a client component. `digest_archive.bundle` (verbatim customer quotes) is never selected. **Exception: Goldline.** Its `gl_*` tables and `goldline-uploads` bucket live in the separate Nichido project (`NICHIDO_URL` / `NICHIDO_SERVICE_ROLE_KEY`, schema in `supabase/nichido/`). Goldline modules must use `src/nichido-client.ts`, never the archive env (enforced by `test/goldline-nichido-guard.test.ts`). Sign-in and the company registry stay in the archive.
- **Mock fallback.** With the Supabase env unset, readers return built-in mocks (`*-mock.ts`, `usingPosMock()`), so the app runs with no DB. Preserve this when adding a reader.
- **Caching.** Heavy `pos_*` readers use `unstable_cache` with the tags/window in `src/pos-cache.ts` (`POS_TAGS`, 30s revalidate). Every write action must `revalidateTag` the relevant tag so Coop edits show immediately.
- **Auth.** NextAuth v5 Google sign-in (`auth.ts`, optional `ALLOWED_EMAILS` allowlist; sign-ins are upserted into `pos_dashboard_users`). `middleware.ts` protects all pages but excludes `api`, `/signin`, and PWA assets; API routes (e.g. `app/api/chat`) call `auth()` themselves to return 401 instead of a redirect. `DEV_AUTH_BYPASS=true` skips sign-in only when `NODE_ENV=development` (`src/dev-auth.ts`, keep edge-safe: no `server-only`).
- **PII.** Customer names are masked server-side (`src/pii.ts`) before reaching the RSC payload. Mask in the Server Component, not the client.
- **Coop chat.** `app/api/chat/route.ts` builds the prompt from `src/chat/` (`context.ts` = digest data, `knowledge.ts` = brand reference, `config.ts`). Figures come only from digest data; the knowledge block is framed as non-live reference.
- **Other integrations.** Website CRM proxies the Zoomy CRM Worker (`CRM_API_URL`, read-only `CRM_API_READ_TOKEN`); Lazada order uploads (`src/lazada-*`, `supabase/lazada_*.sql`); spin-wheel leads and lead-to-POS-order matching (`src/spin-leads*`, `src/lead-order-match.ts`, `scripts/import-spin-leads.mjs`). SQL for tables this app owns is in `supabase/`.
- Env vars: see `.env.example`; also `ANTHROPIC_API_KEY` (chat) and `ALLOWED_EMAILS`.
- Broader product docs: `docs/coop-documentation.md`. Note `../CLAUDE.md` (workspace guidance) is referenced above but does not currently exist on disk.
