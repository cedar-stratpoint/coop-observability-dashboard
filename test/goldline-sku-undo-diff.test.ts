import {describe, expect, it} from 'vitest';
import {diffSnaps, driftedRows, norm, undoEffectGroups, undoEffects, type Snap} from '../src/goldline-sku-undo-diff';

const empty = (): Snap => ({products: {}, chain: {}, review: {}, notes: {}});

describe('SKU linking undo diff', () => {
  it('keeps only changed rows, before and after', () => {
    const b = empty();
    const a = empty();
    b.products = {PEP092: {sku_code: null}, MUBBEP: {sku_code: '70075146'}};
    a.products = {PEP092: {sku_code: '38006200'}, MUBBEP: {sku_code: '70075146'}};
    b.chain = {'38006200': {suggested_item_code: 'PEP092', match_tier: 'low', dismissed_item_codes: []}};
    a.chain = {'38006200': {suggested_item_code: null, match_tier: null, dismissed_item_codes: []}};
    const d = diffSnaps(b, a);
    expect(d.changed).toBe(2);
    expect(Object.keys(d.before.products)).toEqual(['PEP092']);
    expect(d.after.chain['38006200']).toMatchObject({suggested_item_code: null});
  });

  it('treats numeric strings, reordered arrays and timestamp formats as equal', () => {
    expect(norm({match_score: '0.82'})).toBe(norm({match_score: 0.82}));
    expect(norm({d: ['B', 'A']})).toBe(norm({d: ['A', 'B']}));
    expect(norm({t: '2026-10-28T05:43:56.55+00:00'})).toBe(norm({t: '2026-10-28T05:43:56.550Z'}));
  });

  it('flags rows that changed again after the decision', () => {
    const after = empty();
    after.products = {PEP092: {sku_code: '38006200'}};
    const current = empty();
    current.products = {PEP092: {sku_code: null}};
    expect(driftedRows(after, current)).toEqual(['products:PEP092']);
    current.products = {PEP092: {sku_code: '38006200'}};
    expect(driftedRows(after, current)).toEqual([]);
  });

  it('explains undoing an approval in plain words, clicked SKU first', () => {
    const b = empty();
    const a = empty();
    b.products = {PEP092: {sku_code: null}};
    a.products = {PEP092: {sku_code: '38006200'}};
    b.chain = {'38006200': {suggested_item_code: 'PEP092', dismissed_item_codes: []}};
    a.chain = {'38006200': {suggested_item_code: null, dismissed_item_codes: []}};
    b.review = {'38006200': null};
    a.review = {'38006200': {action: 'approved', item_code: 'PEP092', action_by: 'Justin'}};
    const d = diffSnaps(b, a);
    expect(undoEffects(d.before, d.after, {target: 'sku', key: '38006200'})).toEqual([
      'Unlink Watsons SKU 38006200 from PEP092. Its sales stop counting for PEP092.',
      `Coop's suggestion PEP092 comes back for Watsons SKU 38006200, under "Check Coop's match".`,
      'The decision on Watsons SKU 38006200 is cleared.',
    ]);
  });

  it('explains undoing a reject, including an auto-link elsewhere from re-matching', () => {
    const b = empty();
    const a = empty();
    b.chain = {'38026223': {suggested_item_code: 'MPEPTE', dismissed_item_codes: []}};
    a.chain = {'38026223': {suggested_item_code: null, dismissed_item_codes: ['MPEPTE']}};
    b.products = {LIP01: {sku_code: null}};
    a.products = {LIP01: {sku_code: '50000001'}};
    b.review = {'38026223': {action: 'approved', item_code: 'X', remark: 'old'}};
    a.review = {'38026223': {action: 'rejected', item_code: 'MPEPTE', remark: null}};
    const d = diffSnaps(b, a);
    const lines = undoEffects(d.before, d.after, {target: 'sku', key: '38026223'});
    expect(lines[0]).toContain(`Coop's suggestion MPEPTE comes back for Watsons SKU 38026223`);
    expect(lines).toContain('Coop may suggest MPEPTE for Watsons SKU 38026223 again (it was turned down).');
    expect(lines).toContain('The remark goes back to “old”.');
    expect(lines[lines.length - 1]).toBe('Unlink Watsons SKU 50000001 from LIP01. Its sales stop counting for LIP01.');
  });

  it('explains undoing a note and a decommission on an item', () => {
    const b = empty();
    const a = empty();
    b.notes = {ACCSBELTBAG: {note: 'first'}};
    a.notes = {ACCSBELTBAG: {note: 'second'}};
    b.products = {ELDF03: {retired_at: null}};
    a.products = {ELDF03: {retired_at: '2026-10-29T00:00:00Z'}};
    const d = diffSnaps(b, a);
    expect(undoEffects(d.before, d.after, {target: 'item', key: 'ACCSBELTBAG'})).toEqual([
      'The note on ACCSBELTBAG goes back to “first”.',
      'Bring ELDF03 back: it returns to "Sold at Watsons?", SKU matching and restock.',
    ]);
  });

  it('splits the clicked SKU from changes elsewhere', () => {
    const b = empty();
    const a = empty();
    b.chain = {'38005999': {suggested_item_code: 'EDNH4289', dismissed_item_codes: []}, '38006000': {suggested_item_code: 'EDNH4525', dismissed_item_codes: []}};
    a.chain = {'38005999': {suggested_item_code: 'EDNH4312', dismissed_item_codes: ['EDNH4289']}, '38006000': {suggested_item_code: 'EDNH4289', dismissed_item_codes: []}};
    const d = diffSnaps(b, a);
    const g = undoEffectGroups(d.before, d.after, {target: 'sku', key: '38005999'});
    expect(g.here).toHaveLength(2);
    expect(g.elsewhere).toEqual(["Coop's suggestion for Watsons SKU 38006000 goes back to EDNH4525 (from EDNH4289)."]);
  });
});
