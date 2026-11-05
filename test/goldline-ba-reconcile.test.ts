import {describe, expect, it} from 'vitest';
import {baSlug, reconcileBaNames} from '../src/goldline-ba-reconcile';

describe('baSlug', () => {
  it('lowercases, drops punctuation and middle initials', () => {
    expect(baSlug('Rhea Mae P. Bermil')).toBe('rhea mae bermil');
    expect(baSlug('RHEA MAE BERMIL')).toBe('rhea mae bermil');
    expect(baSlug('Ma. Sofia C. Lucero')).toBe('sofia lucero');
  });
});

describe('reconcileBaNames', () => {
  it('groups the same person written several ways into one canonical name', () => {
    const map = reconcileBaNames(['Rhea Mae Bernil', 'Rhea Mae P. Bermil', 'RHEA MAE BERMIL']);
    const canon = new Set(map.values());
    expect(canon.size).toBe(1);
    // Fullest written form stands in when there's no registry match.
    expect(map.get('Rhea Mae Bernil')).toBe('Rhea Mae P. Bermil');
  });

  it('prefers the registry spelling as the source of truth', () => {
    const map = reconcileBaNames(['Rhea Mae Bernil', 'RHEA MAE BERMIL'], ['Rhea Mae Bermil']);
    expect(map.get('Rhea Mae Bernil')).toBe('Rhea Mae Bermil');
    expect(map.get('RHEA MAE BERMIL')).toBe('Rhea Mae Bermil');
  });

  it('keeps genuinely different people apart', () => {
    const map = reconcileBaNames(['Leonisa Ramos', 'Sofia Lucero']);
    expect(new Set(map.values()).size).toBe(2);
  });

  it('ignores blank names', () => {
    const map = reconcileBaNames(['', '  ', null, undefined, 'Mae Bernal']);
    expect(map.size).toBe(1);
    expect(map.get('Mae Bernal')).toBe('Mae Bernal');
  });
});
