import {beforeEach, describe, expect, it, vi} from 'vitest';

// Scope-down rule: the plan is FIXED targets from the workbook. Only targets that are workbook inputs may be edited, and never when the edit would leave a derived
// target (CM, EBITDA, cash, coverage, customers, CAC) silently out of date, because Coop does not recalculate the plan. The action enforces it; the page greys the cell with the reason.
const session = vi.hoisted(() => ({email: 'a@x.com' as string | null}));
const rpc = vi.hoisted(() => vi.fn(async () => ({error: null as null | {message: string}})));
vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({revalidatePath: vi.fn(), updateTag: vi.fn(), unstable_cache: (f: unknown) => f}));
vi.mock('@/auth', () => ({auth: async () => (session.email ? {user: {email: session.email}} : null)}));
vi.mock('@/src/dev-auth', () => ({devSessionWithMemberships: () => null}));
vi.mock('@/src/company', async () => ({...(await vi.importActual<typeof import('../src/company')>('../src/company')), fetchMemberships: async () => [{companyId: null, role: 'coop_admin'}]}));
vi.mock('../src/plan-data', () => ({planClient: () => ({rpc}), getGmvActuals: vi.fn(), PLAN_TAG: 'plan-report'}));

import {editTargetsAction} from '../src/plan-actions';
import {METRICS, metricStatus, targetEditable, targetLock} from '../src/plan-compute';

const DERIVED = ['cm1', 'cm1_pct', 'cm2', 'cm2_pct', 'cm3', 'cm3_pct', 'ebitda', 'ebitda_pct', 'cash', 'coverage', 'cac', 'customers'];

describe('targetLock', () => {
  it.each(DERIVED)('%s is derived: locked, with a plain reason', (id) => {
    const l = targetLock(id);
    expect(l.locked).toBe(true);
    expect((l as {reason: string}).reason).toMatch(/calculated/i);
    expect(targetEditable('2027-01-01', id, '2026-11', {})).toBe(false);
  });
  it('Total GMV is locked: it is the sum of its channels', () => {
    expect(targetLock('gmv_total')).toEqual({locked: true, reason: expect.stringMatching(/sum of the three channels/i)});
  });
  it.each(['gmv_events', 'gmv_website', 'gmv_marketplace', 'overhead', 'roas'])('input %s is locked while its edit would leave derived targets stale, and says which', (id) => {
    const l = targetLock(id) as {locked: true; reason: string};
    expect(l.locked).toBe(true);
    expect(l.reason).toMatch(/out of date/);
    expect(l.reason).toMatch(/EBITDA/);
    expect(targetEditable('2027-01-01', id, '2026-11', {})).toBe(false);
  });
  it('an unknown metric is locked too', () => expect(targetLock('nope').locked).toBe(true));
});

describe('editTargetsAction refuses a locked target before the RPC', () => {
  beforeEach(() => { session.email = 'a@x.com'; rpc.mockClear(); });
  it.each([...DERIVED, 'gmv_events', 'gmv_marketplace', 'overhead', 'roas'])('%s', async (metric) => {
    const r = await editTargetsAction({changes: [{month: '2027-01-01', metric, value: 1}], reason: 'why', expectedVersion: 1});
    expect(r.ok).toBe(false);
    expect((r as {error: string}).error).toMatch(/calculated|out of date/i);
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe('customers and CAC are modelled: shown beside their target, never red or green', () => {
  it('are flagged and say so', () => {
    for (const id of ['customers', 'cac']) {
      const m = METRICS.find((x) => x.id === id)!;
      expect(m.modelled).toBe(true);
      expect(m.hint).toMatch(/modelled from plan assumptions/);
    }
    expect(METRICS.filter((m) => m.modelled).map((m) => m.id).sort()).toEqual(['cac', 'customers']);
  });
  it('metricStatus: a modelled value in a past month is "modelled", whether above or below target; empty still waits; the month in progress stays live', () => {
    const base = {actual: 900, target: 400, phase: 'past' as const, hasSource: true, modelled: true};
    expect(metricStatus({...base, direction: 'higher'})).toBe('modelled');
    expect(metricStatus({...base, direction: 'higher', actual: 100})).toBe('modelled');
    expect(metricStatus({...base, direction: 'lower'})).toBe('modelled');
    expect(metricStatus({...base, direction: 'lower', actual: null})).toBe('waiting');
    expect(metricStatus({...base, direction: 'lower', phase: 'current'})).toBe('live');
  });
});
