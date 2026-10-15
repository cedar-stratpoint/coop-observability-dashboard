import {describe, expect, it} from 'vitest';
import {
  LEGACY_ALLOWED_IMPORTS,
  LEGACY_ROUTE,
  PURE_CRM_MODULES,
  REPORTS_IO_FILES,
  WRITE_CALL_EXCEPTIONS,
  buildClosure,
  extractImports,
  forbiddenInClosure,
  impureInClosure,
  importersOf,
  loadDirs,
  loadRealTree,
  strip,
  supabaseImporters,
  writeCallsIn,
  type FileMap,
} from './support/chat-arch-scan';

describe('real tree', () => {
  const {files, entries} = loadRealTree(process.cwd());
  const closure = buildClosure(entries, files);

  it('chat closure contains no actions, use-server, pos-data, data, crm or reports-write modules', () => {
    expect(forbiddenInClosure(closure, files)).toEqual([]);
  });

  it('only src/chat/read/client.ts imports @supabase/supabase-js under src/chat', () => {
    const importers = supabaseImporters(files);
    expect(importers.filter((f) => f !== 'src/chat/read/client.ts')).toEqual([]);
  });

  it('src/chat has no write-method calls', () => {
    expect(writeCallsIn(files)).toEqual([]);
  });

  it('the only legacy exception is the old digest import, and it is not traversed (Train 4 removed the CRM one)', () => {
    expect([...closure.legacyHits]).toEqual(['src/data.ts']);
    expect(closure.files.has('src/data.ts')).toBe(false);
    expect(closure.files.has('src/crm-data.ts')).toBe(false);
  });

  it('no chat module or the chat route mentions src/crm-data.ts in any import form', () => {
    const all = loadDirs(process.cwd(), ['src/chat', 'app/api/chat']);
    for (const [f, src] of Object.entries(all)) {
      if (/\.(test|spec)\./.test(f)) continue;
      expect(/crm-data/.test(strip(src, false)), `${f} imports crm-data`).toBe(false);
    }
  });
});

// Layer 7 (F9): the reports write path is unreachable from chat, and the module that renders a saved report stays pure.
describe('reports write separation (layer 7), real tree', () => {
  it.each(PURE_CRM_MODULES)('Train 4: %s stays pure (no server-only, Supabase, Anthropic, Next or auth)', (entry) => {
    expect(impureInClosure(buildClosure([entry], files), files)).toEqual([]);
  });

  const PURE = ['src/reports-run.ts', 'src/reports-access.ts', 'src/reports-suggest.ts', 'src/reports-types.ts'];
  const {files, entries} = loadRealTree(process.cwd(), [...PURE, ...REPORTS_IO_FILES]);
  const all = loadDirs(process.cwd(), ['src', 'app', 'components', 'lib']);

  it('the chat tree (and the chat route) reaches none of the reports actions, clients, readers or session modules', () => {
    const closure = buildClosure(entries, files);
    for (const f of REPORTS_IO_FILES) expect(closure.files.has(f)).toBe(false);
    expect(forbiddenInClosure(closure, files).filter((v) => v.includes('reports-'))).toEqual([]);
  });

  it('no file under src/chat names reportsWriteClient, reportsReadClient, saveReport or deleteReport', () => {
    const hits = Object.keys(files)
      .filter((f) => f.startsWith('src/chat/') && !/\.(test|spec)\./.test(f))
      .filter((f) => /reportsWriteClient|reportsReadClient|\b(saveReport|updateReport|restoreVersion|deleteReport|renameReport|setPinned|setVisibility)\b/.test(strip(files[f], true)));
    expect(hits).toEqual([]);
  });

  it.each(PURE)('%s stays pure: no server-only, Supabase, Anthropic, Next or auth anywhere in its import closure', (entry) => {
    const closure = buildClosure([entry], files);
    expect(impureInClosure(closure, files)).toEqual([]);
  });

  it('src/reports-run.ts really is walked (it reaches the chat machinery it reuses), so the purity test is not vacuous', () => {
    const closure = buildClosure(['src/reports-run.ts'], files);
    expect(closure.files.has('src/chat/report-session.ts')).toBe(true);
    expect(closure.files.has('src/chat/report-spec.ts')).toBe(true);
    expect(closure.files.has('src/chat/query-metric.ts')).toBe(true);
  });

  it('the write client is imported by src/reports-actions.ts alone; the read client by the readers only', () => {
    const importers = (t: string) => importersOf(t, all).filter((f) => !f.startsWith('test/'));
    expect(importers('src/reports-client.ts')).toEqual(['src/reports-actions.ts', 'src/reports-data.ts']);
    const writeClientUsers = Object.keys(all).filter((f) => /\breportsWriteClient\b/.test(strip(all[f], true)));
    expect(writeClientUsers.sort()).toEqual(['src/reports-actions.ts', 'src/reports-client.ts']);
  });

  it('nothing under src/ imports the actions module (only UI under app/ and components/ may, from a click)', () => {
    expect(importersOf('src/reports-actions.ts', all).filter((f) => f.startsWith('src/'))).toEqual([]);
  });

  it('only the actions file and the reports modules carry the write verbs for the report tables', () => {
    const writers = Object.keys(all)
      .filter((f) => /coop_report_versions|coop_reports/.test(strip(all[f], false)) && !f.startsWith('src/chat/'))
      .filter((f) => !f.startsWith('src/reports-'));
    expect(writers).toEqual([]);
  });

  it('reports-actions.ts is a use-server file, so any chat import of it would also trip the use-server rule', () => {
    expect(files['src/reports-actions.ts'].trimStart().startsWith("'use server'")).toBe(true);
  });
});

