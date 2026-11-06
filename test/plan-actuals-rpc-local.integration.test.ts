import {createHmac} from 'node:crypto';
import {afterAll, beforeEach, describe, expect, it} from 'vitest';
import {createClient} from '@supabase/supabase-js';
import {assertLocalSupabase} from './support/local-only';
import {LINES} from '../src/plan-compute';

// LOCAL INTEGRATION (skipped unless pointed at the throwaway local stack from scripts/local-supabase/up.sh):
//   set -a; source scripts/local-supabase/.local-env; set +a; npx vitest run test/plan-actuals-rpc-local.integration.test.ts
// Months in 2031 are this file's own, so it cannot disturb the seeded plan or another test file running beside it.
const URL_ = process.env.SB_LOCAL_URL;
const SECRET = process.env.SB_LOCAL_JWT_SECRET;
if (URL_) assertLocalSupabase(URL_);
const local = !!URL_ && !!SECRET;
const M = '2031-03-01';

function jwt(role: string): string {
  const b = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const body = `${b({alg: 'HS256', typ: 'JWT'})}.${b({role, iss: 'supabase', iat: now, exp: now + 300})}`;
  return `${body}.${createHmac('sha256', SECRET!).update(body).digest('base64url')}`;
}
const as = (role: string) => createClient(URL_!, jwt(role), {auth: {persistSession: false}});
const sb = () => as('service_role');
const set = (metric: string, amount: number | null, expected: number | null, by: string | null = 'admin@x.com', month = M) =>
  sb().rpc('plan_set_actual', {p_month: month, p_metric: metric, p_amount: amount, p_expected: expected, p_by: by});
const cell = async (metric: string, month = M) => Number((await sb().from('plan_actuals').select('amount_php').eq('month', month).eq('metric', metric).maybeSingle()).data?.amount_php ?? NaN);
const logs = async (month = M) => (await sb().from('plan_actuals_log').select('*').eq('month', month).order('id')).data ?? [];

