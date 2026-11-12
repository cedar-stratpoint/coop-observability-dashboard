import {describe, expect, it} from 'vitest';
import {buildPageClassifyPrompt} from '../src/goldline-extract';
import {ANCHOR_MIN_CONFIDENCE, anchorVersion} from '../src/goldline-anchored-extract';

// Classification/version-accuracy safety net (QA found V2 pages tagged V1). The classifier is
// told to decide v1 vs v2 only by the Delivery column position, and the read only anchors to a
// confidently classified v1/v2 (else it stays on the free read, which is safe when the version
// is in doubt).

describe('version classification cue (buildPageClassifyPrompt)', () => {
  const p = buildPageClassifyPrompt();
  it('decides v1 vs v2 by the Delivery column position only', () => {
    expect(p).toMatch(/DECIDE v1 vs v2 BY ONE THING ONLY/);
    expect(p).toMatch(/If "Delivery" is the FIRST data column it is/); // v2
    expect(p).toMatch(/4th data/); // v1: Delivery is the 4th column
  });
  it('ties an unclear Delivery position to lower confidence (so the gate can catch it)', () => {
    expect(p).toMatch(/Delivery\n\s+position is unclear.*lower the confidence/s);
  });
});

describe('anchorVersion gate', () => {
  it('anchors only to a confidently classified v1 or v2', () => {
    expect(anchorVersion('v1', 0.9)).toBe('v1');
    expect(anchorVersion('v2', ANCHOR_MIN_CONFIDENCE)).toBe('v2');
  });

  it('falls back (null) on a low-confidence version, Legacy, or unknown', () => {
    expect(anchorVersion('v1', 0.6)).toBeNull(); // low confidence → free read
    expect(anchorVersion('v2', ANCHOR_MIN_CONFIDENCE - 0.01)).toBeNull();
    expect(anchorVersion('legacy', 0.99)).toBeNull(); // Legacy reads via its own path
    expect(anchorVersion('unknown', 0.99)).toBeNull();
  });
});
