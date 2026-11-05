import {createHmac} from 'node:crypto';
import {afterAll, beforeEach, describe, expect, it} from 'vitest';
import {createClient} from '@supabase/supabase-js';
import {assertLocalSupabase} from './support/local-only';

// LOCAL INTEGRATION (skipped unless pointed at the throwaway local stack from scripts/local-supabase/up.sh):
//   set -a; source scripts/local-supabase/.local-env; set +a; npx vitest run test/plan-targets-rpc-local.integration.test.ts
// RUN THE PLAN INTEGRATION FILES ONE AT A TIME (npm run test:plan-local): they share one global fact, the newest plan version (this file creates
// versions, plan-close-rpc-local expects a close to record the newest one), so parallel files can interleave.
// Creates short-lived plan versions and removes them afterwards, so the seeded plan is left as it was.
const URL_ = process.env.SB_LOCAL_URL;
const SECRET = process.env.SB_LOCAL_JWT_SECRET;
if (URL_) assertLocalSupabase(URL_);
const local = !!URL_ && !!SECRET;
const FUT = '2027-03-01'; // a future month in the seeded plan
const FUT2 = '2027-04-01';
const PAST = '2026-09-01'; // before the current month

function jwt(role: string): string {
  const b = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const body = `${b({alg: 'HS256', typ: 'JWT'})}.${b({role, iss: 'supabase', iat: now, exp: now + 300})}`;
  return `${body}.${createHmac('sha256', SECRET!).update(body).digest('base64url')}`;
}
const as = (role: string) => createClient(URL_!, jwt(role), {auth: {persistSession: false}});
const sb = () => as('service_role');
const newest = async () => (await sb().from('plan_versions').select('*').order('id', {ascending: false}).limit(1)).data![0];
const targets = async (v: number) => (await sb().from('plan_targets').select('month,metric,value').eq('plan_version', v).limit(5000)).data ?? [];
const edit = async (changes: unknown, reason: string | null = 'new Lazada pricing', by: string | null = 'a@x.com', expected?: number) =>
  sb().rpc('plan_edit_targets', {p_changes: changes, p_reason: reason, p_by: by, p_expected_version: expected ?? (await newest()).id});
// The base plan is the OLDEST version: the loaded workbook plan, or the synthetic one (scripts/local-supabase/seed-plan-synthetic.sql) on a clean stack.
const SEED_ID = async () => (await sb().from('plan_versions').select('id').order('id', {ascending: true}).limit(1)).data![0].id as number;
const cleanup = async () => {
  await sb().from('plan_month_closes').delete().like('closed_by', 'probe-%');
  const seed = await SEED_ID();
  const extra = (await sb().from('plan_versions').select('id').gt('id', seed).not('label', 'like', 'close-probe-%')).data ?? [];
  for (const v of extra) { await sb().from('plan_targets').delete().eq('plan_version', v.id); await sb().from('plan_versions').delete().eq('id', v.id); }
};

