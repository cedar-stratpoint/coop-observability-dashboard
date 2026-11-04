import {describe, expect, it} from 'vitest';
import {
  applyStoreRegistry,
  canonicalPeriod,
  clampPage,
  duplicatePages,
  editDistance,
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
  dominantYear,
  reconcileYears,
  sanitizeClassification,
  snapStoreCode,
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
  it('strips a DS store-type prefix so "DS 5300" keys as "5300"', () => {
    expect(normalizeStoreCode('DS 5300')).toBe('5300');
    expect(normalizeStoreCode('DS-5300')).toBe('5300');
    expect(normalizeStoreCode('ds5300')).toBe('5300');
    // Not a DS-prefixed numeric code: left alone.
    expect(normalizeStoreCode('SM STA MESA')).toBe('SM STA MESA');
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

describe('year reconciliation', () => {
  const cp = (p: Partial<ClassifiedPage> & {id: string}): ClassifiedPage => page(p);
  it('dominantYear picks the clear plurality, null on a tie', () => {
    expect(dominantYear([{period_start: '2026-09-01', period_end: '2026-09-15'}, {period_start: '2020-09-01', period_end: '2020-09-15'}, {period_start: '2026-09-16', period_end: '2026-09-30'}])).toBe(2026);
    expect(dominantYear([{period_start: '2026-09-01', period_end: null}, {period_start: '2025-09-01', period_end: null}])).toBeNull(); // 1 vs 1 tie
    expect(dominantYear([])).toBeNull();
  });
  it('snaps an outlier year to the dominant one, keeping month/day, and marks it', () => {
    const out = reconcileYears([
      cp({id: 'a', period_start: '2026-09-01', period_end: '2026-09-15'}),
      cp({id: 'b', period_start: '2026-09-16', period_end: '2026-09-30'}),
      cp({id: 'c', period_start: '2020-09-01', period_end: '2020-09-15'}),
    ]);
    const snapped = out.find((p) => p.id === 'c')!;
    expect(snapped.period_start).toBe('2026-09-01');
    expect(snapped.period_end).toBe('2026-09-15');
    expect(snapped.year_snapped).toEqual({from: 2020, to: 2026});
    expect(out.find((p) => p.id === 'a')!.year_snapped).toBeUndefined();
  });
  it('is a no-op when there is no clear dominant year', () => {
    const inp = [cp({id: 'a', period_start: '2026-09-01', period_end: '2026-09-15'}), cp({id: 'b', period_start: '2025-09-01', period_end: '2025-09-15'})];
    expect(reconcileYears(inp).some((p) => p.year_snapped)).toBe(false);
  });
  it('a reconciled page groups into the real year form and flags it', () => {
    const forms = groupIntoForms(reconcileYears([
      page({id: 'a', store_code: '473', version: 'v1', page: 1, period_start: '2026-09-01', period_end: '2026-09-15'}),
      page({id: 'b', store_code: '473', version: 'v1', page: 2, period_start: '2026-09-16', period_end: '2026-09-30'}),
      page({id: 'c', store_code: '473', version: 'v1', page: 3, period_start: '2020-09-01', period_end: '2020-09-15'}),
    ]));
    // 473 · 2026-09-H1 now holds pages 1 and 3 (the 2020 misread snapped in), flagged.
    const h1 = forms.find((g) => g.present.includes(1) && g.present.includes(3))!;
    expect(h1).toBeDefined();
    expect(h1.flags).toContain(FORM_FLAGS.yearReconciled);
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

describe('snapStoreCode', () => {
  const known = ['473', '5300', '891', '854'];
  it('trusts an exact known code', () => {
    expect(snapStoreCode('473', known)).toMatchObject({code: '473', status: 'exact'});
    expect(snapStoreCode('#473 ', known)).toMatchObject({code: '473', status: 'exact'});
  });
  it('auto-corrects a unique near miss (the real validation case)', () => {
    expect(snapStoreCode('472', known)).toMatchObject({code: '473', status: 'corrected', from: '472'});
    expect(snapStoreCode('173', known)).toMatchObject({code: '473', status: 'corrected', from: '173'});
  });
  it('does NOT override a candidate that is itself a valid store', () => {
    expect(snapStoreCode('854', known)).toMatchObject({code: '854', status: 'exact'});
  });
  it('leaves an ambiguous near miss for the reviewer', () => {
    // equidistant from two known codes → ambiguous, keep raw, offer candidates
    const r = snapStoreCode('5301', ['5300', '5302']);
    expect(r.status).toBe('ambiguous');
    expect(r.code).toBe('5301');
    expect(r.candidates).toEqual(expect.arrayContaining(['5300', '5302']));
  });
  it('reports unknown when nothing is close', () => {
    expect(snapStoreCode('9999', known).status).toBe('unknown');
  });
  it('is a no-op with an empty registry and handles missing', () => {
    expect(snapStoreCode('473', [])).toMatchObject({code: '473', status: 'unknown'});
    expect(snapStoreCode(null, known)).toMatchObject({code: null, status: 'missing'});
  });
  it('editDistance basics', () => {
    expect(editDistance('473', '472')).toBe(1);
    expect(editDistance('473', '473')).toBe(0);
    expect(editDistance('', 'ab')).toBe(2);
  });
});

describe('applyStoreRegistry + grouping', () => {
  it('merges a misread store into the real form and flags the correction', () => {
    const known = ['473'];
    const pages = applyStoreRegistry(
      [
        page({id: 'a', store_code: '473', page: 1}),
        page({id: 'b', store_code: '472', page: 2}), // misread of 473
      ],
      known,
    );
    const forms = groupIntoForms(pages);
    expect(forms.length).toBe(1);
    expect(forms[0].store_code).toBe('473');
    expect(forms[0].present).toEqual([1, 2]);
    expect(forms[0].flags).toContain(FORM_FLAGS.storeCorrected);
  });
  it('flags an unmatched store but still groups it', () => {
    const pages = applyStoreRegistry([page({id: 'a', store_code: '9999', page: 1})], ['473']);
    const forms = groupIntoForms(pages);
    expect(forms[0].store_code).toBe('9999');
    expect(forms[0].flags).toContain(FORM_FLAGS.storeUnmatched);
  });
  it('collapses a "DS 5300" / "5360" drift into the real "5300" form', () => {
    const known = ['5300'];
    const pages = applyStoreRegistry(
      [
        page({id: 'a', store_code: '5300', page: 1}),
        page({id: 'b', store_code: 'DS 5300', page: 2}), // store-type prefix
        page({id: 'c', store_code: '5360', page: 3}), // one-digit misread
      ],
      known,
    );
    const forms = groupIntoForms(pages);
    expect(forms.length).toBe(1);
    expect(forms[0].store_code).toBe('5300');
    expect(forms[0].present).toEqual([1, 2, 3]);
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
