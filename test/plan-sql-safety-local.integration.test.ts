import {createHmac} from 'node:crypto';
import {execSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {afterAll, beforeEach, describe, expect, it} from 'vitest';
import {createClient} from '@supabase/supabase-js';
import {assertLocalSupabase} from './support/local-only';

// LOCAL INTEGRATION (skipped unless pointed at the throwaway local stack): the hand-applied plan SQL never removes data without a trace.
// A migration review (2026-11-06) found two gaps: plan_report.sql dropped plan_dated_entries unconditionally, and plan_actuals_drop_derived.sql
// deleted typed rows with no log, also in closed months.   npm run test:plan-local
// Own months in 2033 so it cannot disturb the seeded plan. Runs the files through the local psql only.
const URL_ = process.env.SB_LOCAL_URL;
const SECRET = process.env.SB_LOCAL_JWT_SECRET;
const PSQL = process.env.SB_PSQL_CMD;
if (URL_) assertLocalSupabase(URL_);
const local = !!URL_ && !!SECRET && !!PSQL && /^docker exec -i coop-local-db /.test(PSQL);
const M = '2033-09-01', CLOSED = '2033-10-01';
const sql = (f: string) => readFileSync(path.resolve(__dirname, `../supabase/${f}`), 'utf8');
const run = (text: string) => execSync(`${PSQL} -q 2>&1`, {input: text, encoding: 'utf8'});

function jwt(role: string): string {
  const b = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const body = `${b({alg: 'HS256', typ: 'JWT'})}.${b({role, iss: 'supabase', iat: now, exp: now + 300})}`;
  return `${body}.${createHmac('sha256', SECRET!).update(body).digest('base64url')}`;
}
const sb = () => createClient(URL_!, jwt('service_role'), {auth: {persistSession: false}});
const metrics = async (month: string) => ((await sb().from('plan_actuals').select('metric').eq('month', month).order('metric')).data ?? []).map((r) => r.metric);

describe.skipIf(!local)('plan SQL: no removal without a trace', () => {
  const wipe = async () => {
    for (const m of [M, CLOSED]) {
      await sb().from('plan_month_closes').delete().eq('month', m);
      await sb().from('plan_actuals').delete().eq('month', m);
      await sb().from('plan_actuals_log').delete().eq('month', m);
    }
    run('drop table if exists public.plan_dated_entries;');
  };
  beforeEach(wipe);
  afterAll(wipe);

  it('drop_derived removes the typed derived rows, logs each with its old value, and keeps a closed month', async () => {
    const v = (await sb().from('plan_versions').select('id').order('id', {ascending: false}).limit(1)).data?.[0]?.id;
    expect((await sb().from('plan_month_closes').insert({month: CLOSED, plan_version: v, closed_by: 'a@x.com', gmv_snapshot: {}})).error).toBeNull();
    expect((await sb().from('plan_actuals').insert([
      {month: M, metric: 'cash', amount_php: 5, updated_by: 'a@x.com'},
      {month: M, metric: 'cac', amount_php: 6, updated_by: 'a@x.com'},
      {month: M, metric: 'salaries', amount_php: 7, updated_by: 'a@x.com'},
      {month: CLOSED, metric: 'coverage', amount_php: 8, updated_by: 'a@x.com'},
    ])).error).toBeNull();
    expect(run(sql('plan_actuals_drop_derived.sql'))).toMatch(/closed/);
    expect(await metrics(M)).toEqual(['salaries']);
    expect(await metrics(CLOSED)).toEqual(['coverage']);
    const log = (await sb().from('plan_actuals_log').select('metric,action,old_value,new_value,actor').eq('month', M).order('metric')).data ?? [];
    expect(log.map((l) => [l.metric, l.action, Number(l.old_value), l.new_value, l.actor])).toEqual([['cac', 'clear', 6, null, 'cleanup'], ['cash', 'clear', 5, null, 'cleanup']]);
    run(sql('plan_actuals_drop_derived.sql')); // idempotent: nothing more removed or logged
    expect(((await sb().from('plan_actuals_log').select('id').eq('month', M)).data ?? []).length).toBe(2);
  });

  it('plan_report.sql keeps plan_dated_entries when it holds rows, and drops it when empty', () => {
    run('create table public.plan_dated_entries (id bigint primary key, amount numeric); insert into public.plan_dated_entries values (1, 5);');
    expect(run(sql('plan_report.sql'))).toMatch(/plan_dated_entries/);
    expect(run("select count(*) from public.plan_dated_entries;")).toMatch(/\b1\b/);
    run('delete from public.plan_dated_entries;');
    run(sql('plan_report.sql'));
    expect(run("select coalesce(to_regclass('public.plan_dated_entries')::text, 'gone');")).toMatch(/gone/);
  });
});
