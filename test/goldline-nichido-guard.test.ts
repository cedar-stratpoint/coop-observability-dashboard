import {readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';

// Goldline's gl_* tables and goldline-uploads bucket live in the Nichido project. Any
// module that touches them must go through src/nichido-client.ts; one that built its
// own client from the archive env would quietly read and write the old copy there.

const ROOT = join(__dirname, '..');
const SCAN = ['src', 'app', 'components'];
const GL_ACCESS = /\.from\(\s*['"`]gl_|\.rpc\(\s*['"`]gl_|GOLDLINE_BUCKET|goldline-uploads/;

function files(dir: string): string[] {
  return readdirSync(join(ROOT, dir), {withFileTypes: true}).flatMap((e) => {
    const rel = join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : files(rel);
    return /\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [rel] : [];
  });
}

describe('Goldline data goes through the Nichido client', () => {
  const all = SCAN.flatMap(files).map((f) => ({f, src: readFileSync(join(ROOT, f), 'utf8')}));
  const goldline = all.filter(({f, src}) => f !== join('src', 'nichido-client.ts') && GL_ACCESS.test(src));

  it('finds the Goldline data modules', () => {
    expect(goldline.length).toBeGreaterThanOrEqual(5);
  });

  it('no Goldline module reads the archive env or builds its own client', () => {
    const bad = goldline.filter(({src}) => /SUPABASE_(URL|SERVICE_ROLE_KEY)_ARCHIVE|createClient\(/.test(src)).map(({f}) => f);
    expect(bad).toEqual([]);
  });

  it('every module that queries gl_* imports the Nichido client', () => {
    const queries = goldline.filter(({src}) => /\.(from|rpc)\(\s*['"`]gl_|\.storage\b/.test(src));
    const missing = queries.filter(({src}) => !src.includes("from './nichido-client'")).map(({f}) => f);
    expect(missing).toEqual([]);
  });
});
