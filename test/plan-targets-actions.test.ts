import {beforeEach, describe, expect, it, vi} from 'vitest';

// The target action is a real gate: a non-editor writes NOTHING; bad input never reaches the database; the RPC's codes become words.
const session = vi.hoisted(() => ({email: 'a@x.com' as string | null}));
const memberships = vi.hoisted(() => ({rows: [] as Array<{companyId: string | null; role: string; status?: string}>}));
const rpc = vi.hoisted(() => vi.fn(async () => ({error: null as null | {message: string}})));
const revalidatePath = vi.hoisted(() => vi.fn());
const updateTag = vi.hoisted(() => vi.fn());

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({revalidatePath, updateTag, unstable_cache: (f: unknown) => f}));
vi.mock('@/auth', () => ({auth: async () => (session.email ? {user: {email: session.email}} : null)}));
vi.mock('@/src/dev-auth', () => ({devSessionWithMemberships: () => null}));
vi.mock('@/src/company', async () => ({...(await vi.importActual<typeof import('../src/company')>('../src/company')), fetchMemberships: async () => memberships.rows}));
vi.mock('../src/plan-data', () => ({planClient: () => ({rpc}), getGmvActuals: vi.fn(), PLAN_TAG: 'plan-report'}));
// The target lock (test/plan-target-lock.test.ts) would refuse every edit today, so this file mocks it open to keep testing the rest of the gate.
vi.mock('../src/plan-compute', async () => ({...(await vi.importActual<typeof import('../src/plan-compute')>('../src/plan-compute')), targetLock: () => ({locked: false})}));

import {editTargetsAction} from '../src/plan-actions';

const edit = {changes: [{month: '2027-01-01', metric: 'gmv_events', value: 150000}], reason: 'new Lazada pricing', expectedVersion: 4};

beforeEach(() => { session.email = 'a@x.com'; memberships.rows = [{companyId: null, role: 'coop_admin'}]; rpc.mockClear(); rpc.mockResolvedValue({error: null}); revalidatePath.mockClear(); });

describe('editTargetsAction', () => {
  it('an admin saves through the one RPC with their email and the trimmed reason', async () => {
    expect(await editTargetsAction({...edit, reason: '  new Lazada pricing '})).toEqual({ok: true});
    expect(rpc).toHaveBeenCalledWith('plan_edit_targets', {p_changes: edit.changes, p_reason: 'new Lazada pricing', p_by: 'a@x.com', p_expected_version: 4});
    expect(revalidatePath).toHaveBeenCalledWith('/health-report');
    expect(updateTag).toHaveBeenCalledWith('plan-report'); // the cached plan read is expired, so the next load sees the new version
  });
  it('a Zoomy company admin may too', async () => {
    memberships.rows = [{companyId: 'zoomy', role: 'company_admin'}];
    expect((await editTargetsAction(edit)).ok).toBe(true);
  });
  it.each([
    ['a store manager', [{companyId: 'zoomy', role: 'store_manager'}]], ['a viewer', [{companyId: 'zoomy', role: 'analyst'}]],
    ['another company admin', [{companyId: 'goldline', role: 'company_admin'}]], ['a suspended admin', [{companyId: null, role: 'coop_admin', status: 'suspended'}]], ['no membership', []],
  ])('%s writes nothing', async (_n, rows) => {
    memberships.rows = rows;
    expect((await editTargetsAction(edit)).ok).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });
  it('signed out writes nothing', async () => { session.email = null; expect((await editTargetsAction(edit)).ok).toBe(false); expect(rpc).not.toHaveBeenCalled(); });
  it.each([
    ['no reason', {...edit, reason: ''}], ['a blank reason', {...edit, reason: '   '}], ['a non-string reason', {...edit, reason: 5 as unknown as string}], ['a reason over 500 characters', {...edit, reason: 'x'.repeat(501)}],
    ['no changes', {...edit, changes: []}], ['changes that are not a list', {...edit, changes: 'x' as unknown as []}],
    ['a bad month', {...edit, changes: [{month: '2027-01-15', metric: 'gmv_events', value: 1}]}],
    ['an unknown metric', {...edit, changes: [{month: '2027-01-01', metric: 'nope', value: 1}]}],
    ['Total GMV (calculated)', {...edit, changes: [{month: '2027-01-01', metric: 'gmv_total', value: 1}]}],
    ['NaN', {...edit, changes: [{month: '2027-01-01', metric: 'gmv_events', value: NaN}]}],
    ['a string value', {...edit, changes: [{month: '2027-01-01', metric: 'gmv_events', value: '1' as unknown as number}]}],
    ['a missing version', {...edit, expectedVersion: undefined as unknown as number}],
  ])('rejects %s before the RPC', async (_n, input) => { expect((await editTargetsAction(input)).ok).toBe(false); expect(rpc).not.toHaveBeenCalled(); });
  it.each([
    ['month_closed', /closed/], ['past_month', /already over|past/i], ['reason_required', /why/i], ['stale_version', /Someone else/], ['unknown_target', /not in the plan/i], ['calculated_target', /calculated/i],
  ])('the RPC code %s becomes words (closed month and missing reason are rejected)', async (code, re) => {
    rpc.mockResolvedValue({error: {message: code}});
    const r = await editTargetsAction(edit);
    expect(r.ok).toBe(false);
    expect((r as {error: string}).error).toMatch(re);
  });
  it('a stale version refreshes the page', async () => {
    rpc.mockResolvedValue({error: {message: 'stale_version'}});
    await editTargetsAction(edit);
    expect(revalidatePath).toHaveBeenCalledWith('/health-report');
  });
});
