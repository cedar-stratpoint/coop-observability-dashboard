import {createHmac} from 'node:crypto';
import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {createClient} from '@supabase/supabase-js';
import {assertLocalSupabase} from './support/local-only';

// LOCAL INTEGRATION (skipped unless pointed at the throwaway local stack): the one-time workbook prefill RPC plan_seed_actual.
//   npm run test:plan-local
// Own months in 2032 so it cannot disturb the seeded plan; the opening balances (first plan month only) are restored afterwards.
const URL_ = process.env.SB_LOCAL_URL;
const SECRET = process.env.SB_LOCAL_JWT_SECRET;
if (URL_) assertLocalSupabase(URL_);
const local = !!URL_ && !!SECRET;
const M = '2032-09-01';

function jwt(role: string): string {
  const b = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const body = `${b({alg: 'HS256', typ: 'JWT'})}.${b({role, iss: 'supabase', iat: now, exp: now + 300})}`;
  return `${body}.${createHmac('sha256', SECRET!).update(body).digest('base64url')}`;
}
const as = (role: string) => createClient(URL_!, jwt(role), {auth: {persistSession: false}});
const sb = () => as('service_role');
const seed = (metric: string, amount: number, source: string, month = M) => sb().rpc('plan_seed_actual', {p_month: month, p_metric: metric, p_amount: amount, p_source: source, p_by: 'seed'});
const row = async (metric: string, month = M) => (await sb().from('plan_actuals').select('amount_php,source,updated_by').eq('month', month).eq('metric', metric).maybeSingle()).data;
const logs = async (month = M) => (await sb().from('plan_actuals_log').select('*').eq('month', month).order('id')).data ?? [];

