import {beforeEach, describe, expect, it, vi} from 'vitest';

const session = vi.hoisted(() => ({email: 'admin@x.com' as string | null}));
const memberships = vi.hoisted(() => ({rows: [] as Array<{companyId: string | null; role: string}>}));
const env = vi.hoisted(() => ({key: 'staging' as 'staging' | 'production'}));
const revoke = vi.hoisted(() => vi.fn());
const setStatus = vi.hoisted(() => vi.fn());
const grantRoles = vi.hoisted(() =>
  vi.fn(async (input: {grants: unknown[]}) => ({granted: input.grants.length, skipped: 0})),
);

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({revalidatePath: vi.fn()}));
vi.mock('@/auth', () => ({auth: async () => (session.email ? {user: {email: session.email}} : null)}));
vi.mock('@/src/company', () => ({
  COOP_VIEW_KEY: 'coop_admin',
  fetchMemberships: async () => memberships.rows,
}));
vi.mock('@/src/admin-data', () => ({
  grantRoles,
  countCoopAdmins: async () => 2,
  revoke,
  setStatus,
}));
vi.mock('@/src/coop-env-server', () => ({guardEnv: () => env.key, currentEnv: async () => ({key: env.key})}));
vi.mock('@/src/coop-env', async () => await vi.importActual('../src/coop-env'));

import {grantRoleAction, grantRolesAction, revokeAction, setStatusAction} from '../app/admin/actions';

describe('grantRolesAction', () => {
  beforeEach(() => {
    session.email = 'admin@x.com';
    memberships.rows = [{companyId: null, role: 'coop_admin'}];
    grantRoles.mockClear();
  });

  it('refuses a caller without an active Coop Admin role', async () => {
    memberships.rows = [{companyId: 'zoomy', role: 'company_admin'}];
    const res = await grantRolesAction({email: 'p@x.com', grants: [{companyKey: 'zoomy', role: 'company_admin'}]});
    expect(res.ok).toBe(false);
    expect(grantRoles).not.toHaveBeenCalled();
  });

  it('grants every picked role to one email', async () => {
    const res = await grantRolesAction({
      email: '  P@X.com ',
      grants: [
        {companyKey: 'zoomy', role: 'company_admin'},
        {companyKey: 'goldline', role: 'company_admin'},
        {companyKey: 'coop_admin', role: 'coop_admin'},
      ],
    });
    expect(res).toEqual({ok: true});
    // One data-layer call with every grant (single insert, all-or-nothing).
    expect(grantRoles).toHaveBeenCalledTimes(1);
    expect(grantRoles).toHaveBeenCalledWith({
      actor: 'admin@x.com',
      email: 'p@x.com',
      grants: [
        {companyId: 'zoomy', role: 'company_admin'},
        {companyId: 'goldline', role: 'company_admin'},
        {companyId: null, role: 'coop_admin'},
      ],
    });
  });

  it('validates all grants before writing any', async () => {
    const res = await grantRolesAction({
      email: 'p@x.com',
      grants: [
        {companyKey: 'zoomy', role: 'company_admin'},
        {companyKey: 'goldline', role: 'coop_admin'}, // coop_admin can't be company-scoped
      ],
    });
    expect(res.ok).toBe(false);
    expect(grantRoles).not.toHaveBeenCalled();
  });

  it('rejects a bad email and an empty pick', async () => {
    expect((await grantRolesAction({email: 'nope', grants: [{companyKey: 'zoomy', role: 'company_admin'}]})).ok).toBe(false);
    expect((await grantRolesAction({email: 'p@x.com', grants: []})).ok).toBe(false);
    expect(grantRoles).not.toHaveBeenCalled();
  });

  it('returns a clean error for a malformed grant entry instead of throwing', async () => {
    const res = await grantRolesAction({email: 'p@x.com', grants: [null as never]});
    expect(res.ok).toBe(false);
    expect(grantRoles).not.toHaveBeenCalled();
  });

  it('reports when every picked role is already held', async () => {
    grantRoles.mockResolvedValueOnce({granted: 0, skipped: 1});
    const res = await grantRolesAction({email: 'p@x.com', grants: [{companyKey: 'zoomy', role: 'company_admin'}]});
    expect(res).toEqual({ok: false, error: 'They already have every role you picked.'});
  });
});

describe('grantRoleAction', () => {
  beforeEach(() => {
    session.email = 'admin@x.com';
    memberships.rows = [{companyId: null, role: 'coop_admin'}];
    grantRoles.mockClear();
  });

  it('never silently changes existing access — reports it instead', async () => {
    grantRoles.mockResolvedValueOnce({granted: 0, skipped: 1});
    const res = await grantRoleAction({email: 'p@x.com', companyKey: 'zoomy', role: 'company_admin'});
    expect(res).toEqual({ok: false, error: 'They already have this access.'});
  });
});

describe('Production guard on risky access changes', () => {
  beforeEach(() => {
    session.email = 'admin@x.com';
    memberships.rows = [{companyId: null, role: 'coop_admin'}];
    revoke.mockClear();
    setStatus.mockClear();
  });

  it('in Staging, remove and suspend need no typed word', async () => {
    env.key = 'staging';
    expect((await revokeAction({email: 'p@x.com', companyKey: 'zoomy'})).ok).toBe(true);
    expect((await setStatusAction({email: 'p@x.com', companyKey: 'zoomy', status: 'suspended'})).ok).toBe(true);
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(setStatus).toHaveBeenCalledTimes(1);
  });

  it('in Production, refuses remove / suspend without PRODUCTION typed', async () => {
    env.key = 'production';
    const r = await revokeAction({email: 'p@x.com', companyKey: 'zoomy'});
    const s = await setStatusAction({email: 'p@x.com', companyKey: 'zoomy', status: 'suspended', confirm: 'production'});
    expect(r).toEqual({ok: false, error: 'Type PRODUCTION to confirm this change in Production.'});
    expect(s.ok).toBe(false);
    expect(revoke).not.toHaveBeenCalled();
    expect(setStatus).not.toHaveBeenCalled();
  });

  it('in Production, allows it with PRODUCTION typed; reactivating needs no word', async () => {
    env.key = 'production';
    expect((await revokeAction({email: 'p@x.com', companyKey: 'zoomy', confirm: 'PRODUCTION'})).ok).toBe(true);
    expect((await setStatusAction({email: 'p@x.com', companyKey: 'zoomy', status: 'suspended', confirm: 'PRODUCTION'})).ok).toBe(true);
    expect((await setStatusAction({email: 'p@x.com', companyKey: 'zoomy', status: 'active'})).ok).toBe(true);
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(setStatus).toHaveBeenCalledTimes(2);
  });
});
