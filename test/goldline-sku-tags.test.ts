import {describe, expect, it} from 'vitest';
import {linkedHow, SKU_TAGS, skuStatus, sureness} from '../src/goldline-sku-tags';

const row = (o: Partial<Parameters<typeof skuStatus>[0]> = {}) => ({linked: null, suggestion: null, review: null, ...o});

describe('SKU linking tags', () => {
  it('picks the tag from link, suggestion and the last decision', () => {
    expect(skuStatus(row({linked: {source: 'code'}}))).toBe('linked');
    expect(skuStatus(row({suggestion: {tier: 'medium'}}))).toBe('check');
    expect(skuStatus(row({review: {action: 'rejected'}}))).toBe('rejected');
    expect(skuStatus(row())).toBe('choose');
    // After a reject, a new suggestion is shown to check, not as rejected.
    expect(skuStatus(row({suggestion: {tier: 'low'}, review: {action: 'rejected'}}))).toBe('check');
    // An unlink with no new suggestion goes back to choosing.
    expect(skuStatus(row({review: {action: 'unlinked'}}))).toBe('choose');
  });

  it('says how a link was made', () => {
    expect(linkedHow(row({linked: {source: 'code'}}))).toMatch(/item code/);
    expect(linkedHow(row({linked: {source: 'match'}}))).toMatch(/Matched by Coop/);
    expect(linkedHow(row({linked: {source: 'admin'}, review: {action: 'approved'}}))).toBe('Coop’s match, approved');
    expect(linkedHow(row({linked: {source: 'admin'}, review: {action: 'linked'}}))).toBe('Linked by hand');
  });

  it('uses plain words and no dashes', () => {
    expect(sureness('low')).toMatch(/not sure/);
    for (const t of Object.values(SKU_TAGS)) {
      expect(t.label + t.help).not.toMatch(/[–—]/);
      expect(t.label).not.toMatch(/Needs a pick/);
    }
  });
});

describe('form spots', () => {
  it('places items by printed page and row', async () => {
    const {formSpots, formSpotText} = await import('../src/goldline-sku-tags');
    const s = formSpots();
    expect(s.get('FBPP01')).toEqual({page: 1, row: 1});
    expect(s.get('FBPP02')).toEqual({page: 1, row: 2});
    expect(formSpotText(s.get('FBPP01'))).toBe('Page 1 · row 1');
    expect(formSpotText(null)).toBe('Not on the form');
    expect([...s.values()].every((v) => v.page >= 1 && v.page <= 5)).toBe(true);
  });
});
