import {describe, expect, it} from 'vitest';
import {
  canonicalPeriod,
  clampPage,
  duplicatePages,
  FORM_FLAGS,
  formKey,
  groupIntoForms,
  normalizeKind,
  normalizeOrientation,
  normalizeStoreCode,
  normalizeVersion,
  periodFlags,
  sanitizeClassification,
  type ClassifiedPage,
} from '../src/goldline-segment';

const page = (p: Partial<ClassifiedPage> & {id: string}): ClassifiedPage => ({
  page: 1,
  kind: 'inventory',
  orientation: 0,
  version: 'v1',
  store_code: '473',
  store_name: null,
  period_start: '2026-09-16',
  period_end: '2026-09-30',
  consultant: 'Leonisa',
  confidence: 0.9,
  ...p,
});

describe('normalizers', () => {
  it('coerces unknown version/kind', () => {
    expect(normalizeVersion('v2')).toBe('v2');
    expect(normalizeVersion('legacy')).toBe('legacy');
    expect(normalizeVersion('v9')).toBe('unknown');
    expect(normalizeVersion(null)).toBe('unknown');
    expect(normalizeKind('sales')).toBe('sales');
    expect(normalizeKind('weird')).toBe('unknown');
  });
  it('orientation is only 0 or 180', () => {
    expect(normalizeOrientation(180)).toBe(180);
    expect(normalizeOrientation('180')).toBe(180);
    expect(normalizeOrientation(90)).toBe(0);
    expect(normalizeOrientation(0)).toBe(0);
  });
  it('clamps page to 0–6', () => {
    expect(clampPage(3)).toBe(3);
    expect(clampPage(9)).toBe(0);
    expect(clampPage(-1)).toBe(0);
    expect(clampPage('2')).toBe(2);
    expect(clampPage('x')).toBe(0);
  });
  it('normalizes store codes', () => {
    expect(normalizeStoreCode('#473')).toBe('473');
    expect(normalizeStoreCode('  5300 ')).toBe('5300');
    expect(normalizeStoreCode('')).toBeNull();
    expect(normalizeStoreCode(null)).toBeNull();
  });
});

describe('period', () => {
  it('keeps a partial cut-off distinct from the standard one (no collapse)', () => {
    expect(canonicalPeriod('2026-09-09', '2026-09-15')).not.toBe(canonicalPeriod('2026-09-01', '2026-09-15'));
  });
  it('flags clean / partial / invalid-day / missing / unparsed', () => {
    expect(periodFlags('2026-09-01', '2026-09-15')).toEqual([]);
    expect(periodFlags('2026-09-16', '2026-09-30')).toEqual([]);
    expect(periodFlags('2026-09-09', '2026-09-15')).toContain(FORM_FLAGS.periodPartial);
    expect(periodFlags('2026-09-16', '2026-09-31')).toContain(FORM_FLAGS.periodInvalidDay);
    expect(periodFlags(null, '2026-09-15')).toEqual([FORM_FLAGS.periodMissing]);
    expect(periodFlags('nope', 'nope')).toEqual([FORM_FLAGS.periodUnparsed]);
  });
});

describe('groupIntoForms', () => {
  it('sorts a shuffled, rotated, multi-store set into forms', () => {
    const pages = [
      page({id: 'a', page: 2}),
      page({id: 'b', page: 1, orientation: 180}), // upside-down still groups
      page({id: 'c', page: 1}), // duplicate of page 1
      page({id: 'd', kind: 'sales', page: 6}), // parked
      page({id: 'e', kind: 'blank', page: 0}), // dropped
      page({
        id: 'f',
        store_code: '5300',
        consultant: 'Sofia',
        period_start: '2026-09-09',
        period_end: '2026-09-15',
        page: 3,
      }),
    ];
    const forms = groupIntoForms(pages);
    expect(forms.length).toBe(2);

    const leon = forms.find((g) => g.store_code === '473')!;
    expect(leon.present).toEqual([1, 2]);
    expect(leon.missing).toEqual([3, 4, 5]);
    expect(leon.duplicates.map((d) => d.page)).toEqual([1]);
    expect(leon.duplicates[0].ids.slice().sort()).toEqual(['b', 'c']);
    expect(leon.salesIds).toEqual(['d']);
    expect(leon.blankIds).toEqual(['e']);
    expect(leon.flags).toContain(FORM_FLAGS.duplicatePages);
    expect(leon.flags).toContain(FORM_FLAGS.incomplete);

    const sofia = forms.find((g) => g.store_code === '5300')!;
    expect(sofia.present).toEqual([3]);
    expect(sofia.flags).toContain(FORM_FLAGS.periodPartial);
  });

  it('flags unknown store and version', () => {
    const forms = groupIntoForms([page({id: 'x', store_code: null, version: 'unknown', page: 1})]);
    expect(forms[0].flags).toContain(FORM_FLAGS.unknownStore);
    expect(forms[0].flags).toContain(FORM_FLAGS.unknownVersion);
  });

  it('keeps same store/period but different version as separate forms', () => {
    const forms = groupIntoForms([
      page({id: 'v1', version: 'v1', page: 1}),
      page({id: 'v2', version: 'v2', page: 1}),
    ]);
    expect(forms.length).toBe(2);
    expect(formKey(forms[0]) === formKey(forms[1])).toBe(false);
  });
});

describe('duplicatePages', () => {
  it('lists every duplicated inventory page by key', () => {
    const dups = duplicatePages([page({id: 'a', page: 1}), page({id: 'b', page: 1}), page({id: 'c', page: 2})]);
    expect(dups.length).toBe(1);
    expect(dups[0].page).toBe(1);
    expect(dups[0].ids.slice().sort()).toEqual(['a', 'b']);
  });
});

describe('sanitizeClassification', () => {
  it('coerces garbage to safe defaults, never throws', () => {
    const c = sanitizeClassification({page: 99, kind: 'nope', orientation: 90, version: 'v7', store_code: 42, confidence: 5});
    expect(c.page).toBe(0);
    expect(c.kind).toBe('unknown');
    expect(c.orientation).toBe(0);
    expect(c.version).toBe('unknown');
    expect(c.store_code).toBeNull();
    expect(c.confidence).toBe(1);
  });
  it('passes a good read through, trimming the store code', () => {
    const c = sanitizeClassification({
      page: 3,
      kind: 'inventory',
      orientation: 180,
      version: 'v2',
      store_code: '#473 ',
      period_start: '2026-09-16',
      period_end: '2026-09-30',
      consultant: 'Leonisa',
      confidence: 0.8,
    });
    expect(c).toMatchObject({page: 3, kind: 'inventory', orientation: 180, version: 'v2', store_code: '473', confidence: 0.8});
  });
});