describe.skipIf(!local)('plan_edit_targets on the local stack', () => {
  beforeEach(cleanup);
  afterAll(cleanup);

  it('a future-month edit with a reason makes a new version (who, when, reason), copies every other target and keeps the old version', async () => {
    const old = await newest();
    const oldRows = await targets(old.id);
    const r = await edit([{month: FUT, metric: 'gmv_marketplace', value: 123456}], '  Lazada fees went up  ', 'boss@x.com');
    expect(r.error).toBeNull();
    const nv = await newest();
    expect(nv.id).toBeGreaterThan(old.id);
    expect(nv).toMatchObject({reason: 'Lazada fees went up', created_by: 'boss@x.com'});
    expect(nv.created_at).toBeTruthy();
    expect(await targets(old.id)).toEqual(oldRows); // the old version is untouched
    const rows = await targets(nv.id);
    expect(rows).toHaveLength(oldRows.length);
    const val = (set: typeof rows, m: string, k: string) => Number(set.find((x) => x.month === m && x.metric === k)!.value);
    expect(val(rows, FUT, 'gmv_marketplace')).toBe(123456);
    expect(val(rows, FUT, 'gmv_events')).toBe(val(oldRows, FUT, 'gmv_events')); // copied
    expect(val(rows, FUT2, 'gmv_marketplace')).toBe(val(oldRows, FUT2, 'gmv_marketplace'));
    expect(val(rows, FUT, 'gmv_total')).toBe(val(rows, FUT, 'gmv_events') + val(rows, FUT, 'gmv_website') + val(rows, FUT, 'gmv_marketplace')); // re-summed
  });

  it('rejects a missing or blank reason and writes nothing', async () => {
    const before = (await newest()).id;
    for (const reason of [null, '', '   ']) expect((await edit([{month: FUT, metric: 'gmv_events', value: 1}], reason)).error?.message).toBe('reason_required');
    expect((await newest()).id).toBe(before);
  });

  it('rejects a closed month, whole batch included', async () => {
    const seed = await SEED_ID();
    await sb().from('plan_month_closes').insert({month: FUT2, plan_version: seed, closed_by: 'probe-closer'});
    const before = (await newest()).id;
    const r = await edit([{month: FUT, metric: 'gmv_events', value: 1}, {month: FUT2, metric: 'gmv_events', value: 2}]);
    expect(r.error?.message).toBe('month_closed');
    expect((await newest()).id).toBe(before);
  });

  it('a closed month stays judged against the version recorded at close, whatever later versions say', async () => {
    const seed = await SEED_ID();
    await sb().from('plan_month_closes').insert({month: FUT2, plan_version: seed, closed_by: 'probe-closer'});
    expect((await edit([{month: FUT, metric: 'gmv_events', value: 9}])).error).toBeNull();
    const close = (await sb().from('plan_month_closes').select('plan_version').eq('month', FUT2).single()).data!;
    expect(close.plan_version).toBe(seed);
    const keep = await targets(seed);
    expect(keep.find((x) => x.month === FUT && x.metric === 'gmv_events')!.value).not.toBe(9); // the version it closed under still has the old number
  });

  it('rejects a past month, an unknown cell, Total GMV, a stale version, a bad month, a non-number and an empty list', async () => {
    const before = (await newest()).id;
    expect((await edit([{month: PAST, metric: 'gmv_events', value: 1}])).error?.message).toBe('past_month');
    expect((await edit([{month: FUT, metric: 'nope', value: 1}])).error?.message).toBe('unknown_target');
    expect((await edit([{month: FUT, metric: 'gmv_total', value: 1}])).error?.message).toBe('calculated_target');
    for (const derived of ['cm1', 'cm1_pct', 'ebitda', 'cash', 'coverage', 'cac', 'customers']) expect((await edit([{month: FUT, metric: derived, value: 1}])).error?.message, derived).toBe('derived_target');
    expect((await edit([{month: FUT, metric: 'gmv_events', value: 1}], 'why', 'a@x.com', before - 1)).error?.message).toBe('stale_version');
    expect((await edit([{month: '2027-03-15', metric: 'gmv_events', value: 1}])).error?.message).toBe('invalid_month');
    expect((await edit([{month: FUT, metric: 'gmv_events', value: 'x'}])).error?.message).toBe('invalid_change');
    expect((await edit([])).error?.message).toBe('no_changes');
    expect((await newest()).id).toBe(before);
  });

  it('two editors racing from the same version: one wins, the other gets stale_version, exactly one new version', async () => {
    const before = (await newest()).id;
    const rs = await Promise.all([edit([{month: FUT, metric: 'gmv_events', value: 1}], 'a', 'a@x.com', before), edit([{month: FUT, metric: 'gmv_events', value: 2}], 'b', 'b@x.com', before)]);
    expect(rs.filter((r) => !r.error)).toHaveLength(1);
    expect(rs.filter((r) => r.error)[0].error?.message).toBe('stale_version');
    expect((await sb().from('plan_versions').select('id').gt('id', before)).data).toHaveLength(1);
  });

  it('a version a closed month points at cannot be deleted (restrict), and anon / authenticated cannot call the RPC', async () => {
    const seed = await SEED_ID();
    await sb().from('plan_month_closes').insert({month: FUT2, plan_version: seed, closed_by: 'probe-closer'});
    expect((await sb().from('plan_versions').delete().eq('id', seed)).error).not.toBeNull();
    for (const role of ['anon', 'authenticated']) {
      const r = await as(role).rpc('plan_edit_targets', {p_changes: [{month: FUT, metric: 'gmv_events', value: 1}], p_reason: 'x', p_by: 'x', p_expected_version: seed});
      expect(r.error, role).not.toBeNull();
    }
  });
});

describe.skipIf(!local)('plan_dated_entries is gone (BHR-05 follows the workbook: one monthly cash-flow row each, no free-form ledger)', () => {
  it('the table no longer exists on the local stack', async () => {
    const r = await sb().from('plan_dated_entries').select('*').limit(1);
    expect(r.error).not.toBeNull();
  });
});
