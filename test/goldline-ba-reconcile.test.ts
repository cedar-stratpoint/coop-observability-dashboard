import {describe, expect, it} from 'vitest';
import {baSlug, reconcileBaNames, withCanonicalBa} from '../src/goldline-ba-reconcile';

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

  it('does not fold different surnames by default', () => {
    const map = reconcileBaNames(['Vanessa Dimaampao', 'Vanessa Dran']);
    expect(new Set(map.values()).size).toBe(2);
  });

  it('folds small same-first-name look-alikes into the dominant card when asked', () => {
    // Dimaampao has many forms; the one-off "Vanessa …" reads fold into her.
    const names = [...Array(5).fill('Vanessa Dimaampao'), 'Vanessa Dran', 'Vanessa Olompo'];
    const map = reconcileBaNames(names, [], {foldFirstName: true});
    expect(map.get('Vanessa Dran')).toBe('Vanessa Dimaampao');
    expect(map.get('Vanessa Olompo')).toBe('Vanessa Dimaampao');
    expect(new Set(map.values()).size).toBe(1);
  });

  it('keeps two substantial same-first-name cards apart when folding', () => {
    // Both have more than FOLD_SMALL_FORMS forms, so neither is absorbed.
    const names = [...Array(4).fill('Vanessa Dimaampao'), ...Array(4).fill('Vanessa Reyes')];
    const map = reconcileBaNames(names, [], {foldFirstName: true});
    expect(new Set(map.values()).size).toBe(2);
  });

  it('does not merge different first names when folding', () => {
    const names = ['Vanessa Dran', 'Sofia Lucero'];
    const map = reconcileBaNames(names, [], {foldFirstName: true});
    expect(new Set(map.values()).size).toBe(2);
  });
});

describe('withCanonicalBa', () => {
  it('rewrites every form consultant to one canonical spelling', () => {
    const board = {
      forms: [
        {key: 'a', consultant: 'RHEA MAE BERMIL'},
        {key: 'b', consultant: 'Rhea Mae P. Bermil'},
        {key: 'c', consultant: null},
      ],
    };
    const out = withCanonicalBa(board, ['Rhea Mae Bermil']);
    expect(out.forms[0].consultant).toBe('Rhea Mae Bermil');
    expect(out.forms[1].consultant).toBe('Rhea Mae Bermil');
    // Blank names are left untouched, and other fields survive.
    expect(out.forms[2].consultant).toBeNull();
    expect(out.forms[0].key).toBe('a');
    // A new board is returned; the input is not mutated.
    expect(board.forms[0].consultant).toBe('RHEA MAE BERMIL');
  });
});
