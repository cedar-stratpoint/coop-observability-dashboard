import {createHmac} from 'node:crypto';
import {afterAll, beforeEach, describe, expect, it} from 'vitest';
import {createClient} from '@supabase/supabase-js';
import {assertLocalSupabase} from './support/local-only';
import {LINE_PARTS, consistentParts, sumPesos} from '../src/plan-parts';

// LOCAL INTEGRATION (skipped unless pointed at the throwaway local stack): plan_set_actual_parts (supabase/plan_actual_parts.sql).
//   npm run test:plan-local. Months in 2032 are this file's own.
const URL_ = process.env.SB_LOCAL_URL;
const SECRET = process.env.SB_LOCAL_JWT_SECRET;
if (URL_) assertLocalSupabase(URL_);
const local = !!URL_ && !!SECRET;
const M = '2032-03-01';

function jwt(role: string): string {
  const b = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const body = `${b({alg: 'HS256', typ: 'JWT'})}.${b({role, iss: 'supabase', iat: now, exp: now + 300})}`;
  return `${body}.${createHmac('sha256', SECRET!).update(body).digest('base64url')}`;
}
const as = (role: string) => createClient(URL_!, jwt(role), {auth: {persistSession: false}});
const sb = () => as('service_role');
const save = (line: string, parts: Record<string, unknown> | null, expected: number | null, by = 'admin@x.com', month = M) =>
  sb().rpc('plan_set_actual_parts', {p_month: month, p_line: line, p_parts: parts, p_expected: expected, p_by: by});
const total = async (line: string) => { const r = (await sb().from('plan_actuals').select('amount_php').eq('month', M).eq('metric', line).maybeSingle()).data; return r ? Number(r.amount_php) : null; };
const partRows = async (line: string) => Object.fromEntries(((await sb().from('plan_actual_parts').select('part,amount_php').eq('month', M).eq('metric', line)).data ?? []).map((r) => [r.part, Number(r.amount_php)]));
const logs = async () => (await sb().from('plan_actuals_log').select('*').eq('month', M).order('id')).data ?? [];
const OVERHEAD = {salaries: 91000, rent: 17000, accounting: 13000, tech: 4500, growth_consultant: 9000, rnd: 0};

