import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

// The server action is the real gate: it must write NOTHING for a store manager, a viewer (analyst), a signed-out caller or a suspended admin,
// whatever the session token says. Memberships are re-read from the database (mocked here), the RPC is a spy.
const session = vi.hoisted(() => ({email: 'a@x.com' as string | null}));
const memberships = vi.hoisted(() => ({rows: [] as Array<{companyId: string | null; role: string; status?: string}>}));
const rpc = vi.hoisted(() => vi.fn(async () => ({error: null as null | {message: string}})));
const revalidatePath = vi.hoisted(() => vi.fn());

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({revalidatePath, unstable_cache: (f: unknown) => f}));
vi.mock('@/auth', () => ({auth: async () => (session.email ? {user: {email: session.email}, memberships: [{companyId: null, role: 'coop_admin'}]} : null)}));
vi.mock('@/src/dev-auth', () => ({devSessionWithMemberships: () => null}));
vi.mock('@/src/company', async () => ({...(await vi.importActual<typeof import('../src/company')>('../src/company')), fetchMemberships: async () => memberships.rows}));
const gmv = vi.hoisted(() => vi.fn(async () => ({gmv_events: [{value: 5, state: 'ok'}], gmv_website: [{value: null, state: 'gap'}], gmv_marketplace: [{value: 1, state: 'partial'}], gmv_total: [{value: 6, state: 'partial'}]})));
vi.mock('../src/plan-data', () => ({planClient: () => ({rpc}), getGmvActuals: gmv}));

import {closeMonthAction, savePlanLineAction, unlockMonthAction} from '../src/plan-actions';

const ok = {month: '2026-09-01', metric: 'marketplace_cogs', amountPhp: 1000, expected: null};