describe.skipIf(!local)('plan_seed_actual on the local stack', () => {
  const wipe = async () => {
    await sb().from('plan_month_closes').delete().eq('month', M);
    await sb().from('plan_actuals').delete().eq('month', M);
    await sb().from('plan_actuals_log').delete().eq('month', M);
  };
  beforeEach(wipe);
  afterAll(wipe);

  it('writes the value with its source tag and one seed log row', async () => {
    const r = await seed('bridge_funding', 1_500_000, 'owner');
    expect(r.error).toBeNull();
    expect(r.data).toMatchObject({seeded: true});
    expect(Number((await row('bridge_funding'))?.amount_php)).toBe(1_500_000);
    expect((await row('bridge_funding'))?.source).toBe('owner');
    expect((await logs()).map((l) => [l.action, l.metric, Number(l.new_value), l.actor])).toEqual([['seed', 'bridge_funding', 1_500_000, 'seed']]);
  });

  it('is idempotent: a second run changes nothing and logs nothing', async () => {
    await seed('bridge_funding', 1_500_000, 'owner');
    const again = await seed('bridge_funding', 1_500_000, 'owner');
    expect(again.data).toMatchObject({seeded: false});
    expect(await logs()).toHaveLength(1);
  });

  it('never overwrites a value an admin already typed, and never tags it', async () => {
    expect((await sb().rpc('plan_set_actual', {p_month: M, p_metric: 'bridge_funding', p_amount: 1_500_000, p_expected: null, p_by: 'a@x.com'})).error).toBeNull();
    const r = await seed('bridge_funding', 1_500_000, 'owner');
    expect(r.data).toMatchObject({seeded: false});
    expect(Number((await row('bridge_funding'))?.amount_php)).toBe(1_500_000);
    expect((await row('bridge_funding'))?.source).toBeNull();
  });

  it('an admin edit of a seeded cell drops the tag; clearing it is not undone by a re-run', async () => {
    await seed('bridge_funding', 1_500_000, 'owner');
    expect((await sb().rpc('plan_set_actual', {p_month: M, p_metric: 'bridge_funding', p_amount: 1_000_000, p_expected: 1_500_000, p_by: 'a@x.com'})).error).toBeNull();
    expect((await row('bridge_funding'))?.source).toBeNull();
    expect((await sb().rpc('plan_set_actual', {p_month: M, p_metric: 'bridge_funding', p_amount: null, p_expected: 1_000_000, p_by: 'a@x.com'})).error).toBeNull();
    expect((await seed('bridge_funding', 1_500_000, 'owner')).data).toMatchObject({seeded: false});
    expect(await row('bridge_funding')).toBeNull();
  });

  it('skips a closed month', async () => {
    const v = (await sb().from('plan_versions').select('id').order('id', {ascending: false}).limit(1)).data?.[0]?.id;
    expect((await sb().from('plan_month_closes').insert({month: M, plan_version: v, closed_by: 'a@x.com', gmv_snapshot: {}})).error).toBeNull();
    const r = await seed('bridge_funding', 1_500_000, 'owner');
    expect(r.data).toMatchObject({seeded: false});
    expect(await row('bridge_funding')).toBeNull();
  });

  it('only accepts the three prefill metrics and the two sources; opening balances only on the first plan month; no negatives', async () => {
    expect((await seed('cogs', 1, 'owner')).error?.message).toBe('invalid_line');
    expect((await seed('opening_cash', 1, 'owner')).error?.message).toBe('invalid_line');
    expect((await seed('bridge_funding', 1, 'guess')).error?.message).toBe('invalid_source');
    expect((await seed('bridge_funding', -1, 'owner')).error?.message).toBe('negative_cost');
    expect((await seed('opening_inventory', 410_000, 'workbook')).error?.message).toBe('invalid_line'); // M is not the first plan month
  });

  it.each(['anon', 'authenticated'])('%s (a non-admin) cannot call the seed RPC and nothing is written', async (role) => {
    const r = await as(role).rpc('plan_seed_actual', {p_month: M, p_metric: 'bridge_funding', p_amount: 5, p_source: 'owner', p_by: 'evil@x.com'});
    expect(r.error).not.toBeNull();
    expect(await row('bridge_funding')).toBeNull();
    expect((await as(role).from('plan_actuals').select('*')).data ?? []).toEqual([]);
  });

  describe('opening balances (first plan month)', () => {
    let first = '';
    const wipeFirst = async () => { for (const m of ['opening_inventory', 'opening_customers']) { await sb().from('plan_actuals').delete().eq('month', first).eq('metric', m); await sb().from('plan_actuals_log').delete().eq('month', first).eq('metric', m); } };
    // The local stack may carry the loaded prefill on these two cells: remember it and put it back, so this file leaves the seeded state as it found it.
    let keptRows: Record<string, unknown>[] = [], keptLogs: Record<string, unknown>[] = [];
    beforeAll(async () => {
      first = ((await sb().from('plan_targets').select('month').order('month').limit(1)).data ?? [])[0]?.month;
      const ids = ['opening_inventory', 'opening_customers'];
      keptRows = (await sb().from('plan_actuals').select('*').eq('month', first).in('metric', ids)).data ?? [];
      keptLogs = ((await sb().from('plan_actuals_log').select('*').eq('month', first).in('metric', ids)).data ?? []).map(({id: _id, ...rest}) => rest);
    });
    beforeEach(async () => { await wipeFirst(); });
    afterAll(async () => {
      if (!first) return;
      await wipeFirst();
      if (keptRows.length) await sb().from('plan_actuals').insert(keptRows);
      if (keptLogs.length) await sb().from('plan_actuals_log').insert(keptLogs);
    });

    it('are seeded tagged "workbook", editable by an admin (tag drops), and rejected for other months', async () => {
      expect((await seed('opening_inventory', 410_000, 'workbook', first)).data).toMatchObject({seeded: true});
      expect((await seed('opening_customers', 420, 'workbook', first)).data).toMatchObject({seeded: true});
      expect((await row('opening_inventory', first))?.source).toBe('workbook');
      expect((await sb().rpc('plan_set_actual', {p_month: first, p_metric: 'opening_inventory', p_amount: 430_000, p_expected: 410_000, p_by: 'a@x.com'})).error).toBeNull();
      expect(Number((await row('opening_inventory', first))?.amount_php)).toBe(430_000);
      expect((await row('opening_inventory', first))?.source).toBeNull();
      expect((await sb().rpc('plan_set_actual', {p_month: M, p_metric: 'opening_customers', p_amount: 5, p_expected: null, p_by: 'a@x.com'})).error?.message).toBe('invalid_line');
      expect((await sb().rpc('plan_set_actual', {p_month: first, p_metric: 'opening_customers', p_amount: -5, p_expected: 420, p_by: 'a@x.com'})).error?.message).toBe('negative_cost');
    });
  });
});
