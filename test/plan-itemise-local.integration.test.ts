import {createHmac} from 'node:crypto';
import {execSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {afterAll, beforeEach, describe, expect, it} from 'vitest';
import {createClient} from '@supabase/supabase-js';
import {assertLocalSupabase} from './support/local-only';

// LOCAL INTEGRATION (skipped unless pointed at the throwaway local stack): BHR-06 one-off supabase/plan_actuals_itemise.sql. A total typed with a
// full breakdown is split into its itemised sheet rows (lossless); a total typed without one is kept and named; a second run changes nothing.
//   npm run test:plan-local
// Own months in 2032; the parts table is written directly (its RPC is retired). Local psql only.
const URL_ = process.env.SB_LOCAL_URL;
const SECRET = process.env.SB_LOCAL_JWT_SECRET;
const PSQL = process.env.SB_PSQL_CMD;
if (URL_) assertLocalSupabase(URL_);
const local = !!URL_ && !!SECRET && !!PSQL && /^docker exec -i coop-local-db /.test(PSQL);
const M = '2032-11-01', N = '2032-12-01';
const SQL = readFileSync(path.resolve(__dirname, '../supabase/plan_actuals_itemise.sql'), 'utf8');

function jwt(role: string): string {
  const b = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const body = `${b({alg: 'HS256', typ: 'JWT'})}.${b({role, iss: 'supabase', iat: now, exp: now + 300})}`;
  return `${body}.${createHmac('sha256', SECRET!).update(body).digest('base64url')}`;
}
const sb = () => createClient(URL_!, jwt('service_role'), {auth: {persistSession: false}});
const run = () => execSync(`${PSQL} -q 2>&1`, {input: SQL, encoding: 'utf8'});
const rows = async (month: string) => Object.fromEntries(((await sb().from('plan_actuals').select('metric,amount_php').eq('month', month)).data ?? []).map((r) => [r.metric, Number(r.amount_php)]));

describe.skipIf(!local)('BHR-06 itemise: totals become their sheet rows', () => {
  const wipe = async () => { for (const m of [M, N]) { await sb().from('plan_actuals').delete().eq('month', m); await sb().from('plan_actuals_log').delete().eq('month', m); } };
  beforeEach(wipe);
  afterAll(wipe);

  it('splits a total with a full breakdown into its rows, deletes the total, and logs both', async () => {
    expect((await sb().from('plan_actuals').insert([{month: M, metric: 'cogs', amount_php: 60}, {month: M, metric: 'content_other', amount_php: 5}])).error).toBeNull();
    expect((await sb().from('plan_actual_parts').insert([
      {month: M, metric: 'cogs', part: 'marketplace_cogs', amount_php: 50}, {month: M, metric: 'cogs', part: 'website_cogs', amount_php: 10}, {month: M, metric: 'cogs', part: 'events_cogs', amount_php: 0},
      {month: M, metric: 'content_other', part: 'content_socials', amount_php: 4}, {month: M, metric: 'content_other', part: 'other_spend', amount_php: 1},
    ])).error).toBeNull();
    expect(run()).toMatch(/2 split/);
    expect(await rows(M)).toEqual({marketplace_cogs: 50, website_cogs: 10, events_cogs: 0, content_socials: 4, other_spend: 1});
    const log = (await sb().from('plan_actuals_log').select('metric,action,actor').eq('month', M)).data ?? [];
    expect(log.filter((l) => l.action === 'clear').map((l) => l.metric).sort()).toEqual(['cogs', 'content_other']);
    expect(log.filter((l) => l.action === 'edit')).toHaveLength(5);
    expect(log.every((l) => l.actor === 'itemise')).toBe(true);
    expect(run()).toMatch(/0 split/); // idempotent
  });

  it('keeps a total typed without a breakdown (or with one that does not add up) and names it', async () => {
    await sb().from('plan_actuals').insert([{month: N, metric: 'overhead', amount_php: 100}, {month: N, metric: 'cogs', amount_php: 60}]);
    await sb().from('plan_actual_parts').insert([{month: N, metric: 'cogs', part: 'marketplace_cogs', amount_php: 1}, {month: N, metric: 'cogs', part: 'website_cogs', amount_php: 1}, {month: N, metric: 'cogs', part: 'events_cogs', amount_php: 1}]);
    const out = run();
    expect(out).toMatch(/kept 2032-12-01 cogs/);
    expect(out).toMatch(/kept 2032-12-01 overhead/);
    expect(await rows(N)).toEqual({overhead: 100, cogs: 60});
  });

  it('retires the breakdown RPC', async () => {
    run();
    expect((await sb().rpc('plan_set_actual_parts', {p_month: M, p_line: 'cogs', p_parts: {}, p_expected: null, p_by: 'x'})).error).not.toBeNull();
  });

  const psqlFile = (f: string) => execSync(`${PSQL} -q 2>&1`, {input: readFileSync(path.resolve(__dirname, '..', f), 'utf8'), encoding: 'utf8'});
  const psqlRows = (q: string) => execSync(`${PSQL} -qAt -F '|' 2>&1`, {input: q, encoding: 'utf8'}).trim();

  it('M5: re-applying the documented files, in order, does not bring the retired RPC back', () => {
    for (const f of ['supabase/plan_report.sql', 'supabase/plan_actuals_remove_workbook_prefill.sql', 'supabase/plan_actual_parts.sql', 'supabase/plan_actuals_itemise.sql']) psqlFile(f);
    psqlFile('supabase/plan_actual_parts.sql'); // even re-applied after the itemise step
    expect(psqlRows("select count(*) from pg_proc where proname = 'plan_set_actual_parts';")).toBe('0');
  });

  it('M6: the preflight in the itemise header counts closed months that still hold a total-only row', async () => {
    const q = /-- PREFLIGHT BEGIN\n([\s\S]*?)-- PREFLIGHT END/.exec(SQL)![1].split('\n').map((l) => l.replace(/^-- ?/, '')).join('\n');
    const v = (await sb().from('plan_versions').select('id').order('id', {ascending: true}).limit(1)).data![0].id;
    try {
      await sb().from('plan_actuals').insert([{month: N, metric: 'overhead', amount_php: 100}, {month: N, metric: 'cogs', amount_php: 60}, {month: M, metric: 'cogs', amount_php: 7}]);
      await sb().from('plan_actual_parts').insert([{month: M, metric: 'cogs', part: 'marketplace_cogs', amount_php: 7}, {month: M, metric: 'cogs', part: 'website_cogs', amount_php: 0}, {month: M, metric: 'cogs', part: 'events_cogs', amount_php: 0}]);
      const before = psqlRows(q).split('\n').pop()!;
      expect(before).toBe('0|0'); // no month closed yet
      expect((await sb().from('plan_month_closes').insert([{month: N, plan_version: v, closed_by: 'probe-preflight'}, {month: M, plan_version: v, closed_by: 'probe-preflight'}])).error).toBeNull();
      expect(psqlRows(q).split('\n').pop()).toBe('1|2'); // N: two totals with no breakdown; M has a full breakdown, so it would be split
    } finally {
      await sb().from('plan_month_closes').delete().eq('closed_by', 'probe-preflight');
    }
  });
});