describe('reports separation rules fire on planted violations', () => {
  const base: FileMap = {
    'src/chat/ok.ts': 'export const ok = 1;',
    'src/reports-actions.ts': "'use server';\nexport async function saveReport() {}",
    'src/reports-client.ts': "import 'server-only';\nexport const reportsWriteClient = () => null;",
    'src/reports-data.ts': "import {reportsReadClient} from './reports-client';\nexport const listReports = () => reportsReadClient();",
    'src/reports-session.ts': "import 'server-only';\nexport const reportsViewerEmail = () => null;",
    'src/reports-run.ts': "import {x} from './chat/ok';\nexport const runReport = () => x;",
  };
  const closureOf = (extra: FileMap, entries: string[]) => {
    const files = {...base, ...extra};
    return {files, closure: buildClosure(entries, files)};
  };

  it.each(REPORTS_IO_FILES)('a chat file importing %s fails', (target) => {
    const spec = `@/${target.replace(/\.ts$/, '')}`;
    const {files, closure} = closureOf({'src/chat/bad.ts': `import {x} from '${spec}';`}, ['src/chat/ok.ts', 'src/chat/bad.ts']);
    expect(forbiddenInClosure(closure, files).join()).toContain(target);
  });

  it('a transitive chat import of reports-actions through a helper fails', () => {
    const {files, closure} = closureOf({'src/chat/bad.ts': "import {h} from './helper';", 'src/chat/helper.ts': "export {saveReport as h} from '../reports-actions';"}, ['src/chat/bad.ts']);
    expect(forbiddenInClosure(closure, files).join()).toContain('src/reports-actions.ts');
  });

  it('a pure reports module importing server-only, supabase-js, the model SDK, next or auth is reported', () => {
    for (const spec of ['server-only', '@supabase/supabase-js', '@anthropic-ai/sdk', 'next/cache', 'next-auth']) {
      const {files, closure} = closureOf({'src/reports-run.ts': `import '${spec}';\nexport const runReport = 1;`}, ['src/reports-run.ts']);
      expect(impureInClosure(closure, files).join()).toContain(spec);
    }
  });

  it('a pure reports module that reaches the client, the actions or a use-server file is reported', () => {
    const viaClient = closureOf({'src/reports-run.ts': "import {reportsWriteClient} from './reports-client';"}, ['src/reports-run.ts']);
    expect(impureInClosure(viaClient.closure, viaClient.files).join()).toContain('src/reports-client.ts');
    const viaHelper = closureOf({'src/reports-run.ts': "import {h} from './helper';", 'src/helper.ts': "import {saveReport} from './reports-actions';"}, ['src/reports-run.ts']);
    expect(impureInClosure(viaHelper.closure, viaHelper.files).join()).toContain('src/reports-actions.ts');
    const useServer = closureOf({'src/reports-run.ts': "import {p} from './plain';", 'src/plain.ts': "'use server'\nexport const p = 1;"}, ['src/reports-run.ts']);
    expect(impureInClosure(useServer.closure, useServer.files).join()).toContain("'use server' directive");
  });

  it('a clean pure module reports nothing, and a type-only import of the client is ignored', () => {
    const {files, closure} = closureOf({'src/reports-run.ts': "import type {DbRow} from './reports-client';\nexport const runReport = 1;"}, ['src/reports-run.ts']);
    expect(impureInClosure(closure, files)).toEqual([]);
  });

  it('importersOf lists exactly the files that import a target', () => {
    const files = {...base, 'src/other.ts': "import {listReports} from './reports-data';"};
    expect(importersOf('src/reports-data.ts', files)).toEqual(['src/other.ts']);
    expect(importersOf('src/reports-client.ts', files)).toEqual(['src/reports-data.ts']);
  });
});

