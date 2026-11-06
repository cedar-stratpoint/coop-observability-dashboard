import {createHmac} from 'node:crypto';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {createClient} from '@supabase/supabase-js';
import {assertLocalSupabase} from './support/local-only';
// @ts-expect-error plain .mjs
import {loadTargets} from '../scripts/seed-plan-from-workbook.mjs';

// LOCAL INTEGRATION (skipped unless pointed at the throwaway local stack): BHR-06 review M3. The page reads the NEWEST plan version, so the loader also
// adds every row target that version is missing (a target-edit version made before the sheet rows existed), never overwriting a value, dry run by default.
//   npm run test:plan-local
// Synthetic numbers, own labels and months (2032), removed afterwards.
const URL_ = process.env.SB_LOCAL_URL;
const SECRET = process.env.SB_LOCAL_JWT_SECRET;
if (URL_) assertLocalSupabase(URL_);
const local = !!URL_ && !!SECRET;
const BASE = 'loader-probe-base', LATEST = 'loader-probe-latest', MO = '2032-01-01';

function jwt(role: string): string {
  const b = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const body = `${b({alg: 'HS256', typ: 'JWT'})}.${b({role, iss: 'supabase', iat: now, exp: now + 300})}`;
  return `${body}.${createHmac('sha256', SECRET!).update(body).digest('base64url')}`;
}
const sb = () => createClient(URL_!, jwt('service_role'), {auth: {persistSession: false}});
const versionId = async (label: string) => ((await sb().from('plan_versions').select('id').eq('label', label)).data?.[0]?.id ?? null) as number | null;
const targets = async (label: string) => {
  const id = await versionId(label);
  const rows = id === null ? [] : (await sb().from('plan_targets').select('metric,value').eq('plan_version', id).eq('month', MO)).data ?? [];
  return Object.fromEntries(rows.map((r) => [r.metric, Number(r.value)]));
};
const cleanup = async () => {
  for (const label of [LATEST, BASE]) {
    const id = await versionId(label);
    if (id === null) continue;
    await sb().from('plan_targets').delete().eq('plan_version', id);
    await sb().from('plan_versions').delete().eq('id', id);
  }
};
const ROWS = [{month: MO, metric: 'r33', value: 1, note: null}, {month: MO, metric: 'r34', value: 2, note: null}, {month: MO, metric: 'r35', value: 3, note: null}];
const quiet = {log: () => {}};

describe.skipIf(!local)('M3: the loader fills the newest plan version too, never overwriting', () => {
  beforeAll(cleanup);
  afterAll(cleanup);
  it('creates its own version and loads it; when it is the newest there is nothing more to add', async () => {
    const r = await loadTargets(sb(), ROWS, {label: BASE, reason: 'probe', apply: true, ...quiet});
    expect(await targets(BASE)).toEqual({r33: 1, r34: 2, r35: 3});
    expect(r).toMatchObject({base: {added: 3}, latest: null});
  });
  it('a newer version missing rows gets them, its own values kept; a dry run counts and writes nothing', async () => {
    const ins = await sb().from('plan_versions').insert({label: LATEST, reason: 'probe edit', created_by: 'probe'}).select('id').single();
    await sb().from('plan_targets').insert({plan_version: ins.data!.id, month: MO, metric: 'r33', value: 99});
    const dry = await loadTargets(sb(), ROWS, {label: BASE, reason: 'probe', apply: false, ...quiet});
    expect(dry).toMatchObject({base: {missing: 0}, latest: {label: LATEST, missing: 2, added: 0}});
    expect(await targets(LATEST)).toEqual({r33: 99});
    const wet = await loadTargets(sb(), ROWS, {label: BASE, reason: 'probe', apply: true, ...quiet});
    expect(wet).toMatchObject({base: {added: 0}, latest: {label: LATEST, missing: 2, added: 2}});
    expect(await targets(LATEST)).toEqual({r33: 99, r34: 2, r35: 3}); // the edited value stays
    expect(await targets(BASE)).toEqual({r33: 1, r34: 2, r35: 3});
    const again = await loadTargets(sb(), ROWS, {label: BASE, reason: 'probe', apply: true, ...quiet});
    expect(again).toMatchObject({base: {added: 0}, latest: {missing: 0, added: 0}}); // idempotent
  });
});
