import {createHmac} from 'node:crypto';
import {execSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {afterAll, beforeEach, describe, expect, it} from 'vitest';
import {createClient} from '@supabase/supabase-js';
import {assertLocalSupabase} from './support/local-only';

// LOCAL INTEGRATION (skipped unless pointed at the throwaway local stack): BHR-06 removes the workbook "prefills" from the actuals.
// The plan workbook holds targets only (knowledge/lessons/plan-workbook-is-targets-only.md), so nothing may store a workbook value as an actual.
//   npm run test:plan-local
// Own month in 2032 so it cannot disturb the seeded plan. Runs supabase/plan_actuals_remove_workbook_prefill.sql through the local psql only.
const URL_ = process.env.SB_LOCAL_URL;
const SECRET = process.env.SB_LOCAL_JWT_SECRET;
const PSQL = process.env.SB_PSQL_CMD;
if (URL_) assertLocalSupabase(URL_);
const local = !!URL_ && !!SECRET && !!PSQL && /^docker exec -i coop-local-db /.test(PSQL);
const M = '2032-09-01', CLOSED = '2032-10-01';
const CLEANUP = readFileSync(path.resolve(__dirname, '../supabase/plan_actuals_remove_workbook_prefill.sql'), 'utf8');

function jwt(role: string): string {
  const b = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const body = `${b({alg: 'HS256', typ: 'JWT'})}.${b({role, iss: 'supabase', iat: now, exp: now + 300})}`;
  return `${body}.${createHmac('sha256', SECRET!).update(body).digest('base64url')}`;
}
const sb = () => createClient(URL_!, jwt('service_role'), {auth: {persistSession: false}});
const runCleanup = () => execSync(`${PSQL} -q 2>&1`, {input: CLEANUP, encoding: 'utf8'});
const rows = async (month: string) => (await sb().from('plan_actuals').select('metric,amount_php,source').eq('month', month).order('metric')).data ?? [];

describe.skipIf(!local)('BHR-06 cleanup: no workbook value is stored as an actual', () => {
  const wipe = async () => {
    for (const m of [M, CLOSED]) {
      await sb().from('plan_month_closes').delete().eq('month', m);
      await sb().from('plan_actuals').delete().eq('month', m);
      await sb().from('plan_actuals_log').delete().eq('month', m);
    }
  };
  beforeEach(wipe);
  afterAll(wipe);

  it('the prefill RPC is gone: nothing can write a workbook actual any more', async () => {
    const r = await sb().rpc('plan_seed_actual', {p_month: M, p_metric: 'bridge_funding', p_amount: 5, p_source: 'owner', p_by: 'seed'});
    expect(r.error).not.toBeNull();
  });

  it('deletes the tagged prefills (workbook and owner), keeps what an admin typed, and logs each removal', async () => {
    const ins = await sb().from('plan_actuals').insert([
      {month: M, metric: 'bridge_funding', amount_php: 5, source: 'owner', updated_by: 'seed'},
      {month: M, metric: 'liability_settlement', amount_php: 7, source: 'workbook', updated_by: 'seed'},
      {month: M, metric: 'cogs', amount_php: 9, source: null, updated_by: 'a@x.com'},
    ]);
    expect(ins.error).toBeNull();
    runCleanup();
    expect((await rows(M)).map((r) => [r.metric, r.source])).toEqual([['cogs', null]]);
    const log = (await sb().from('plan_actuals_log').select('metric,action,old_value,new_value,actor').eq('month', M).order('metric')).data ?? [];
    expect(log.map((l) => [l.metric, l.action, Number(l.old_value), l.new_value, l.actor])).toEqual([['bridge_funding', 'clear', 5, null, 'cleanup'], ['liability_settlement', 'clear', 7, null, 'cleanup']]);
  });

  it('is idempotent: a second run deletes and logs nothing', async () => {
    await sb().from('plan_actuals').insert({month: M, metric: 'bridge_funding', amount_php: 5, source: 'owner', updated_by: 'seed'});
    runCleanup();
    runCleanup();
    expect(await rows(M)).toEqual([]);
    expect(((await sb().from('plan_actuals_log').select('id').eq('month', M)).data ?? []).length).toBe(1);
  });

  it('leaves a closed month locked as it is (unlock it with a reason to clear it) and says so', async () => {
    const v = (await sb().from('plan_versions').select('id').order('id', {ascending: false}).limit(1)).data?.[0]?.id;
    expect((await sb().from('plan_month_closes').insert({month: CLOSED, plan_version: v, closed_by: 'a@x.com', gmv_snapshot: {}})).error).toBeNull();
    await sb().from('plan_actuals').insert({month: CLOSED, metric: 'bridge_funding', amount_php: 5, source: 'owner', updated_by: 'seed'});
    expect(runCleanup()).toMatch(/closed/);
    expect((await rows(CLOSED)).map((r) => r.metric)).toEqual(['bridge_funding']);
  });

  it('after the cleanup no real plan month holds a tagged prefill', async () => {
    runCleanup();
    const a = await sb().from('plan_actuals').select('month,metric').in('source', ['workbook', 'owner']).lt('month', '2031-01-01');
    expect(a.error).toBeNull();
    const closed = new Set(((await sb().from('plan_month_closes').select('month')).data ?? []).map((c) => c.month));
    expect((a.data ?? []).filter((r) => !closed.has(r.month))).toEqual([]);
  });
});
