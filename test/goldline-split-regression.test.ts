import {describe, expect, it} from 'vitest';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {assignBlankFormRuns, reconcileYears, segmentBundle, type ClassifiedPage} from '../src/goldline-segment';

// Real data from Nichido Staging batch e896d60b (Scan2026-10-30_171554) — the 61-sheet
// pile a reviewer opened as "one store's form". Store codes are the values already snapped
// to the registry (classification.store_snap.code), so this reproduces what the splitter
// groups on without re-snapping. The year is left raw; reconcileYears repairs it below.
type Row = {
  ord: number;
  scan_sheet: number;
  page_no: number;
  page_kind: string;
  orientation: number;
  form_version: string;
  snap_code: string | null;
  store_code: string | null;
  store_name: string | null;
  period_start: string | null;
  period_end: string | null;
  confidence: number;
  status: string;
};

const rows: Row[] = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/batch-e896d60b.json', import.meta.url)), 'utf8'));

const toPage = (r: Row): ClassifiedPage => ({
  id: `s${r.ord}`,
  page: r.page_no,
  kind: r.page_kind as ClassifiedPage['kind'],
  orientation: r.orientation === 180 ? 180 : 0,
  version: r.form_version as ClassifiedPage['version'],
  store_code: r.snap_code ?? r.store_code,
  store_name: r.store_name,
  period_start: r.period_start,
  period_end: r.period_end,
  consultant: null,
  confidence: r.confidence,
});

// CHARACTERIZATION of the defect (not the desired end state): feeding this real pile
// through the exact grouping the splitter uses shows it does NOT resolve into a store's
// form. It shatters into dozens of one-sheet "forms" because the printed stores are mostly
// unreadable and the versions/periods disagree. Whatever hardening we ship should make a
// pile like this read as "needs sorting", not present it as one commitable form — update
// these assertions when that lands.
describe('batch e896d60b segmentation (real-data characterization)', () => {
  const pages = reconcileYears(assignBlankFormRuns(rows.map(toPage)));
  const {forms, sales, blanks, unplaceable} = segmentBundle(pages);

  it('partitions the 61 sheets into 14 sales + 14 blanks + 33 inventory (no unplaceable)', () => {
    expect(sales.length).toBe(14);
    expect(blanks.length).toBe(14);
    expect(unplaceable.length).toBe(0);
    expect(forms.flatMap((g) => g.slots.flatMap((s) => s.ids)).length).toBe(33);
  });

  it('shatters the 33 inventory sheets into dozens of tiny forms, none a complete 5-page form', () => {
    expect(forms.length).toBeGreaterThanOrEqual(25); // ~32 today: one group per noisy read
    const singleSheet = forms.filter((g) => g.slots.flatMap((s) => s.ids).length === 1);
    expect(singleSheet.length).toBeGreaterThanOrEqual(25);
    const maxPages = Math.max(...forms.map((g) => g.present.length));
    expect(maxPages).toBeLessThan(5); // nothing cohered into a real 1..5 form
  });

  it('spreads the sheets across many stores (the review screen must not call this one form)', () => {
    const codes = new Set(forms.map((g) => g.store_code).filter(Boolean));
    expect(codes.size).toBeGreaterThanOrEqual(3); // 854, 173, 877, WATSON, Watsons 004, …
    const versions = new Set(forms.map((g) => g.version));
    expect(versions.size).toBeGreaterThanOrEqual(3); // v1, v2, legacy all present
  });
});
