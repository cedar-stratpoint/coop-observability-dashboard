import {beforeEach, describe, expect, it, vi} from 'vitest';

// savePlanPartsAction: same gate as savePlanLineAction (editor re-read from the database), validated before the one RPC.
const session = vi.hoisted(() => ({email: 'a@x.com' as string | null}));
const memberships = vi.hoisted(() => ({rows: [] as Array<{companyId: string | null; role: string; status?: string}>}));
const rpc = vi.hoisted(() => vi.fn(async () => ({error: null as null | {message: string}})));
const revalidatePath = vi.hoisted(() => vi.fn());
vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({revalidatePath, updateTag: vi.fn(), unstable_cache: (f: unknown) => f}));
vi.mock('@/auth', () => ({auth: async () => (session.email ? {user: {email: session.email}, memberships: [{companyId: null, role: 'coop_admin'}]} : null)}));
vi.mock('@/src/dev-auth', () => ({devSessionWithMemberships: () => null}));
vi.mock('@/src/company', async () => ({...(await vi.importActual<typeof import('../src/company')>('../src/company')), fetchMemberships: async () => memberships.rows}));
vi.mock('../src/plan-data', () => ({planClient: () => ({rpc})}));

import {savePlanPartsAction} from '../src/plan-actions';

const ok = {month: '2026-10-01', line: 'content_other', parts: {content_socials: 7000, other_spend: 5000}, expected: null as number | null};

describe('savePlanPartsAction', () => {
  beforeEach(() => { session.email = 'a@x.com'; memberships.rows = [{companyId: null, role: 'coop_admin'}]; rpc.mockClear(); rpc.mockResolvedValue({error: null}); revalidatePath.mockClear(); });

  it('an admin saves the breakdown through the one RPC with their email', async () => {
    expect(await savePlanPartsAction(ok)).toEqual({ok: true});
    expect(rpc).toHaveBeenCalledWith('plan_set_actual_parts', {p_month: '2026-10-01', p_line: 'content_other', p_parts: ok.parts, p_expected: null, p_by: 'a@x.com'});
    expect(revalidatePath).toHaveBeenCalledWith('/health-report');
  });

  it.each([
    ['a store manager', [{companyId: 'zoomy', role: 'store_manager'}]],
    ['a viewer', [{companyId: 'zoomy', role: 'analyst'}]],
    ['a suspended admin', [{companyId: null, role: 'coop_admin', status: 'suspended'}]],
    ['nobody', []],
  ])('%s writes nothing', async (_n, rows) => {
    memberships.rows = rows;
    expect((await savePlanPartsAction(ok)).ok).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('a signed-out caller writes nothing', async () => {
    session.email = null;
    expect((await savePlanPartsAction(ok)).ok).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([
    ['a line without a breakdown', {...ok, line: 'platform_fees'}],
    ['a missing part', {...ok, parts: {content_socials: 1}}],
    ['an unknown part', {...ok, parts: {...ok.parts, x: 1}}],
    ['a negative part', {...ok, parts: {content_socials: -1, other_spend: 1}}],
    ['a NaN part', {...ok, parts: {content_socials: Number.NaN, other_spend: 1}}],
    ['a bad month', {...ok, month: '2026-10-15'}],
    ['a non-numeric expected', {...ok, expected: 'x' as unknown as number}],
  ])('rejects %s before the RPC', async (_n, input) => {
    expect((await savePlanPartsAction(input)).ok).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('maps the RPC codes to words (closed month, stale value, incomplete parts)', async () => {
    rpc.mockResolvedValue({error: {message: 'month_closed'}});
    expect(await savePlanPartsAction(ok)).toEqual({ok: false, error: expect.stringMatching(/closed/i)});
    rpc.mockResolvedValue({error: {message: 'stale_value'}});
    expect(await savePlanPartsAction(ok)).toEqual({ok: false, error: expect.stringMatching(/Someone else/)});
    expect(revalidatePath).toHaveBeenCalledWith('/health-report');
    rpc.mockResolvedValue({error: {message: 'incomplete_parts'}});
    expect(await savePlanPartsAction(ok)).toEqual({ok: false, error: expect.stringMatching(/every part/i)});
  });
});
