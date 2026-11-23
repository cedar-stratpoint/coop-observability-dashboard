import {describe, expect, it} from 'vitest';
import {applyRowBoxes, boxCustomId, isBoxCustomId, locateRowsFor, parseBoxCustomId} from '../src/goldline-row-boxes';
import type {ExtractedRow} from '../src/goldline-extract-run';
import type {FormTemplate} from '../src/goldline-form-template';

const row = (item_code: string, extra: Partial<ExtractedRow> = {}): ExtractedRow =>
  ({item_code, stockroom: null, drawer: null, selling_area: null, delivery: null, ending_on_hand: null, confidence: 0.9, ...extra}) as ExtractedRow;

describe('row-box batch ids', () => {
  it('round-trips the image height and stays within the batch id rules', () => {
    const id = boxCustomId('4164ced6-0aa6-4a23-9ae5-04b528922f01', 1544.4);
    expect(id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(parseBoxCustomId(id, '4164ced6-0aa6-4a23-9ae5-04b528922f01')).toBe(1544);
    expect(parseBoxCustomId(id, 'another-upload')).toBeNull();
    expect(isBoxCustomId(id)).toBe(true);
    expect(isBoxCustomId('4164ced6-0aa6-4a23-9ae5-04b528922f01')).toBe(false);
  });
});

describe('locateRowsFor', () => {
  it('uses the template item rows in printed order, skipping family bands', () => {
    const t = {page: 1, version: 'v1', columns: [], itemCount: 2, rows: [
      {kind: 'group', line: 'PRESSED POWDER', unitPrice: 125},
      {kind: 'item', itemCode: 'PP01115', product: 'Natural', group: 'PRESSED POWDER', unitPrice: 125},
      {kind: 'item', itemCode: 'FBPP01', product: 'Salmon', group: null, unitPrice: 150},
    ]} as unknown as FormTemplate;
    expect(locateRowsFor(t, 1)).toEqual([{code: 'PP01115', product: 'Natural'}, {code: 'FBPP01', product: 'Salmon'}]);
  });
});

describe('applyRowBoxes', () => {
  const list = [{code: 'A', product: 'a'}, {code: 'ACCS 288', product: 'first'}, {code: 'ACCS 288', product: 'second'}, {code: 'B', product: 'b'}];

  it('sets page-fraction boxes, matching repeated codes by occurrence and skipping extras', () => {
    const rows = [row('A'), row('X', {off_manifest: true} as Partial<ExtractedRow>), row('ACCS 288'), row('ACCS 288'), row('B')];
    const n = applyRowBoxes(rows, list, {rows: [{i: 0, top: 100, bottom: 120}, {i: 1, top: 130, bottom: 150}, {i: 2, top: 160, bottom: 180}, {i: 3, top: 190, bottom: 210}]}, 1000);
    expect(n).toBe(4);
    expect(rows[0].box).toEqual({y_top: 0.1, y_bottom: 0.12});
    expect(rows[1].box).toBeUndefined();
    expect(rows[2].box).toEqual({y_top: 0.13, y_bottom: 0.15});
    expect(rows[3].box).toEqual({y_top: 0.16, y_bottom: 0.18});
  });

  it('drops the whole answer when the rows run out of order', () => {
    const rows = [row('A'), row('ACCS 288'), row('ACCS 288'), row('B')];
    const n = applyRowBoxes(rows, list, {rows: [{i: 0, top: 400, bottom: 420}, {i: 1, top: 100, bottom: 120}, {i: 2, top: 300, bottom: 320}, {i: 3, top: 50, bottom: 70}]}, 1000);
    expect(n).toBe(0);
    expect(rows.every((r) => r.box == null)).toBe(true);
  });

  it('ignores impossible boxes and a missing answer', () => {
    const rows = [row('A'), row('B')];
    const two = [{code: 'A', product: 'a'}, {code: 'B', product: 'b'}];
    expect(applyRowBoxes(rows, two, {rows: [{i: 0, top: 100, bottom: 400}, {i: 1, top: 120, bottom: 110}]}, 1000)).toBe(0);
    expect(applyRowBoxes(rows, two, null, 1000)).toBe(0);
  });
});