describe.skipIf(!local)('plan_set_actual_parts on the local stack', () => {
  const wipe = async () => { await sb().from('plan_actuals').delete().eq('month', M); await sb().from('plan_actuals_log').delete().eq('month', M); await sb().from('plan_month_closes').delete().eq('month', M); };
  beforeEach(wipe);
  afterAll(wipe);

  it('accepts every part id of every line, and stores the SUM as the parent total', async () => {
    for (const [line, defs] of Object.entries(LINE_PARTS)) {
      const parts = Object.fromEntries(defs.map((d, i) => [d.id, 1000 + i + 0.1]));
      expect((await save(line, parts, null)).error, line).toBeNull();
      expect(await total(line)).toBe(sumPesos(Object.values(parts)));
      expect(await partRows(line)).toEqual(parts);
    }
  });

  it('stores a typed 0 part as a real 0, and the parent total is the sum', async () => {
    expect((await save('overhead', OVERHEAD, null)).error).toBeNull();
    expect(await total('overhead')).toBe(134500);
    expect((await partRows('overhead')).rnd).toBe(0);
  });

  it('replaces the previous parts, compare-and-set on the total, and logs old and new total with the breakdown', async () => {
    await save('content_other', {content_socials: 7000, other_spend: 5000}, null, 'a@x.com');
    expect((await save('content_other', {content_socials: 1, other_spend: 2}, 12000, 'b@x.com')).error).toBeNull();
    expect(await partRows('content_other')).toEqual({content_socials: 1, other_spend: 2});
    expect(await total('content_other')).toBe(3);
    const l = await logs();
    expect(l.map((r) => [r.actor, r.old_value === null ? null : Number(r.old_value), Number(r.new_value), r.action])).toEqual([['a@x.com', null, 12000, 'edit'], ['b@x.com', 12000, 3, 'edit']]);
    expect(l[1].reason).toMatch(/^breakdown:/);
  });

  it('a stale expected total is rejected and nothing changes', async () => {
    await save('cogs', {marketplace_cogs: 1, website_cogs: 2, events_cogs: 3}, null);
    const stale = await save('cogs', {marketplace_cogs: 9, website_cogs: 9, events_cogs: 9}, 100);
    expect(stale.error?.message).toBe('stale_value');
    expect(await total('cogs')).toBe(6);
    expect(await partRows('cogs')).toEqual({marketplace_cogs: 1, website_cogs: 2, events_cogs: 3});
    expect((await save('cogs', {marketplace_cogs: 9, website_cogs: 9, events_cogs: 9}, null)).error?.message).toBe('stale_value'); // the page thought it was empty
    expect(await logs()).toHaveLength(1);
  });

  it('rejects a closed month (nothing written) and works again after the unlock', async () => {
    const v = (await sb().from('plan_versions').select('id').limit(1)).data![0].id;
    await sb().from('plan_month_closes').insert({month: M, plan_version: v, closed_by: 'x@x.com'});
    expect((await save('cogs', {marketplace_cogs: 1, website_cogs: 2, events_cogs: 3}, null)).error?.message).toBe('month_closed');
    expect(await total('cogs')).toBeNull();
    expect(await partRows('cogs')).toEqual({});
    const un = await sb().rpc('plan_unlock_month', {p_month: M, p_reason: 'fix', p_by: 'a@x.com'});
    expect(un.error).toBeNull();
    expect((await save('cogs', {marketplace_cogs: 1, website_cogs: 2, events_cogs: 3}, null)).error).toBeNull();
  });

  it.each([
    ['unknown line', 'platform_fees', {a: 1}, 'invalid_line'],
    ['missing part', 'content_other', {content_socials: 1}, 'incomplete_parts'],
    ['null parts', 'content_other', null, 'incomplete_parts'],
    ['a part that is null', 'content_other', {content_socials: 1, other_spend: null}, 'incomplete_parts'],
    ['text part', 'content_other', {content_socials: 'x', other_spend: 1}, 'incomplete_parts'],
    ['extra part', 'content_other', {content_socials: 1, other_spend: 1, bogus: 1}, 'invalid_part'],
    ['negative part', 'content_other', {content_socials: -1, other_spend: 2}, 'negative_cost'],
  ])('rejects %s', async (_n, line, parts, code) => {
    expect((await save(line as string, parts as Record<string, unknown> | null, null)).error?.message).toBe(code);
    expect(await total(line as string)).toBeNull();
    expect(await logs()).toHaveLength(0);
  });

  it('an invalid month is rejected', async () => {
    expect((await save('cogs', {marketplace_cogs: 1, website_cogs: 1, events_cogs: 1}, null, 'a@x.com', '2032-03-15')).error?.message).toBe('invalid_month');
  });

  it('stale-parts rule: a total typed directly afterwards leaves the parts in place but they stop being consistent; the same total makes them consistent again', async () => {
    await save('content_other', {content_socials: 7000, other_spend: 5000}, null);
    expect((await sb().rpc('plan_set_actual', {p_month: M, p_metric: 'content_other', p_amount: 40000, p_expected: 12000, p_by: 'a@x.com'})).error).toBeNull();
    expect(consistentParts('content_other', await total('content_other'), await partRows('content_other'))).toBe(false);
    await sb().rpc('plan_set_actual', {p_month: M, p_metric: 'content_other', p_amount: 12000, p_expected: 40000, p_by: 'a@x.com'});
    expect(consistentParts('content_other', await total('content_other'), await partRows('content_other'))).toBe(true);
  });

  it('clearing the cell deletes its parts (never a part without a total)', async () => {
    await save('content_other', {content_socials: 7000, other_spend: 5000}, null);
    expect((await sb().rpc('plan_set_actual', {p_month: M, p_metric: 'content_other', p_amount: null, p_expected: 12000, p_by: 'a@x.com'})).error).toBeNull();
    expect(await partRows('content_other')).toEqual({});
  });

  it('the total saved through the parts RPC is an ordinary plan_actuals row: the close gate and the derived math count it like any typed total', async () => {
    await save('overhead', OVERHEAD, null);
    const r = (await sb().from('plan_actuals').select('metric,amount_php,source').eq('month', M)).data ?? [];
    expect(r).toEqual([{metric: 'overhead', amount_php: 134500, source: null}]);
  });

  it.each(['anon', 'authenticated'])('%s cannot call the RPC or read the table', async (role) => {
    const r = await as(role).rpc('plan_set_actual_parts', {p_month: M, p_line: 'cogs', p_parts: {marketplace_cogs: 1, website_cogs: 1, events_cogs: 1}, p_expected: null, p_by: 'x'});
    expect(r.error).not.toBeNull();
    expect(await total('cogs')).toBeNull();
    const t = await as(role).from('plan_actual_parts').select('*');
    expect(t.error !== null || (t.data ?? []).length === 0).toBe(true);
  });
});
