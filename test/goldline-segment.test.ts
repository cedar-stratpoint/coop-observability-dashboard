import {describe, expect, it} from 'vitest';
import {
  canonicalPeriod,
  clampPage,
  duplicatePages,
  FORM_FLAGS,
  formKey,
  groupIntoForms,
  segmentBundle,
  normalizeKind,
  normalizeOrientation,
  normalizeStoreCode,
  normalizeVersion,
  periodBucket,
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
  it('canonicalPeriod keeps the verbatim dates for display', () => {
    expect(canonicalPeriod('2026-09-09', '2026-09-15')).toBe('2026-09-09..2026-09-15');
    expect(canonicalPeriod(null, null)).toBe('unknown-period');
  });
  it('periodBucket groups a partial and the standard cut-off together (half-month)', () => {
    expect(periodBucket('2026-09-09', '2026-09-15')).toBe('2026-09-H1');
    expect(periodBucket('2026-09-01', '2026-09-15')).toBe('2026-09-H1');
    expect(periodBucket('2026-09-16', '2026-09-30')).toBe('2026-09-H2');
    expect(periodBucket('2026-09-16', '2026-09-31')).toBe('2026-09-H2'); // invalid day still buckets
    expect(periodBucket(null, null)).toBe('unknown-period');
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

describe('segmentBundle', () => {
  it('sorts a shuffled, rotated, multi-store set into forms + parked pages', () => {
    const pages = [
      page({id: 'a', page: 2}),
      page({id: 'b', page: 1, orientation: 180}), // upside-down still groups
      page({id: 'c', page: 1}), // duplicate of page 1
      page({id: 'd', kind: 'sales', page: 6}), // parked, no junk form
      page({id: 'e', kind: 'blank', page: 0}), // dropped
      page({id: 'u', kind: 'inventory', page: 0}), // form-like but unnumbered
      page({
        id: 'f',
        store_code: '5300',
        consultant: 'Sofia',
        period_start: '2026-09-09',
        period_end: '2026-09-15',
        page: 3,
      }),
    ];
    const {forms, sales, blanks, unplaceable} = segmentBundle(pages);
    // Two real forms only — the sales page does NOT create a third "unknown" group.
    expect(forms.length).toBe(2);
    expect(sales.map((p) => p.id)).toEqual(['d']);
    expect(blanks.map((p) => p.id)).toEqual(['e']);
    expect(unplaceable.map((p) => p.id)).toEqual(['u']);

    const leon = forms.find((g) => g.store_code === '473')!;
    expect(leon.present).toEqual([1, 2]);
    expect(leon.missing).toEqual([3, 4, 5]);
    expect(leon.duplicates.map((d) => d.page)).toEqual([1]);
    expect(leon.duplicates[0].ids.slice().sort()).toEqual(['b', 'c']);
    expect(leon.flags).toContain(FORM_FLAGS.duplicatePages);
    expect(leon.flags).toContain(FORM_FLAGS.incomplete);

    const sofia = forms.find((g) => g.store_code === '5300')!;
    expect(sofia.present).toEqual([3]);
    expect(sofia.flags).toContain(FORM_FLAGS.periodPartial);
  });
});

describe('groupIntoForms', () => {
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

  it('merges a partial-date misread into the same form (half-month key)', () => {
    // Real case: Sofia #5300 v1, one page read "09-01..15", another "09-09..15".
    const forms = groupIntoForms([
      page({id: 'p1', store_code: '5300', version: 'v1', page: 1, period_start: '2026-09-01', period_end: '2026-09-15'}),
      page({id: 'p2', store_code: '5300', version: 'v1', page: 2, period_start: '2026-09-09', period_end: '2026-09-15'}),
    ]);
    expect(forms.length).toBe(1);
    expect(forms[0].present).toEqual([1, 2]);
    expect(forms[0].flags).toContain(FORM_FLAGS.periodMismatch); // disagreement surfaced
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