describe('LEGACY_ALLOWED_IMPORTS', () => {
  it('has exactly these entries so it can only shrink deliberately', () => {
    expect(LEGACY_ALLOWED_IMPORTS).toEqual(['src/data.ts']);
  });
});

describe('scanner rules fire on planted violations', () => {
  it('Train 4: the pure CRM modules may be imported by chat; the pages reader and any other crm module may not', () => {
    const ok = run({'src/chat/c.ts': "import {projectOrder} from '../crm-project';", 'src/crm-project.ts': "import {checkoutStage} from './crm-compute';", 'src/crm-compute.ts': 'export const checkoutStage = 1;'});
    expect(forbiddenInClosure(ok.closure, ok.files)).toEqual([]);
    const bad = run({'src/chat/c.ts': "import {getCrmOrders} from '../crm-data';", 'src/crm-data.ts': 'export const getCrmOrders = 1;'});
    expect(forbiddenInClosure(bad.closure, bad.files).join()).toContain('src/crm-data.ts: crm module');
  });

  const base: FileMap = {
    'src/chat/ok.ts': "import {x} from './util';\nexport const y = x;",
    'src/chat/util.ts': 'export const x = 1;',
    'src/pos-data.ts': "export const posClient = () => null;",
    'src/data.ts': 'export const getDigests = () => [];',
    'src/foo-actions.ts': "'use server';\nexport async function save() {}",
    'src/crm-x.ts': 'export const c = 1;',
    'src/plain.ts': "'use server'\nexport const p = 1;",
    [LEGACY_ROUTE]: "import {getDigests} from '@/src/data';\nimport {x} from '@/src/chat/ok';",
  };
  const run = (extra: FileMap, entries = ['src/chat/ok.ts', ...Object.keys(extra).filter((f) => f.startsWith('src/chat/'))]) => {
    const files = {...base, ...extra};
    return {files, closure: buildClosure(entries, files)};
  };

  it('clean baseline passes', () => {
    const {files, closure} = run({});
    expect(forbiddenInClosure(closure, files)).toEqual([]);
    expect(writeCallsIn(files)).toEqual([]);
  });

  it('planted import of src/pos-data.ts fails', () => {
    const {files, closure} = run({'src/chat/bad.ts': "import {posClient} from '@/src/pos-data';"});
    expect(forbiddenInClosure(closure, files).join()).toContain('src/pos-data.ts');
  });

  it('planted transitive import of an actions file fails', () => {
    const {files, closure} = run({
      'src/chat/bad.ts': "import {h} from './helper';",
      'src/chat/helper.ts': "export {save as h} from '../foo-actions';",
    });
    expect(forbiddenInClosure(closure, files).join()).toContain('src/foo-actions.ts');
  });

  it('planted dynamic import and crm module fail', () => {
    const {files, closure} = run({'src/chat/bad.ts': "export const f = () => import('../crm-x');"});
    expect(forbiddenInClosure(closure, files).join()).toContain('src/crm-x.ts');
  });

  it("planted 'use server' file (not named -actions) fails", () => {
    const {files, closure} = run({'src/chat/bad.ts': "import {p} from '../plain';"});
    expect(forbiddenInClosure(closure, files).join()).toContain("'use server' directive");
  });

  it('a type-only import is ignored', () => {
    const {files, closure} = run({'src/chat/t.ts': "import type {posClient} from '@/src/pos-data';"});
    expect(forbiddenInClosure(closure, files)).toEqual([]);
  });

  it('planted second supabase-js importer is reported, the allowed one is not a violation', () => {
    const files: FileMap = {
      'src/chat/read/client.ts': "import {createClient} from '@supabase/supabase-js';",
      'src/chat/other.ts': "import {createClient} from '@supabase/supabase-js';",
      'src/chat/types-only.ts': "import type {SupabaseClient} from '@supabase/supabase-js';",
    };
    expect(supabaseImporters(files)).toEqual(['src/chat/other.ts', 'src/chat/read/client.ts']);
  });

  it.each(['.insert(', '.update(', '.upsert(', '.delete(', '.rpc('])('planted %s call fails', (call) => {
    expect(writeCallsIn({'src/chat/bad.ts': `const r = await db.from('t')${call}{a: 1});`})).toHaveLength(1);
  });

  it('write-call words inside comments and strings are ignored, and test files are skipped', () => {
    const files: FileMap = {
      'src/chat/doc.ts': "// never call db.insert(x)\n/* .rpc( */\nconst s = 'x.update(y)';\nconst t = `.delete(`;",
      'src/chat/a.test.ts': 'db.insert(1);',
    };
    expect(writeCallsIn(files)).toEqual([]);
  });

  it('the crypto update exceptions cover exactly two files and one method', () => {
    expect(WRITE_CALL_EXCEPTIONS.map((e) => `${e.file}:${e.method}`)).toEqual(['src/chat/read/mint-jwt.ts:update', 'src/chat/explore/fingerprint.ts:update']);
    // same call, allowed file: ignored
    expect(writeCallsIn({'src/chat/read/mint-jwt.ts': "const sig = createHmac('sha256', k).update(data).digest();"})).toEqual([]);
    // same call, any other file: still flagged
    expect(writeCallsIn({'src/chat/other.ts': "const sig = createHmac('sha256', k).update(data).digest();"})).toHaveLength(1);
    // another write method, allowed file: still flagged
    expect(writeCallsIn({'src/chat/read/mint-jwt.ts': "await db.from('t').insert({a: 1});"})).toHaveLength(1);
    expect(writeCallsIn({'src/chat/read/mint-jwt.ts': "await db.from('t').delete().eq('id', 1);"})).toHaveLength(1);
  });

  it('the legacy allowance applies only to the route and is not traversed', () => {
    const {closure} = run({}, [LEGACY_ROUTE]);
    expect(closure.legacyHits).toEqual(['src/data.ts']);
    expect(closure.files.has('src/data.ts')).toBe(false);
    const {files, closure: c2} = run({'src/chat/bad.ts': "import {getDigests} from '@/src/data';"});
    expect(forbiddenInClosure(c2, files).join()).toContain('src/data.ts');
  });

  it('extractImports and strip basics', () => {
    expect(extractImports("import a from 'x';\nimport 'y';\nexport * from './z';\nimport type {T} from 't';")).toEqual(['x', 'y', './z']);
    expect(strip("a('//x') // c", true)).not.toContain('c');
  });
});

