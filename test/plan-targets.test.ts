import {describe, expect, it} from 'vitest';
import {assemblePlan, overlayClosedTargets, parseTargetInput, targetEditable, targetInputText, targetLock, type ClosedMonth, type PlanData} from '../src/plan-compute';

const plan = (): PlanData => ({...assemblePlan('v2', [
  {month: '2026-10-01', metric: 'gmv_events', value: 200}, {month: '2026-11-01', metric: 'gmv_events', value: 300},
]), versionId: 5});
const closed = (planVersion: number): ClosedMonth => ({by: 'a@x.com', at: '2026-11-01T00:00:00Z', planVersion, gmv: {}});

describe('parseTargetInput / targetInputText', () => {
  it('money is typed in thousands and stored in pesos', () => {
    expect(parseTargetInput('php', '1,250.5')).toEqual({ok: true, value: 1250500});
    expect(targetInputText('php', 1250500)).toBe('1250.5');
  });
  it('percentages are typed as percent and stored as a ratio', () => {
    expect(parseTargetInput('pct', '65.5')).toEqual({ok: true, value: 0.655});
    expect(targetInputText('pct', 0.655)).toBe('65.5');
  });
  it('x, pesos, counts and months are plain numbers', () => {
    expect(parseTargetInput('x', '2.5')).toEqual({ok: true, value: 2.5});
    expect(parseTargetInput('peso', '120')).toEqual({ok: true, value: 120});
    expect(targetInputText('count', 480)).toBe('480');
  });
  it('blank and non-numbers are not a target (a target cannot be cleared)', () => {
    for (const u of ['php', 'pct', 'x', 'peso', 'count', 'months'] as const) { expect(parseTargetInput(u, '')).toEqual({ok: false}); expect(parseTargetInput(u, 'abc')).toEqual({ok: false}); }
  });
});

describe('targetEditable', () => {
  it('never Total GMV or a locked row (see plan-target-lock.test.ts): today every target is locked, so no cell is editable', () => {
    expect(targetEditable('2026-11-01', 'gmv_events', '2026-11', {})).toBe(false);
    expect(targetEditable('2027-01-01', 'gmv_total', '2026-11', {})).toBe(false);
    expect(targetEditable('2027-01-01', 'cash', '2026-11', {})).toBe(false);
  });
});

describe('overlayClosedTargets', () => {
  it('a closed month reads the target of the version it closed under; open months keep the newest', () => {
    const out = overlayClosedTargets(plan(), {'2026-10-01': closed(3)}, [{plan_version: 3, month: '2026-10-01', metric: 'gmv_events', value: 150}]);
    expect(out.targets.gmv_events).toEqual([150, 300]);
  });
  it('does nothing when the month closed under the newest version, and never mutates its input', () => {
    const p = plan();
    expect(overlayClosedTargets(p, {'2026-10-01': closed(5)}, []).targets.gmv_events).toEqual([200, 300]);
    overlayClosedTargets(p, {'2026-10-01': closed(3)}, [{plan_version: 3, month: '2026-10-01', metric: 'gmv_events', value: 1}]);
    expect(p.targets.gmv_events).toEqual([200, 300]);
  });
  it('a cell the old version did not have stays as it was (never invented)', () => {
    expect(overlayClosedTargets(plan(), {'2026-10-01': closed(3)}, []).targets.gmv_events).toEqual([200, 300]);
  });
});
