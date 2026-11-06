import {createHmac} from 'node:crypto';
import {afterAll, beforeEach, describe, expect, it} from 'vitest';
import {createClient} from '@supabase/supabase-js';
import {assertLocalSupabase} from './support/local-only';
import {LINES} from '../src/plan-compute';

// LOCAL INTEGRATION (skipped unless pointed at the throwaway local stack from scripts/local-supabase/up.sh):
//   set -a; source scripts/local-supabase/.local-env; set +a; npx vitest run test/plan-close-rpc-local.integration.test.ts
// Uses 2020-04 only (this file's own month), so it cannot disturb the seeded plan or other test files.
const URL_ = process.env.SB_LOCAL_URL;
const SECRET = process.env.SB_LOCAL_JWT_SECRET;
if (URL_) assertLocalSupabase(URL_);
const local = !!URL_ && !!SECRET;
const M = '2020-04-01'; // a long-past month: a close needs the month to be over (Manila time)
const NOW_MONTH = new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 7) + '-01';

function jwt(role: string): string {
  const b = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const body = `${b({alg: 'HS256', typ: 'JWT'})}.${b({role, iss: 'supabase', iat: now, exp: now + 300})}`;
  return `${body}.${createHmac('sha256', SECRET!).update(body).digest('base64url')}`;
}
const as = (role: string) => createClient(URL_!, jwt(role), {auth: {persistSession: false}});
const sb = () => as('service_role');
const snap = (n: number) => ({gmv_events: {value: n, state: 'ok'}, gmv_website: {value: 2, state: 'ok'}, gmv_marketplace: {value: 1, state: 'ok'}, gmv_total: {value: n + 3, state: 'ok'}});
const set = (metric: string, amount: number | null, expected: number | null, by: string | null = 'a@x.com') => sb().rpc('plan_set_actual', {p_month: M, p_metric: metric, p_amount: amount, p_expected: expected, p_by: by});
const close = (by: string | null = 'a@x.com', gmv: unknown = snap(10)) => sb().rpc('plan_close_month', {p_month: M, p_by: by, p_gmv: gmv});
const unlock = (reason: string | null, by: string | null = 'a@x.com') => sb().rpc('plan_unlock_month', {p_month: M, p_reason: reason, p_by: by});
const fill = async (skip?: string) => { for (const l of LINES) if (l.id !== skip) expect((await set(l.id, 0, null)).error).toBeNull(); };
const closeRow = async () => (await sb().from('plan_month_closes').select('*').eq('month', M).maybeSingle()).data;
const logs = async () => (await sb().from('plan_actuals_log').select('*').eq('month', M).order('id')).data ?? [];
const cleanup = async () => { await sb().from('plan_month_closes').delete().eq('month', M); await sb().from('plan_actuals').delete().eq('month', M); await sb().from('plan_actuals_log').delete().eq('month', M); };

