import {beforeEach, describe, expect, it, vi} from 'vitest';

// BHR-09: the report's Refresh expires every cached GMV read (Website, POS orders + events, marketplace) for an editor, and nothing for anyone else.
const session = vi.hoisted(() => ({email: 'a@x.com' as string | null}));
const memberships = vi.hoisted(() => ({rows: [] as Array<{companyId: string | null; role: string; status?: string}>}));
const updateTag = vi.hoisted(() => vi.fn());

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({revalidatePath: vi.fn(), updateTag, unstable_cache: (f: unknown) => f}));
vi.mock('@/auth', () => ({auth: async () => (session.email ? {user: {email: session.email}} : null)}));
vi.mock('@/src/dev-auth', () => ({devSessionWithMemberships: () => null}));
vi.mock('@/src/company', async () => ({...(await vi.importActual<typeof import('../src/company')>('../src/company')), fetchMemberships: async () => memberships.rows}));
vi.mock('../src/plan-data', () => ({planClient: () => null, getGmvActuals: vi.fn(), PLAN_TAG: 'plan-report'}));

import {syncHealthReport} from '../src/plan-actions';

beforeEach(() => { session.email = 'a@x.com'; updateTag.mockClear(); });

describe('syncHealthReport', () => {
  it.each([
    ['a Coop Admin', [{companyId: null, role: 'coop_admin'}]], ['a Zoomy company admin', [{companyId: 'zoomy', role: 'company_admin'}]],
  ])('%s expires the Website, POS and marketplace reads', async (_n, rows) => {
    memberships.rows = rows;
    await syncHealthReport();
    expect(updateTag.mock.calls.map((c) => c[0])).toEqual(['plan-gmv-web', 'pos-orders', 'pos-events', 'digest-archive']);
  });
  it.each([
    ['a viewer', [{companyId: 'zoomy', role: 'analyst'}]], ['a suspended admin', [{companyId: null, role: 'coop_admin', status: 'suspended'}]], ['no membership', []],
  ])('%s expires nothing', async (_n, rows) => {
    memberships.rows = rows;
    await syncHealthReport();
    expect(updateTag).not.toHaveBeenCalled();
  });
  it('a signed-out caller expires nothing', async () => {
    session.email = null;
    memberships.rows = [{companyId: null, role: 'coop_admin'}];
    await syncHealthReport();
    expect(updateTag).not.toHaveBeenCalled();
  });
});