// Explore (spec 9.1): the two heavy dependencies are walled into src/chat/explore/, and the pure modules there stay importable by vitest.
describe('Explore dependency walls, real tree', () => {
  const all = loadDirs(process.cwd(), ['src', 'app', 'components', 'lib']);
  const importsOf = (pkg: string) =>
    Object.keys(all)
      .filter((f) => !/\.(test|spec)\./.test(f))
      .filter((f) => new RegExp(`(from\\s+|import\\s*\\(\\s*|import\\s+)['"]${pkg}['"]`).test(all[f]))
      .sort();

  it('only src/chat/explore/parse.ts imports libpg-query', () => {
    expect(importsOf('libpg-query')).toEqual(['src/chat/explore/parse.ts']);
  });

  it('only src/chat/explore/client.ts imports the postgres driver', () => {
    expect(importsOf('postgres')).toEqual(['src/chat/explore/client.ts']);
  });

  it('src/chat/explore/ has no server-only import except client.ts (the pure modules stay importable by vitest)', () => {
    const withServerOnly = Object.keys(all).filter((f) => f.startsWith('src/chat/explore/') && /import\s+['"]server-only['"]/.test(all[f]));
    expect(withServerOnly).toEqual(['src/chat/explore/client.ts']);
  });

  it('client.ts is reached only through src/chat/explore-setup.ts', () => {
    expect(importersOf('src/chat/explore/client.ts', all).filter((f) => !f.startsWith('test/'))).toEqual(['src/chat/explore-setup.ts']);
  });

  it('the pinned .update( exception covers exactly the two files and one method each; the same call elsewhere is still flagged', () => {
    expect(WRITE_CALL_EXCEPTIONS.map((e) => `${e.file}:${e.method}`)).toEqual(['src/chat/read/mint-jwt.ts:update', 'src/chat/explore/fingerprint.ts:update']);
    const planted: FileMap = {'src/chat/explore/other.ts': 'export const h = (c: {update(s: string): void}) => c.update("x");', 'src/chat/explore/fingerprint.ts': 'const d = c.update("x"); const e = db.delete("y");'};
    expect(writeCallsIn(planted)).toEqual(['src/chat/explore/other.ts: .update(', 'src/chat/explore/fingerprint.ts: .delete(']);
  });
});