describe.skipIf(!local)('plan_close_month and plan_unlock_month on the local stack', () => {
  beforeEach(cleanup);
  afterAll(async () => { await cleanup(); await sb().from('plan_versions').delete().like('label', 'close-probe-%'); });

  it('closes only when all 21 typed lines hold a value; a typed 0 counts, a missing line does not', async () => {
    await fill('other_spend');
    expect((await close()).error?.message).toBe('month_incomplete');
    expect(await closeRow()).toBeNull();
    expect((await set('other_spend', 0, null)).error).toBeNull();
    expect((await close()).error).toBeNull();
  });

  it('close gate: a month that has not ended (the current Manila month) is rejected, even when every line is in', async () => {
    await sb().from('plan_actuals').delete().eq('month', NOW_MONTH);
    try {
      for (const l of LINES) expect((await sb().rpc('plan_set_actual', {p_month: NOW_MONTH, p_metric: l.id, p_amount: 0, p_expected: null, p_by: 'a@x.com'})).error).toBeNull();
      const r = await sb().rpc('plan_close_month', {p_month: NOW_MONTH, p_by: 'a@x.com', p_gmv: snap(10)});
      expect(r.error?.message).toBe('month_not_over');
      expect((await sb().from('plan_month_closes').select('month').eq('month', NOW_MONTH)).data).toEqual([]);
    } finally {
      await sb().from('plan_actuals').delete().eq('month', NOW_MONTH);
      await sb().from('plan_actuals_log').delete().eq('month', NOW_MONTH);
    }
  });

  it('close gate: oldest first. An earlier plan month that is still open blocks the close, and nothing is written', async () => {
    const EARLIER = '2019-01-01';
    const v = (await sb().from('plan_versions').select('id').order('id', {ascending: false}).limit(1).single()).data!.id;
    await fill();
    expect((await sb().from('plan_targets').insert({plan_version: v, month: EARLIER, metric: 'order-probe', value: 1})).error).toBeNull();
    try {
      expect((await close()).error?.message).toBe('earlier_month_open');
      expect(await closeRow()).toBeNull();
      await sb().from('plan_month_closes').insert({month: EARLIER, plan_version: v, closed_by: 'a@x.com', gmv_snapshot: snap(1)});
      expect((await close()).error).toBeNull(); // the earlier month is closed: this one may close
    } finally {
      await sb().from('plan_month_closes').delete().eq('month', EARLIER);
      await sb().from('plan_targets').delete().eq('month', EARLIER);
    }
  });

  it('close gate: a partial, empty or missing GMV channel is rejected and nothing is written', async () => {
    await fill();
    const bad = [
      {...snap(10), gmv_marketplace: {value: 1, state: 'partial'}},
      {...snap(10), gmv_website: {value: null, state: 'gap'}},
      {...snap(10), gmv_events: {value: null, state: 'ok'}},
      (() => { const { gmv_events, ...rest } = snap(10); void gmv_events; return rest; })(),
      {},
    ];
    for (const g of bad) expect((await close('a@x.com', g)).error?.message, JSON.stringify(g)).toBe('gmv_incomplete');
    expect(await closeRow()).toBeNull();
    expect((await logs()).filter((l) => l.action === 'close')).toHaveLength(0);
    expect((await close()).error).toBeNull(); // complete channels: closes
  });

  it('the optional ROAS never gates a close, are locked by it, and an unlock reopens them with a log row', async () => {
    await fill();
    expect((await set('roas', 3.2, null)).error).toBeNull();
    expect((await close()).error).toBeNull(); // ROAS is optional; the 21 lines gate the close
    expect((await set('roas', 4, 3.2)).error?.message).toBe('month_closed');
    expect((await set('salaries', 10, 0)).error?.message).toBe('month_closed');
    expect((await unlock('fix a typo')).error).toBeNull();
    expect((await set('roas', 4, 3.2)).error).toBeNull();
    expect((await logs()).filter((l) => l.metric === 'roas').map((l) => [l.action, Number(l.new_value)])).toEqual([['edit', 3.2], ['edit', 4]]);
    expect((await logs()).map((l) => l.action)).toContain('unlock');
  });

  it('writes who, when, the plan version and the GMV snapshot, plus one log row, in one call', async () => {
    await fill();
    const r = await close('boss@x.com', snap(77));
    expect(r.error).toBeNull();
    const row = await closeRow();
    const latest = (await sb().from('plan_versions').select('id').order('id', {ascending: false}).limit(1)).data![0].id;
    expect(row).toMatchObject({closed_by: 'boss@x.com', plan_version: latest});
    expect(row!.closed_at).toBeTruthy();
    expect(row!.gmv_snapshot).toEqual(snap(77));
    expect((await logs()).filter((l) => l.action === 'close')).toHaveLength(1);
  });

  it('a write to a closed month is rejected; closing twice is rejected; a bad snapshot is rejected', async () => {
    await fill();
    expect((await close(undefined, 'nope')).error).not.toBeNull();
    await close();
    expect((await set('marketplace_cogs', 5, 0)).error?.message).toBe('month_closed');
    expect((await close()).error?.message).toBe('already_closed');
    const mcogs = (await sb().from('plan_actuals').select('amount_php').eq('month', M).eq('metric', 'marketplace_cogs').single()).data!;
    expect(Number(mcogs.amount_php)).toBe(0);
  });

  it('unlock needs a reason: blank or missing is rejected and the month stays closed; with a reason it is logged and the cells open', async () => {
    await fill();
    await close();
    for (const bad of ['', '   ', null]) expect((await unlock(bad)).error?.message).toBe('reason_required');
    expect(await closeRow()).not.toBeNull();
    expect((await unlock('late refund found', 'boss@x.com')).error).toBeNull();
    expect(await closeRow()).toBeNull();
    const u = (await logs()).find((l) => l.action === 'unlock')!;
    expect(u).toMatchObject({actor: 'boss@x.com', reason: 'late refund found', month: M});
    expect(u.at).toBeTruthy();
    expect((await set('marketplace_cogs', 9, 0)).error).toBeNull(); // open again
    expect((await unlock('again')).error?.message).toBe('not_closed');
  });

  it('a failed log write fails the unlock: the month stays closed', async () => {
    await fill();
    await close();
    expect((await unlock('reason', null)).error).not.toBeNull(); // no actor: the log insert fails
    expect(await closeRow()).not.toBeNull();
  });

  it('re-closing takes a new snapshot and records the plan version current at that time', async () => {
    await fill();
    await close('a@x.com', snap(1));
    const first = await closeRow();
    await unlock('fix');
    const nv = (await sb().from('plan_versions').insert({label: `close-probe-${Date.now()}`}).select('id').single()).data!.id;
    await close('b@x.com', snap(2));
    const second = await closeRow();
    expect(second!.gmv_snapshot).toEqual(snap(2));
    expect(second!.plan_version).toBe(nv);
    expect(second!.plan_version).not.toBe(first!.plan_version);
    expect(second!.closed_by).toBe('b@x.com');
    // a plan version a close points at cannot be deleted
    expect((await sb().from('plan_versions').delete().eq('id', nv)).error?.code).toBe('23503');
    await sb().from('plan_month_closes').delete().eq('month', M);
    await sb().from('plan_versions').delete().eq('id', nv);
  });

  it('two admins closing at once: one wins, one is told it is already closed, one close log row', async () => {
    await fill();
    const res = await Promise.all([close('a@x.com', snap(1)), close('b@x.com', snap(2))]);
    expect(res.filter((r) => !r.error)).toHaveLength(1);
    expect(res.filter((r) => r.error?.message === 'already_closed')).toHaveLength(1);
    expect((await logs()).filter((l) => l.action === 'close')).toHaveLength(1);
  });

  it('an edit racing a close never leaves a log row with a stale old value', async () => {
    await fill();
    const res = await Promise.all([set('marketplace_cogs', 50, 0, 'a@x.com'), close('b@x.com'), set('marketplace_cogs', 60, 0, 'c@x.com')]);
    expect(res.filter((r) => r.error && !['month_closed', 'stale_value'].includes(r.error.message))).toHaveLength(0);
    const edits = (await logs()).filter((l) => l.metric === 'marketplace_cogs');
    let prev = 0; // the value every log chain started from
    for (const e of edits) {
      expect(Number(e.old_value)).toBe(prev);
      prev = Number(e.new_value);
    }
    const stored = (await sb().from('plan_actuals').select('amount_php').eq('month', M).eq('metric', 'marketplace_cogs').single()).data!;
    expect(Number(stored.amount_php)).toBe(prev);
  });

  it.each(['anon', 'authenticated'])('%s cannot close or unlock', async (role) => {
    await fill();
    expect((await as(role).rpc('plan_close_month', {p_month: M, p_by: 'e@x.com', p_gmv: snap(1)})).error).not.toBeNull();
    await close();
    expect((await as(role).rpc('plan_unlock_month', {p_month: M, p_reason: 'x', p_by: 'e@x.com'})).error).not.toBeNull();
    expect(await closeRow()).not.toBeNull();
  });
});
