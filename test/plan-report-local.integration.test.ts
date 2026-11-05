import {createHmac} from 'node:crypto';
import {describe, expect, it} from 'vitest';
import {createClient} from '@supabase/supabase-js';
import {assertLocalSupabase} from './support/local-only';

// LOCAL INTEGRATION (skipped unless pointed at the throwaway local stack from scripts/local-supabase/up.sh):
//   set -a; source scripts/local-supabase/.local-env; set +a; npx vitest run test/plan-report-local.integration.test.ts
const URL_ = process.env.SB_LOCAL_URL;
const SECRET = process.env.SB_LOCAL_JWT_SECRET;
if (URL_) assertLocalSupabase(URL_);
const local = !!URL_ && !!SECRET;
const TABLES = ['plan_versions', 'plan_targets', 'plan_part_targets', 'plan_actuals', 'plan_month_closes', 'plan_actuals_log'];

function jwt(role: string): string {
  const b = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const body = `${b({alg: 'HS256', typ: 'JWT'})}.${b({role, iss: 'supabase', iat: now, exp: now + 300})}`;
  return `${body}.${createHmac('sha256', SECRET!).update(body).digest('base64url')}`;
}
const as = (role: string) => createClient(URL_!, jwt(role), {auth: {persistSession: false}});

describe.skipIf(!local)('plan_* tables on the local stack', () => {
  it('the service role reads the base plan: 17 months starting Aug 2026, every month carrying the same metrics', async () => {
    const sb = as('service_role');
    const v = await sb.from('plan_versions').select('id,label').order('id', {ascending: true}).limit(1); // other tests insert short-lived probe versions after it
    expect(v.error).toBeNull();
    const t = await sb.from('plan_targets').select('month,metric').eq('plan_version', v.data![0].id).limit(5000);
    expect(t.error).toBeNull();
    const months = [...new Set((t.data ?? []).map((r) => r.month))].sort();
    expect(months).toHaveLength(17);
    expect(months[0]).toBe('2026-08-01');
    expect(months[16]).toBe('2027-12-01');
    expect((t.data ?? []).length % 17).toBe(0);
  });
  it('holds no actuals for real months except the known prefills (loaded privately), and closes nothing', async () => {
    const sb = as('service_role');
    const a = await sb.from('plan_actuals').select('month,metric,source').lt('month', '2031-01-01').order('month').order('metric');
    for (const r of a.data ?? []) expect(['opening_customers', 'opening_inventory', 'bridge_funding'], `${r.month} ${r.metric}`).toContain(r.metric);
    for (const r of a.data ?? []) expect(['workbook', 'owner'], `${r.month} ${r.metric}`).toContain(r.source);
    expect((await sb.from('plan_month_closes').select('*', {count: 'exact', head: true}).lt('month', '2031-01-01')).count).toBe(0);
    const log = await sb.from('plan_actuals_log').select('action').lt('month', '2031-01-01');
    for (const r of log.data ?? []) expect(r.action).toBe('seed'); // the log holds only prefills, never a typed edit
  });
  it.each(TABLES)('anon cannot read %s (RLS on, no policies, no grant)', async (table) => {
    const r = await as('anon').from(table).select('*').limit(1);
    expect(r.data ?? []).toEqual([]); // either a permission error or an empty set, never a row
  });
  it('anon cannot write either', async () => {
    const r = await as('anon').from('plan_versions').insert({label: 'evil'});
    expect(r.error).not.toBeNull();
  });
  it('a closed month pins its plan version: deleting the version is restricted', async () => {
    const sb = as('service_role');
    const v = await sb.from('plan_versions').insert({label: 'restrict-probe'}).select('id').single();
    const m = '2030-01-01';
    await sb.from('plan_month_closes').insert({month: m, plan_version: v.data!.id, closed_by: 'test'});
    const del = await sb.from('plan_versions').delete().eq('id', v.data!.id);
    expect(del.error?.code).toBe('23503');
    await sb.from('plan_month_closes').delete().eq('month', m);
    await sb.from('plan_versions').delete().eq('id', v.data!.id);
  });
});