describe('savePlanLineAction', () => {
  beforeEach(() => { session.email = 'a@x.com'; memberships.rows = [{companyId: null, role: 'coop_admin'}]; rpc.mockClear(); rpc.mockResolvedValue({error: null}); revalidatePath.mockClear(); });

  it('a Coop Admin and a Zoomy company admin save through the one RPC with their email', async () => {
    expect(await savePlanLineAction(ok)).toEqual({ok: true});
    expect(rpc).toHaveBeenCalledWith('plan_set_actual', {p_month: '2026-09-01', p_metric: 'marketplace_cogs', p_amount: 1000, p_expected: null, p_by: 'a@x.com'});
    memberships.rows = [{companyId: 'zoomy', role: 'company_admin'}];
    expect((await savePlanLineAction(ok)).ok).toBe(true);
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['a store manager', [{companyId: 'zoomy', role: 'store_manager'}]],
    ['a viewer (analyst)', [{companyId: 'zoomy', role: 'analyst'}]],
    ['another company admin', [{companyId: 'goldline', role: 'company_admin'}]],
    ['a suspended Coop Admin', [{companyId: null, role: 'coop_admin', status: 'suspended'}]],
    ['someone with no membership', []],
  ])('%s calling the action directly gets an error and nothing is written, even with an admin token in the session', async (_n, rows) => {
    memberships.rows = rows;
    const r = await savePlanLineAction(ok);
    expect(r.ok).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it('a signed-out caller gets an error and nothing is written', async () => {
    session.email = null;
    expect((await savePlanLineAction(ok)).ok).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([
    ['non-numeric', {...ok, amountPhp: '12' as unknown as number}],
    ['NaN', {...ok, amountPhp: NaN}],
    ['Infinity', {...ok, amountPhp: Infinity}],
    ['a negative cost', {...ok, amountPhp: -1}],
    ['an unknown line', {...ok, metric: 'revenue'}],
    ['a bad month', {...ok, month: '2026-09-15'}],
    ['a non-numeric expected value', {...ok, expected: 'x' as unknown as number}],
  ])('rejects %s on the server before the RPC', async (_n, input) => {
    expect((await savePlanLineAction(input)).ok).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('0 is a real 0, no line may be negative, and derived rows (cash, CAC, customers, coverage) are refused before the RPC', async () => {
    expect((await savePlanLineAction({...ok, amountPhp: 0})).ok).toBe(true);
    expect((await savePlanLineAction({...ok, amountPhp: -250000})).ok).toBe(false);
    rpc.mockClear();
    for (const metric of ['cash', 'cac', 'customers', 'coverage']) expect((await savePlanLineAction({...ok, metric, amountPhp: 1})).ok, metric).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('ROAS (the optional measure): an editor saves it exactly as typed; a negative is rejected before the RPC; a reader writes nothing', async () => {
    rpc.mockClear();
    expect((await savePlanLineAction({...ok, metric: 'roas', amountPhp: 3.2})).ok).toBe(true);
    expect(rpc).toHaveBeenLastCalledWith('plan_set_actual', expect.objectContaining({p_metric: 'roas', p_amount: 3.2}));
    expect((await savePlanLineAction({...ok, metric: 'roas', amountPhp: -1})).ok).toBe(false);
    expect(rpc).toHaveBeenCalledTimes(1);
    rpc.mockClear();
    memberships.rows = [{companyId: 'zoomy', role: 'analyst'}];
    expect((await savePlanLineAction({...ok, metric: 'roas', amountPhp: 3})).ok).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('a stale write is reported in words and the page is refreshed', async () => {
    rpc.mockResolvedValue({error: {message: 'stale_value'}});
    const r = await savePlanLineAction({...ok, expected: 5});
    expect(r).toMatchObject({ok: false});
    expect((r as {error: string}).error).toMatch(/Someone else changed/);
    expect(revalidatePath).toHaveBeenCalledWith('/health-report');
  });
  it('a closed month is reported in words', async () => {
    rpc.mockResolvedValue({error: {message: 'month_closed'}});
    expect(((await savePlanLineAction(ok)) as {error: string}).error).toMatch(/closed/);
  });
});

describe('closeMonthAction and unlockMonthAction', () => {
  beforeEach(() => { session.email = 'a@x.com'; memberships.rows = [{companyId: null, role: 'coop_admin'}]; rpc.mockClear(); rpc.mockResolvedValue({error: null}); vi.useFakeTimers({toFake: ['Date']}); vi.setSystemTime(new Date('2026-11-05T04:00:00Z')); });
  afterEach(() => vi.useRealTimers());

  const complete = {gmv_events: [{value: 5, state: 'ok'}], gmv_website: [{value: 2, state: 'ok'}], gmv_marketplace: [{value: 1, state: 'ok'}], gmv_total: [{value: 8, state: 'ok'}]};
  it('close takes the GMV snapshot on the server and sends it with the editor email', async () => {
    gmv.mockResolvedValueOnce(complete as never);
    expect(await closeMonthAction({month: '2026-10-01'})).toEqual({ok: true});
    expect(rpc).toHaveBeenCalledWith('plan_close_month', {p_month: '2026-10-01', p_by: 'a@x.com', p_gmv: expect.objectContaining({gmv_events: {value: 5, state: 'ok'}, gmv_total: {value: 8, state: 'ok'}})});
  });
  it('close refuses a month that is not over, even for an admin (the current month), before any snapshot or RPC', async () => {
    const r = await closeMonthAction({month: '2026-11-01'});
    expect(r.ok).toBe(false);
    expect((r as {error: string}).error).toMatch(/not over yet/);
    expect(rpc).not.toHaveBeenCalled();
  });
  it('close refuses a month with a partial or missing GMV channel and names it; the RPC is never called', async () => {
    // the default fake (above) has Website empty and Marketplace partial
    const r = await closeMonthAction({month: '2026-10-01'});
    expect(r.ok).toBe(false);
    expect((r as {error: string}).error).toMatch(/Website data for Oct'26 is not in yet.*Marketplace data for Oct'26 is still partial/);
    expect(rpc).not.toHaveBeenCalled();
    gmv.mockResolvedValueOnce({...complete, gmv_marketplace: [{value: 1, state: 'partial'}]} as never);
    expect((await closeMonthAction({month: '2026-10-01'})).ok).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });
  it('unlock needs a reason: blank is rejected before the RPC', async () => {
    for (const reason of ['', '   ']) expect((await unlockMonthAction({month: '2026-10-01', reason})).ok).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
    expect(await unlockMonthAction({month: '2026-10-01', reason: ' late refund '})).toEqual({ok: true});
    expect(rpc).toHaveBeenCalledWith('plan_unlock_month', {p_month: '2026-10-01', p_reason: 'late refund', p_by: 'a@x.com'});
  });
  it.each([
    ['a store manager', [{companyId: 'zoomy', role: 'store_manager'}]],
    ['a viewer', [{companyId: 'zoomy', role: 'analyst'}]],
    ['no membership', []],
  ])('%s can neither close nor unlock', async (_n, rows) => {
    memberships.rows = rows;
    expect((await closeMonthAction({month: '2026-10-01'})).ok).toBe(false);
    expect((await unlockMonthAction({month: '2026-10-01', reason: 'x'})).ok).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });
  it('signed out can neither', async () => {
    session.email = null;
    expect((await closeMonthAction({month: '2026-10-01'})).ok).toBe(false);
    expect((await unlockMonthAction({month: '2026-10-01', reason: 'x'})).ok).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });
  it('the RPC codes month_not_over and gmv_incomplete are reported in words', async () => {
    gmv.mockResolvedValue(complete as never);
    rpc.mockResolvedValue({error: {message: 'month_not_over'}});
    expect(((await closeMonthAction({month: '2026-10-01'})) as {error: string}).error).toMatch(/not over yet/);
    rpc.mockResolvedValue({error: {message: 'gmv_incomplete'}});
    expect(((await closeMonthAction({month: '2026-10-01'})) as {error: string}).error).toMatch(/Marketplace, Website and Events/);
  });
  it('an incomplete month is reported in words', async () => {
    gmv.mockResolvedValue(complete as never);
    rpc.mockResolvedValue({error: {message: 'month_incomplete'}});
    expect(((await closeMonthAction({month: '2026-10-01'})) as {error: string}).error).toMatch(/every typed line/);
  });
});
