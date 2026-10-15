// Which data each dashboard page shows, for the per-turn context (spec F.2). Pure; reads the generated catalog.
// Source: knowledge/data-catalog/pages.md through catalog.json (spec 3.1). Fenced pages resolve but say they cannot be read.
import {CATALOG_DATA} from './catalog';
export type PageInfo = {route: string; title: string; shows: string; data: string};

// Train 4: an API Ask Coop reads with its own tools (apis.md "Ask Coop" = "tools: ...") names those tools on every page that reads it.
const API_TOOLS = new Map(CATALOG_DATA.apis.filter((a) => /^tools:/i.test(a.askCoop)).map((a) => [a.id, a.askCoop.replace(/^tools:\s*/i, '')]));
const withTools = (data: string, domains: readonly string[]): string => {
  const tools = domains.flatMap((d) => API_TOOLS.get(d) ?? []);
  return tools.length > 0 ? `${data}; read live by the tools ${tools.join('; ')}` : data;
};

export const PAGES: readonly PageInfo[] = CATALOG_DATA.pages.map((p) => ({
  route: p.route,
  title: p.title,
  shows: p.redirectTo ? `redirects to ${p.redirectTo}` : p.shows,
  data: p.fenced ? "another company's data: Ask Coop cannot read it" : withTools(p.data, p.domains),
}));

const MAX_PATH = 200;
const MAX_QUERY = 300;
const MAX_PAIRS = 5;
const PATH_RE = /^\/(?!\/)[\w\-./[\]]*$/;
const MAX_LINKS = 3;

/** Exact route first, then a single dynamic segment (`[x]`). Never a word prefix. */
export function resolvePage(path: string): PageInfo | null {
  const clean = path.split('?')[0].replace(/\/+$/, '') || '/';
  const exact = PAGES.find((p) => p.route === clean);
  if (exact) return exact;
  const parts = clean.split('/');
  for (const p of PAGES) {
    const r = p.route.split('/');
    if (r.length === parts.length && r.every((seg, i) => seg === parts[i] || /^\[.+\]$/.test(seg))) return p;
  }
  return null;
}

/** Allow-list for a query string that reaches the model: short plain key=value pairs only, at most 5. */
function safeQuery(raw: string): string {
  const out: string[] = [];
  for (const [k, v] of new URLSearchParams(raw)) {
    if (/^[a-z_]{1,20}$/.test(k) && /^[\w.:-]{1,40}$/.test(v)) out.push(`${k}=${v}`);
    if (out.length === MAX_PAIRS) break;
  }
  return out.join('&');
}

/** Untrusted client input -> a safe {path, query} or null. */
export function readPageInput(raw: unknown): {path: string; query: string} | null {
  if (raw === null || typeof raw !== 'object') return null;
  const {path, query} = raw as {path?: unknown; query?: unknown};
  if (typeof path !== 'string' || path.length > MAX_PATH || !PATH_RE.test(path)) return null;
  const q = typeof query === 'string' && query.length <= MAX_QUERY ? safeQuery(query) : '';
  return {path, query: q};
}

/** Dashboard links (same host only) pasted in a message, as path?query, at most 3. */
export function dashboardLinks(text: string, host: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/https?:\/\/[^\s<>"')]+/g)) {
    let u: URL;
    try { u = new URL(m[0]); } catch { continue; }
    if (u.host !== host) continue;
    if (u.pathname.length > MAX_PATH || !PATH_RE.test(u.pathname) || !resolvePage(u.pathname)) continue;
    const q = u.search.length <= MAX_QUERY + 1 ? safeQuery(u.search) : '';
    out.push(q ? `${u.pathname}?${q}` : u.pathname);
    if (out.length === MAX_LINKS) break;
  }
  return out;
}

const describe = (p: PageInfo): string => `${p.title}: shows ${p.shows}; data: ${p.data}`;

/** One per-turn line, or null when no known page is in play. Never goes in the cached system prompt. */
export function pageContextLine(current: {path: string; query: string} | null, pasted: string[]): string | null {
  const parts: string[] = [];
  const cur = current ? resolvePage(current.path) : null;
  if (current && cur) parts.push(`The owner is on ${current.path}${current.query ? `?${current.query}` : ''} (${describe(cur)}).`);
  for (const link of pasted) {
    const p = resolvePage(link);
    if (p) parts.push(`They pasted a link to ${link} (${describe(p)}).`);
  }
  return parts.length ? `[page] ${parts.join(' ')}` : null;
}
