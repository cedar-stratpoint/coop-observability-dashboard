// Import-graph walker and forbidden-pattern scanner for the chat read-only architecture test
// (layer 2, knowledge/best-practices/chat-read-only.md). Pure functions over an in-memory
// file map, so the rules can be proven to fire on planted violations.
//
// Limits (regex, not a parser): comment/string stripping does not understand regex literals, and a
// template literal is treated as one string, so `${a.insert(x)}` inside a template is not scanned.
// Edges written as `import {type X} from` count as value imports (conservative).
import {readdirSync, readFileSync, statSync} from 'node:fs';
import {join, posix} from 'node:path';

export type FileMap = Record<string, string>; // repo-relative posix path -> source text

// removed when the route is rewritten in F5 / slice 5. (Train 4 removed src/crm-data.ts: the Website row reads the GET-only client.)
export const LEGACY_ALLOWED_IMPORTS: readonly string[] = ['src/data.ts'];
export const LEGACY_ROUTE = 'app/api/chat/route.ts';

const EXTS = ['', '.ts', '.tsx', '.mjs', '/index.ts', '/index.tsx', '/index.mjs'];

/** Blank out comments (and, if `strings`, string/template contents) keeping offsets and newlines. */
export function strip(text: string, strings: boolean): string {
  let out = '';
  let i = 0;
  const n = text.length;
  const blank = (s: string) => s.replace(/[^\n]/g, ' ');
  while (i < n) {
    const c = text[i];
    const d = text[i + 1];
    if (c === '/' && d === '/') {
      let j = i;
      while (j < n && text[j] !== '\n') j++;
      out += blank(text.slice(i, j));
      i = j;
    } else if (c === '/' && d === '*') {
      const j = text.indexOf('*/', i + 2);
      const end = j < 0 ? n : j + 2;
      out += blank(text.slice(i, end));
      i = end;
    } else if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < n && text[j] !== c) {
        if (text[j] === '\\') j++;
        j++;
      }
      const end = Math.min(j + 1, n);
      out += strings ? c + blank(text.slice(i + 1, end - 1)) + (end - 1 > i ? c : '') : text.slice(i, end);
      i = end;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** Non-type module specifiers a file imports (static, side-effect, re-export, dynamic). */
export function extractImports(text: string): string[] {
  const t = strip(text, false);
  const specs = new Set<string>();
  const res = [
    /\bimport\s+(?!type\b)[^'";]*?\sfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\bexport\s+(?!type\b)[^'";]*?\sfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const re of res) for (const m of t.matchAll(re)) specs.add(m[1]);
  return [...specs];
}

export function hasUseServer(text: string): boolean {
  return /^\s*['"]use server['"]/.test(strip(text, false));
}

/** Resolve a specifier to a repo-relative file in `files`; null for bare specifiers or unresolved. */
export function resolveImport(spec: string, from: string, files: FileMap): string | null {
  let base: string;
  if (spec.startsWith('@/')) base = posix.normalize(spec.slice(2));
  else if (spec.startsWith('.')) base = posix.normalize(posix.join(posix.dirname(from), spec));
  else return null;
  for (const ext of EXTS) if (base + ext in files) return base + ext;
  return null;
}

export type Closure = {files: Set<string>; bare: Map<string, Set<string>>; legacyHits: string[]};

export function buildClosure(
  entries: string[],
  files: FileMap,
  legacy: {from: string; allowed: readonly string[]} = {from: LEGACY_ROUTE, allowed: LEGACY_ALLOWED_IMPORTS},
): Closure {
  const seen = new Set<string>();
  const bare = new Map<string, Set<string>>();
  const legacyHits: string[] = [];
  const queue = entries.filter((e) => e in files);
  while (queue.length) {
    const f = queue.pop() as string;
    if (seen.has(f)) continue;
    seen.add(f);
    for (const spec of extractImports(files[f])) {
      const r = resolveImport(spec, f, files);
      if (r === null) {
        if (!spec.startsWith('.') && !spec.startsWith('@/')) {
          if (!bare.has(spec)) bare.set(spec, new Set());
          bare.get(spec)?.add(f);
        }
        continue;
      }
      if (f === legacy.from && legacy.allowed.includes(r)) {
        legacyHits.push(r); // allowed, and not traversed
        continue;
      }
      queue.push(r);
    }
  }
  return {files: seen, bare, legacyHits};
}

// The reports write seam (F9, layer 7): the actions, the guarded clients, and the modules that wrap them. The pure reports
// modules (reports-run, -access, -suggest, -types) are NOT here: the chat may share them, they hold no I/O.
// Train 4: pure CRM modules the chat may import (the field contract and the CRM rules; no I/O, pinned pure by the architecture test).
// src/crm-data.ts (the pages' cached proxy with its own fetch) stays forbidden.
export const PURE_CRM_MODULES: readonly string[] = ['src/crm-compute.ts', 'src/crm-project.ts', 'src/crm-types.ts'];

export const REPORTS_IO_FILES: readonly string[] = ['src/reports-actions.ts', 'src/reports-client.ts', 'src/reports-data.ts', 'src/reports-session.ts'];
const FORBIDDEN_FILES = new Set(['src/pos-data.ts', 'src/data.ts', ...REPORTS_IO_FILES]);

export function forbiddenInClosure(closure: Closure, files: FileMap): string[] {
  const bad: string[] = [];
  for (const f of closure.files) {
    if (/(^|\/)[^/]*-actions\.ts$/.test(f)) bad.push(`${f}: server-actions file`);
    if (FORBIDDEN_FILES.has(f)) bad.push(`${f}: forbidden module`);
    if (/^src\/crm-[^/]*\.ts$/.test(f) && !PURE_CRM_MODULES.includes(f)) bad.push(`${f}: crm module`);
    if (hasUseServer(files[f])) bad.push(`${f}: 'use server' directive`);
  }
  return bad;
}

/** Bare modules a PURE module (src/reports-run.ts) may never reach: server-only, a database or model client, Next, auth. */
const IMPURE_BARE = [/^server-only$/, /^@supabase\//, /^@anthropic-ai\//, /^next(\/|$)/, /^next-auth(\/|$)/];

/** Why a module that must stay pure (no I/O, no model, no server-only) is not: everything in its closure that breaks that. */
export function impureInClosure(closure: Closure, files: FileMap): string[] {
  const bad: string[] = [];
  for (const [spec, importers] of closure.bare) {
    if (IMPURE_BARE.some((re) => re.test(spec))) bad.push(`${spec}: imported by ${[...importers].sort().join(', ')}`);
  }
  for (const f of closure.files) {
    if (/(^|\/)[^/]*-actions\.ts$/.test(f) || FORBIDDEN_FILES.has(f)) bad.push(`${f}: forbidden module`);
    if (hasUseServer(files[f])) bad.push(`${f}: 'use server' directive`);
  }
  return bad.sort();
}

/** Files (anywhere in `files`) that import `target`, as repo-relative paths. Type-only imports are ignored. */
export function importersOf(target: string, files: FileMap): string[] {
  return Object.keys(files)
    .filter((f) => f !== target && extractImports(files[f]).some((spec) => resolveImport(spec, f, files) === target))
    .sort();
}

/** Files under src/chat/ that import @supabase/supabase-js (non-type). */
export function supabaseImporters(files: FileMap): string[] {
  return Object.keys(files)
    .filter((f) => f.startsWith('src/chat/') && extractImports(files[f]).includes('@supabase/supabase-js'))
    .sort();
}

const WRITE_CALL = /\.\s*(insert|update|upsert|delete|rpc)\s*\(/g;

/**
 * Calls that look like database writes but are not. Matched on the exact file AND method, and pinned by a
 * test so the list can only change deliberately. Anything else under src/chat that calls these is still flagged.
 */
export const WRITE_CALL_EXCEPTIONS: readonly {file: string; method: string; why: string}[] = [
  {file: 'src/chat/read/mint-jwt.ts', method: 'update', why: 'node:crypto Hmac.update when signing the read-only token; not a database call'},
  {file: 'src/chat/explore/fingerprint.ts', method: 'update', why: 'node:crypto Hash.update when fingerprinting a validated Explore statement for the audit log; not a database call'},
];

/** Method-call writes in non-test files under src/chat/ (comments and strings ignored). */
export function writeCallsIn(files: FileMap): string[] {
  const hits: string[] = [];
  for (const f of Object.keys(files)) {
    if (!f.startsWith('src/chat/') || /\.(test|spec)\.[tj]sx?$/.test(f)) continue;
    for (const m of strip(files[f], true).matchAll(WRITE_CALL)) {
      if (WRITE_CALL_EXCEPTIONS.some((e) => e.file === f && e.method === m[1])) continue;
      hits.push(`${f}: .${m[1]}(`);
    }
  }
  return hits;
}

/** Every .ts/.tsx/.mjs file under `dirs` (repo-relative), skipping node_modules and .next. */
export function loadDirs(root: string, dirs: string[]): FileMap {
  const files: FileMap = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(join(root, dir))) {
      if (name === 'node_modules' || name === '.next') continue;
      const rel = `${dir}/${name}`;
      if (statSync(join(root, rel)).isDirectory()) walk(rel);
      else if (/\.(ts|tsx|mjs)$/.test(name)) files[rel] = readFileSync(join(root, rel), 'utf8');
    }
  };
  for (const d of dirs) walk(d);
  return files;
}

/**
 * Load the real tree: src/chat/** plus the chat route, and (lazily) any file reachable from them. `extra` files (and
 * what they import) are loaded into the map too but are NOT chat entries: they let a test walk a closure of its own.
 */
export function loadRealTree(root: string, extra: string[] = []): {files: FileMap; entries: string[]} {
  const files: FileMap = {};
  const entries: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(join(root, dir))) {
      const rel = `${dir}/${name}`;
      const st = statSync(join(root, rel));
      if (st.isDirectory()) walk(rel);
      else if (/\.(ts|tsx|mjs)$/.test(name)) {
        files[rel] = readFileSync(join(root, rel), 'utf8');
        entries.push(rel);
      }
    }
  };
  walk('src/chat');
  files[LEGACY_ROUTE] = readFileSync(join(root, LEGACY_ROUTE), 'utf8');
  entries.push(LEGACY_ROUTE);
  for (const e of extra) files[e] = readFileSync(join(root, e), 'utf8');
  // Pull in everything else reachable so resolution has the text.
  const queue = [...entries, ...extra];
  while (queue.length) {
    const f = queue.pop() as string;
    for (const spec of extractImports(files[f])) {
      if (!spec.startsWith('@/') && !spec.startsWith('.')) continue;
      const base = spec.startsWith('@/') ? posix.normalize(spec.slice(2)) : posix.normalize(posix.join(posix.dirname(f), spec));
      for (const ext of EXTS) {
        const cand = base + ext;
        if (cand in files) break;
        try {
          if (statSync(join(root, cand)).isFile()) {
            files[cand] = readFileSync(join(root, cand), 'utf8');
            queue.push(cand);
            break;
          }
        } catch {
          // not this candidate
        }
      }
    }
  }
  return {files, entries};
}
