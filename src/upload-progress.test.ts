import {describe, expect, it} from 'vitest';
import {kindOfFile, progressFor, stepStates} from './upload-progress';

describe('progressFor', () => {
  it('maps real upload bytes into the upload band', () => {
    expect(progressFor('pdf', 'uploading', 0, 0)).toBe(0);
    expect(progressFor('pdf', 'uploading', 0.5, 0)).toBe(6);
    expect(progressFor('csv', 'uploading', 1, 0)).toBe(50);
  });

  it('never finishes a band on time alone — only "done" reaches 100', () => {
    const longRead = progressFor('pdf', 'reading', 1, 10 * 60_000);
    expect(longRead).toBeLessThan(92.0001);
    expect(longRead).toBeGreaterThan(90);
    expect(progressFor('pdf', 'saving', 1, 60_000)).toBeLessThan(98.0001);
    expect(progressFor('pdf', 'done', 1, 0)).toBe(100);
  });

  it('only moves forward across phases', () => {
    const seq = [
      progressFor('pdf', 'uploading', 1, 0),
      progressFor('pdf', 'stored', 1, 0),
      progressFor('pdf', 'detecting', 1, 0),
      progressFor('pdf', 'reading', 1, 0),
      progressFor('pdf', 'saving', 1, 0),
      progressFor('pdf', 'done', 1, 0),
    ];
    for (let i = 1; i < seq.length; i++) expect(seq[i]).toBeGreaterThanOrEqual(seq[i - 1]);
  });
});

describe('stepStates', () => {
  it('marks done / active / pending from the phase', () => {
    expect(stepStates('pdf', 'reading').map((s) => s.state)).toEqual(['done', 'done', 'active', 'pending']);
    expect(stepStates('pdf', 'done').every((s) => s.state === 'done')).toBe(true);
    expect(stepStates('csv', 'uploading').map((s) => s.state)).toEqual(['active', 'pending', 'pending']);
  });
});

describe('kindOfFile', () => {
  it('reads the extension', () => {
    expect(kindOfFile('cubao.CSV')).toBe('csv');
    expect(kindOfFile('scan.pdf')).toBe('pdf');
    expect(kindOfFile('promo.xlsx')).toBeNull();
  });
});
