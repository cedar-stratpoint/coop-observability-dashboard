import {describe, expect, it} from 'vitest';
import {effectiveRotation} from '../components/analyst/scan-rotation';

describe('effectiveRotation', () => {
  it('shows an upright page as is, and an upside-down page turned', () => {
    expect(effectiveRotation(0, false)).toBe(0);
    expect(effectiveRotation(null, false)).toBe(0);
    expect(effectiveRotation(undefined, false)).toBe(0);
    expect(effectiveRotation(180, false)).toBe(180);
  });
  it('a reviewer flip turns the page once more', () => {
    expect(effectiveRotation(0, true)).toBe(180);
    expect(effectiveRotation(180, true)).toBe(0);
  });
  it('ignores values other than 180', () => {
    expect(effectiveRotation(90, false)).toBe(0);
  });
});

import {scanPointBox} from '../components/analyst/scan-rotation';

describe('scanPointBox', () => {
  const row = {item_code: 'TCPBT02', alt: 'ending on hand could be 50', box: {y_top: 0.4, y_bottom: 0.42}};
  it('returns the located box, tilted and labelled', () => {
    const b = scanPointBox(row, {angle: 1.2, px: 0.18}, false)!;
    expect(b.top).toBeCloseTo(0.4);
    expect(b.height).toBeCloseTo(0.02);
    expect(b).toMatchObject({angle: 1.2, px: 0.18, label: 'TCPBT02'});
  });
  it('turns the box with a page the reviewer flipped', () => {
    const b = scanPointBox(row, {angle: 1.2, px: 0.18}, true)!;
    expect(b.top).toBeCloseTo(0.58);
    expect(b.px).toBeCloseTo(0.82);
    expect(b.angle).toBe(1.2);
  });
  it('draws nothing without a usable box', () => {
    expect(scanPointBox({item_code: 'X'}, null, false)).toBeNull();
    expect(scanPointBox({item_code: 'X', box: {y_top: 0.5, y_bottom: 0.5}}, null, false)).toBeNull();
    expect(scanPointBox(null, null, false)).toBeNull();
  });
});
