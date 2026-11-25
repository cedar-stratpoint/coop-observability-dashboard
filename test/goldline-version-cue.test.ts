import {describe, expect, it} from 'vitest';
import {buildPageClassifyPrompt} from '../src/goldline-extract';
import {buildFormTemplate} from '../src/goldline-form-template';
import {
  ANCHOR_MIN_CONFIDENCE,
  SET_ASIDE_MIN_CONFIDENCE,
  anchorVersion,
  buildDeliveryLocatorPrompt,
  deliveryColumnFromHeaders,
  deliveryColumnFromLocator,
  expectedDeliveryColumn,
  mapAnchoredToExtractedPage,
  shouldRetrySetAside,
  versionFromDeliveryColumn,
  type AnchoredOutput,
} from '../src/goldline-anchored-extract';

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

// Safeguard (B): the in-read version self-check. The confidence gate cannot catch a *confident*
// mis-tag (QA page 16: a V2 page read V1 at 0.90). The read transcribes the printed column headers
// so the real Delivery column can be located from the layout and compared to the template version;
// a mismatch tells the pipeline to re-anchor on the corrected version.
describe('deliveryColumnFromHeaders', () => {
  it('finds the 1-based position of the printed Delivery column, case-insensitively', () => {
    expect(deliveryColumnFromHeaders(['Delivery', 'Bilang sa Stockroom', 'Bilang sa Drawer'])).toBe(1); // v2 layout
    expect(deliveryColumnFromHeaders(['Bilang sa Stockroom', 'Bilang sa Drawer', 'Bilang sa Selling Area', 'DELIVERY'])).toBe(4); // v1
  });
  it('returns null when no header mentions delivery or none were transcribed', () => {
    expect(deliveryColumnFromHeaders(['Stockroom', 'Drawer'])).toBeNull();
    expect(deliveryColumnFromHeaders(null)).toBeNull();
    expect(deliveryColumnFromHeaders(undefined)).toBeNull();
  });
});

describe('expectedDeliveryColumn / versionFromDeliveryColumn', () => {
  it('maps version <-> Delivery position (v1 = col 4, v2 = col 1)', () => {
    expect(expectedDeliveryColumn('v1')).toBe(4);
    expect(expectedDeliveryColumn('v2')).toBe(1);
    expect(versionFromDeliveryColumn(1)).toBe('v2');
    expect(versionFromDeliveryColumn(4)).toBe('v1');
  });
  it('does not guess a version from an unexpected position', () => {
    expect(versionFromDeliveryColumn(2)).toBeNull();
    expect(versionFromDeliveryColumn(null)).toBeNull();
  });
});

describe('mapAnchoredToExtractedPage · version self-check (B)', () => {
  const items = [{code: 'A1', product: 'Item one'}];
  const catalog = {A1: {productLine: 'Fam', unitPrice: 100}};
  const v1Template = buildFormTemplate(1, 'v1', items, catalog); // expects Delivery at col 4

  it('flags a mismatch when a V1 template is read on a page whose headers put Delivery first (V2)', () => {
    const out: AnchoredOutput = {
      column_headers: ['Delivery', 'Bilang sa Stockroom', 'Bilang sa Drawer', 'Bilang sa Selling Area', 'Ending'],
      rows: [{i: 0, ending_on_hand: 5, confidence: 0.9}],
    };
    const r = mapAnchoredToExtractedPage(v1Template, out);
    expect(r.deliveryExpected).toBe(4);
    expect(r.deliverySeen).toBe(1);
    expect(r.versionMismatch).toBe(true);
    expect(versionFromDeliveryColumn(r.deliverySeen)).toBe('v2'); // what the pipeline re-anchors to
  });

  it('does not flag a mismatch when the headers agree with the template version', () => {
    const out: AnchoredOutput = {
      column_headers: ['Bilang sa Stockroom', 'Bilang sa Drawer', 'Bilang sa Selling Area', 'Delivery', 'Ending'],
      rows: [{i: 0, ending_on_hand: 5, confidence: 0.9}],
    };
    expect(mapAnchoredToExtractedPage(v1Template, out).versionMismatch).toBe(false);
  });

  it('does not flag a mismatch when the headers are unverifiable (not treated as wrong)', () => {
    const out: AnchoredOutput = {rows: [{i: 0, ending_on_hand: 5, confidence: 0.9}]};
    const r = mapAnchoredToExtractedPage(v1Template, out);
    expect(r.deliverySeen).toBeNull();
    expect(r.versionMismatch).toBe(false);
  });
});

// Safeguard (B) · the delivery-column locator. The anchor version is decided from an UNBIASED read
// of where Delivery is physically printed, so the prompt must NOT state an expected column order
// (empirically, stating one primes the model to the classifier's wrong answer).
describe('buildDeliveryLocatorPrompt', () => {
  const p = buildDeliveryLocatorPrompt();
  it('asks for the physical left-to-right order and the Delivery position, with no expected order', () => {
    expect(p).toMatch(/LEFT TO RIGHT/);
    expect(p).toMatch(/do NOT reorder/i);
    expect(p).toMatch(/delivery_column/);
    // It must not pre-state where Delivery is (that is the contamination we are avoiding).
    expect(p).not.toMatch(/col(umn)?\s*4/i);
    expect(p).not.toMatch(/col(umn)?\s*1/i);
  });
});

describe('deliveryColumnFromLocator', () => {
  it('prefers the transcribed header order over the model-stated number', () => {
    expect(deliveryColumnFromLocator({columns_left_to_right: ['Delivery', 'Stockroom'], delivery_column: 4})).toBe(1);
  });
  it('falls back to the stated delivery_column when no headers are transcribed', () => {
    expect(deliveryColumnFromLocator({delivery_column: 1})).toBe(1);
  });
  it('is null when neither signal is present', () => {
    expect(deliveryColumnFromLocator({})).toBeNull();
    expect(deliveryColumnFromLocator(null)).toBeNull();
  });
});

describe('shouldRetrySetAside', () => {
  it('re-reads only a low-confidence sales/blank page before setting it aside', () => {
    expect(shouldRetrySetAside('sales', 0.5)).toBe(true);
    expect(shouldRetrySetAside('blank', SET_ASIDE_MIN_CONFIDENCE - 0.01)).toBe(true);
  });

  it('does not retry a confident sales/blank, nor an inventory/unknown page', () => {
    expect(shouldRetrySetAside('sales', SET_ASIDE_MIN_CONFIDENCE)).toBe(false); // confident set-aside
    expect(shouldRetrySetAside('blank', 0.95)).toBe(false);
    expect(shouldRetrySetAside('inventory', 0.2)).toBe(false);
    expect(shouldRetrySetAside('unknown', 0.2)).toBe(false);
  });
});
