import {existsSync, readFileSync, readdirSync, statSync} from 'node:fs';
import {join, relative} from 'node:path';
import {describe, expect, it} from 'vitest';

// The Mac and enrolment surface is gone: there is exactly one worker, the cloud box, with one shared secret.
const root = join(__dirname, '..');
const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)]));

describe('no Settings screen and no enrolment', () => {
  it('has no Settings route, enrol route, Macs component or tokens module', () => {
    for (const p of ['app/settings/shopee-sync', 'app/api/shopee/sync/enrol', 'components/analyst/shopee-sync-macs.tsx', 'src/shopee-sync/tokens.ts']) expect(existsSync(join(root, p)), p).toBe(false);
  });
  it('the worker routes are exactly claim, progress, status and wake', () => {
    expect(readdirSync(join(root, 'app/api/shopee/sync')).sort()).toEqual(['claim', 'progress', 'status', 'wake']);
  });
  it('nothing links to the removed screen or mentions enrolment, a Mac or is_cloud in the app code', () => {
    const files = ['app', 'components', 'src'].flatMap((d) => walk(join(root, d))).filter((f) => /\.(ts|tsx)$/.test(f) && /shopee-sync|settings/.test(relative(root, f)));
    expect(files.length).toBeGreaterThan(5);
    for (const f of files) expect(readFileSync(f, 'utf8'), f).not.toMatch(/settings\/shopee-sync|enrol|redeem|is_cloud|isCloud|\bMacs?\b/i);
  });
  it('the SQL has no enrolment table, redeem function or is_cloud flag, and no policies', () => {
    const sql = readdirSync(join(root, 'supabase')).filter((f) => /^shopee_sync/.test(f)).map((f) => readFileSync(join(root, 'supabase', f), 'utf8')).join('\n');
    expect(sql).toMatch(/shopee_sync_jobs/);
    expect(sql).not.toMatch(/enrolment|redeem|is_cloud|token_hash|claimed_by/i);
    expect(sql).not.toMatch(/create policy/i);
  });
});