describe.skipIf(!local)('plan_set_actual on the local stack', () => {
  const wipe = async () => { await sb().from('plan_actuals').delete().eq('month', M); await sb().from('plan_actuals_log').delete().eq('month', M); };
  beforeEach(wipe);
  afterAll(wipe);

  it('saves each of the 21 typed lines, and a typed 0 is stored as a real 0', async () => {
    for (const l of LINES) expect((await set(l.id, 0, null)).error, l.id).toBeNull();
    const rows = (await sb().from('plan_actuals').select('metric,amount_php').eq('month', M)).data ?? [];
    expect(rows).toHaveLength(21);
    expect(rows.every((r) => Number(r.amount_php) === 0)).toBe(true);
  });

  it('BHR-06: a total (overhead, COGS, content and other) is never typed: the RPC rejects it; its sheet rows are typed instead', async () => {
    for (const parent of ['overhead', 'cogs', 'content_other']) expect((await set(parent, 1, null)).error?.message, parent).toBe('invalid_line');
    expect(((await sb().from('plan_actuals').select('metric').eq('month', M)).data ?? []).length).toBe(0);
  });

  it('writes who and when, and one log row with the old and new value in the same call', async () => {
    await set('marketplace_cogs', 1500, null, 'a@x.com');
    await set('marketplace_cogs', 2500, 1500, 'b@x.com');
    const row = (await sb().from('plan_actuals').select('updated_by,updated_at').eq('month', M).eq('metric', 'marketplace_cogs').single()).data;
    expect(row?.updated_by).toBe('b@x.com');
    expect(row?.updated_at).toBeTruthy();
    const l = await logs();
    expect(l.map((r) => [r.actor, Number(r.old_value ?? NaN), Number(r.new_value), r.action])).toEqual([['a@x.com', NaN, 1500, 'edit'], ['b@x.com', 1500, 2500, 'edit']]);
  });

  it('compare-and-set: a stale expected value is rejected, nothing is written and nothing is logged', async () => {
    await set('marketplace_cogs', 100, null);
    const stale = await set('marketplace_cogs', 999, 50); // the caller last saw 50, someone saved 100
    expect(stale.error?.message).toBe('stale_value');
    expect(await cell('marketplace_cogs')).toBe(100);
    expect(await logs()).toHaveLength(1);
    const empty = await set('fulfilment', 5, 7); // expected a value where the cell is empty
    expect(empty.error?.message).toBe('stale_value');
    expect(Number.isNaN(await cell('fulfilment'))).toBe(true);
  });

  it('two admins saving the same cell at once: exactly one wins, the other is stale, and every log old value is the true previous one', async () => {
    await set('marketplace_cogs', 100, null);
    const res = await Promise.all([set('marketplace_cogs', 111, 100, 'a@x.com'), set('marketplace_cogs', 222, 100, 'b@x.com')]);
    expect(res.filter((r) => !r.error)).toHaveLength(1);
    expect(res.filter((r) => r.error?.message === 'stale_value')).toHaveLength(1);
    const l = await logs();
    expect(l).toHaveLength(2);
    expect(Number(l[1].old_value)).toBe(100);
    expect(Number(l[1].new_value)).toBe(await cell('marketplace_cogs'));
  });

  it('many concurrent first writes to an empty cell: one wins, none corrupts the log', async () => {
    const res = await Promise.all([1, 2, 3, 4, 5].map((n) => set('salaries', n * 10, null, `u${n}@x.com`)));
    expect(res.filter((r) => !r.error)).toHaveLength(1);
    expect(await logs()).toHaveLength(1);
  });

  it('negative amounts are rejected, the derived rows (cash, cac, customers, coverage) are refused, an unknown line and a bad month are rejected', async () => {
    expect((await set('marketplace_cogs', -1, null)).error?.message).toBe('negative_cost');
    for (const derived of ['cash', 'cac', 'customers', 'coverage']) {
      expect((await set(derived, 1, null)).error?.message, derived).toBe('invalid_line');
      expect(await cell(derived), derived).toBeNaN();
    }
    expect((await set('revenue', 1, null)).error?.message).toBe('invalid_line');
    expect((await set('marketplace_cogs', 1, null, 'a@x.com', '2031-03-15')).error?.message).toBe('invalid_month');
    expect(await cell('marketplace_cogs')).toBeNaN();
  });

  it('clearing a cell makes it missing again and is logged; clearing an empty cell is a no-op', async () => {
    await set('marketplace_cogs', 5, null);
    expect((await set('marketplace_cogs', null, 5)).error).toBeNull();
    expect(await cell('marketplace_cogs')).toBeNaN();
    expect((await logs()).map((r) => r.action)).toEqual(['edit', 'clear']);
    expect((await set('marketplace_cogs', null, null)).error).toBeNull();
    expect(await logs()).toHaveLength(2);
  });

  it('a failed log write fails the change: no actor, no value saved', async () => {
    const r = await set('marketplace_cogs', 42, null, null);
    expect(r.error).not.toBeNull();
    expect(await cell('marketplace_cogs')).toBeNaN();
    expect(await logs()).toHaveLength(0);
  });

  it('a closed month rejects the write', async () => {
    const v = (await sb().from('plan_versions').select('id').limit(1)).data![0].id;
    await sb().from('plan_month_closes').insert({month: M, plan_version: v, closed_by: 'x@x.com'});
    try {
      expect((await set('marketplace_cogs', 1, null)).error?.message).toBe('month_closed');
    } finally {
      await sb().from('plan_month_closes').delete().eq('month', M);
    }
  });

  it('ROAS (the optional measure): saved exactly, logged, compare-and-set, never negative, and a closed month rejects it', async () => {
    expect((await set('roas', 3.2, null, 'a@x.com')).error).toBeNull();
    expect(await cell('roas')).toBe(3.2);
    expect((await set('roas', -0.01, 3.2)).error?.message).toBe('negative_cost');
    expect((await set('roas', 9, 4.2)).error?.message).toBe('stale_value');
    expect(await cell('roas')).toBe(3.2);
    expect((await logs()).filter((r) => r.action === 'edit')).toHaveLength(1);
    expect((await set('roas', 0, 3.2)).error).toBeNull(); // a typed 0 is a real 0
    expect(await cell('roas')).toBe(0);
    expect((await set('roas', null, 0)).error).toBeNull(); // clearing makes it missing again
    expect(await cell('roas')).toBeNaN();
    const v = (await sb().from('plan_versions').select('id').limit(1)).data![0].id;
    await sb().from('plan_month_closes').insert({month: M, plan_version: v, closed_by: 'x@x.com'});
    try {
      expect((await set('roas', 1, null)).error?.message).toBe('month_closed');
    } finally {
      await sb().from('plan_month_closes').delete().eq('month', M);
    }
  });

  it('the workbook cash-flow rows (funding, settlement, freight, stock bought): saved in pesos, logged, compare-and-set, never negative, required for Close like the other inputs, locked by a close', async () => {
    const ids = ['bridge_funding', 'liability_settlement', 'freight_onetime', 'inv_purchases_paid'] as const;
    for (const m of ids) {
      expect((await set(m, 1500000, null, 'a@x.com')).error, m).toBeNull();
      expect(await cell(m), m).toBe(1500000);
      expect((await set(m, -1, 1500000)).error?.message, m).toBe('negative_cost');
      expect((await set(m, 9, 1)).error?.message, m).toBe('stale_value');
    }
    expect((await logs()).filter((r) => r.action === 'edit')).toHaveLength(4);
    // Close needs all 21 typed lines (these four included); the close RPC itself is covered by plan-close-rpc-local. A closed month locks them.
    for (const l of LINES) if (!ids.includes(l.id as (typeof ids)[number])) await set(l.id, 0, null);

    const v = (await sb().from('plan_versions').select('id').limit(1)).data![0].id;
    expect((await sb().from('plan_month_closes').insert({month: M, plan_version: v, closed_by: 'a@x.com'})).error).toBeNull(); // M is a 2031 month: the close RPC would refuse it (not over yet), so the row is inserted
    try {
      expect((await set('bridge_funding', 1, 1500000)).error?.message).toBe('month_closed');
    } finally {
      await sb().from('plan_month_closes').delete().eq('month', M);
    }
    expect(v).toBeTruthy();
    expect((await set('bridge_funding', null, 1500000)).error).toBeNull();
    expect(await cell('bridge_funding')).toBeNaN();
    expect((await set('bogus_line', 1, null)).error?.message).toBe('invalid_line');
  });

  it.each(['anon', 'authenticated'])('%s cannot call the RPC', async (role) => {
    const r = await as(role).rpc('plan_set_actual', {p_month: M, p_metric: 'marketplace_cogs', p_amount: 1, p_expected: null, p_by: 'evil@x.com'});
    expect(r.error).not.toBeNull();
    expect(await cell('marketplace_cogs')).toBeNaN();
    expect((await as(role).rpc('plan_set_actual', {p_month: M, p_metric: 'roas', p_amount: 1, p_expected: null, p_by: 'evil@x.com'})).error).not.toBeNull();
    expect(await cell('roas')).toBeNaN();
  });

  describe('opening cash', () => {
    let first = '';
    const wipeFirst = async () => { await sb().from('plan_actuals').delete().eq('month', first).eq('metric', 'opening_cash'); await sb().from('plan_actuals_log').delete().eq('month', first).eq('metric', 'opening_cash'); };
    beforeEach(async () => { first = ((await sb().from('plan_targets').select('month').order('month').limit(1)).data ?? [])[0]?.month; await wipeFirst(); });
    afterAll(async () => { if (first) await wipeFirst(); });

    it('is saved for the first plan month only, can be negative, is compare-and-set and logged', async () => {
      expect((await set('opening_cash', -260000, null, 'a@x.com', first)).error).toBeNull();
      expect(await cell('opening_cash', first)).toBe(-260000);
      expect((await set('opening_cash', 1, null, 'a@x.com', first)).error?.message).toBe('stale_value');
      expect((await set('opening_cash', 100000, -260000, 'b@x.com', first)).error).toBeNull();
      expect((await logs(first)).filter((l) => l.metric === 'opening_cash').map((l) => [Number(l.new_value), l.actor])).toEqual([[-260000, 'a@x.com'], [100000, 'b@x.com']]);
    });
    it('is rejected for any other month, and every other line still cannot be negative', async () => {
      expect((await set('opening_cash', 5, null)).error?.message).toBe('invalid_line');
      expect((await set('marketplace_cogs', -1, null)).error?.message).toBe('negative_cost');
      expect((await set('salaries', -1, null, 'a@x.com', first)).error?.message).toBe('negative_cost');
    });
  });
});
