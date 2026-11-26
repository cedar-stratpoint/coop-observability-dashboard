import {describe, expect, it} from 'vitest';
import {inheritFormStores, segmentBundle, type ClassifiedPage, type StoreSnap} from '../src/goldline-segment';
import {storeCheckNote} from '../src/store-check-note';

// QA Nov 26: "Lee Plaza Dipolog" wrote 1325 on page 1 only; pages 2 to 5 read no code and the
// name alone suggested the wrong store (2596). A page takes the code its own form read.
type P = ClassifiedPage & {file: string};
let n = 0;
const page = (file: string, pg: number, snap: StoreSnap | null, version: ClassifiedPage['version'] = 'v2'): P => ({
  id: `u${++n}`, file, page: pg, kind: 'inventory', orientation: 0, version,
  store_code: snap?.code ?? null, store_snap: snap ?? undefined,
  period_start: '2026-10-16', period_end: '2026-10-31', consultant: null, confidence: 0.9,
});
const at = (p: P) => {
  const m = /^(.*) \(page (\d+) of \d+\)\.pdf$/.exec(p.file);
  return m ? {source: m[1], index: Number(m[2])} : null;
};
const f = (i: number) => `Scan2026-11-20_114605 (page ${i} of 35).pdf`;
const missing: StoreSnap = {code: null, status: 'missing'};

describe('inheritFormStores', () => {
  it('pages with no code take the code page 1 of their form read', () => {
    const pages = [page(f(7), 1, {code: '1325', status: 'exact'}), page(f(8), 2, missing), page(f(9), 3, missing), page(f(10), 4, {code: null, status: 'missing', candidates: ['2596']}), page(f(11), 5, missing)];
    const out = inheritFormStores(pages, at);
    expect(out.map((p) => p.store_code)).toEqual(['1325', '1325', '1325', '1325', '1325']);
    expect(out[3].store_snap).toEqual({code: '1325', status: 'from_form', fromPage: 1}); // the form beats the name's 2596
    expect(out[0].store_snap?.status).toBe('exact');
  });
  it('a later page can lend its code backwards, and an unmatched or name-agreeing code is replaced', () => {
    const pages = [
      page(f(24), 1, {code: '296', status: 'exact'}),
      page(f(25), 2, {code: '896', status: 'ambiguous', candidates: ['296', '96']}),
      page(f(26), 3, {code: '296', status: 'exact'}),
      page(f(27), 4, {code: '1296', status: 'name_mismatch', candidates: ['296']}),
    ];
    const out = inheritFormStores(pages, at);
    expect(out[1].store_snap).toEqual({code: '296', status: 'from_form', from: '896', fromPage: 1});
    expect(out[3].store_code).toBe('296');
  });
  it('a real code is never overwritten; two codes in one form fill nothing and flag the form', () => {
    const pages = [page(f(1), 1, {code: '317', status: 'exact'}), page(f(2), 2, missing), page(f(3), 3, {code: '481', status: 'exact'})];
    const out = inheritFormStores(pages, at);
    expect(out.map((p) => p.store_code)).toEqual(['317', null, '481']);
    expect(out.every((p) => p.form_store_conflict)).toBe(true);
    const flags = segmentBundle(out).forms.flatMap((g) => g.flags);
    expect(flags).toContain('store-form-conflict');
  });
  it('a name pointing elsewhere is left for the reviewer', () => {
    const pages = [page(f(1), 1, {code: '2414', status: 'exact'}), page(f(2), 2, {code: '2415', status: 'name_mismatch', candidates: ['9999']})];
    expect(inheritFormStores(pages, at)[1].store_code).toBe('2415');
  });
  it('a new form starts when the page number drops, the version changes, or the scan changes', () => {
    const pages = [
      page(f(1), 1, {code: '1334', status: 'exact'}),
      page(f(2), 2, missing),
      page(f(3), 1, missing), // page number reset: another form
      page(f(4), 2, missing, 'v1'),
      page('Other (page 5 of 9).pdf', 3, missing), // another scan
      page('loose.pdf', 2, missing), // no scan position: untouched
    ];
    const out = inheritFormStores(pages, at);
    expect(out.map((p) => p.store_code)).toEqual(['1334', '1334', null, null, null, null]);
  });
  it('orders by scan position, not input order', () => {
    const pages = [page(f(9), 3, missing), page(f(7), 1, {code: '1325', status: 'exact'}), page(f(8), 2, missing)];
    expect(inheritFormStores(pages, at).map((p) => p.store_code)).toEqual(['1325', '1325', '1325']);
  });
  it('the board groups the filled pages into one store form, flagged "store from the form"', () => {
    const pages = [page(f(13), 1, {code: '1334', status: 'exact'}), page(f(14), 2, missing), page(f(15), 3, missing)];
    const {forms} = segmentBundle(inheritFormStores(pages, at));
    expect(forms).toHaveLength(1);
    expect(forms[0].store_code).toBe('1334');
    expect(forms[0].flags).toContain('store-from-form');
  });
});

describe('storeCheckNote from_form', () => {
  const nameOf = (c: string) => ({'1325': 'Lee Plaza City Centr', '296': 'Maria Cristina Rosit'})[c] ?? null;
  it('says where the store came from, with an undo when a code was read', () => {
    expect(storeCheckNote({status: 'from_form', from: null, by: null, candidates: [], fromPage: 1}, '1325', nameOf)).toEqual({
      text: 'No store code is written on this page. Coop used 1325 · Lee Plaza City Centr from page 1 of this same form.',
      action: null,
    });
    const n = storeCheckNote({status: 'from_form', from: '896', by: null, candidates: [], fromPage: 1}, '296', nameOf);
    expect(n?.text).toBe('Coop read 896 on this page, which isn’t a known store, so it used 296 · Maria Cristina Rosit from page 1 of this same form.');
    expect(n?.action).toEqual({label: 'Undo, use 896', code: '896'});
    expect(n?.text).not.toMatch(/[–—]/);
  });
});

describe('inheritFormStores: one period per form', () => {
  it('pages with no period take the one most of the form read; a tie fills nothing', () => {
    const a = page(f(13), 1, {code: '1334', status: 'exact'});
    const b = {...page(f(14), 2, missing), period_start: null, period_end: null};
    const out = inheritFormStores([a, b], at);
    expect(out[1]).toMatchObject({period_start: '2026-10-16', period_end: '2026-10-31', period_from_form: true});
    const c = {...page(f(15), 3, missing), period_start: '2026-11-01', period_end: '2026-11-15'};
    const d = {...page(f(16), 4, missing), period_start: null, period_end: null};
    const out2 = inheritFormStores([a, c, d], at); // 1 vs 1: a tie
    expect(out2[2].period_start).toBeNull();
    const e = page(f(17), 5, missing); // a second 2026-10-16 read breaks the tie
    expect(inheritFormStores([a, c, d, e], at)[2].period_start).toBe('2026-10-16');
  });
});
