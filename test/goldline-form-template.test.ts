import {describe, expect, it} from 'vitest';
import {MANIFESTS} from '../src/goldline-extract';
import {
  buildFormTemplate,
  columnsForVersion,
  isTemplatePage,
  templateItems,
  templateManifest,
  type TemplateGroupRow,
  type TemplateItemRow,
} from '../src/goldline-form-template';

// Phase 0: the structural template derived from the printed manifest + the catalog. The reader
// (Phase 1) fills only the handwritten cells for each known item row; these tests pin the shape.

describe('columnsForVersion', () => {
  it('places Delivery at column 4 for V1 and column 1 for V2 (the only V1/V2 difference)', () => {
    const v1 = columnsForVersion('v1');
    const v2 = columnsForVersion('v2');
    expect(v1.find((c) => c.key === 'delivery')?.position).toBe(4);
    expect(v2.find((c) => c.key === 'delivery')?.position).toBe(1);
    // Same five fields, same row math — only the Delivery position moves.
    expect(v1.map((c) => c.key).sort()).toEqual(v2.map((c) => c.key).sort());
  });

  it('gives Legacy its 7-column deducted layout (Ending at printed col 6, two deducted columns)', () => {
    const lg = columnsForVersion('legacy');
    expect(lg.map((c) => c.key)).toEqual([
      'beginning',
      'delivery',
      'begin_plus_delivery',
      'deducted_pcs',
      'ending_on_hand',
    ]);
    expect(lg.find((c) => c.key === 'ending_on_hand')?.position).toBe(6);
  });

  it('falls back to V1 columns for an unknown version', () => {
    expect(columnsForVersion('unknown')).toEqual(columnsForVersion('v1'));
  });
});

describe('buildFormTemplate', () => {
  const items = [
    {code: 'USMLLC01', product: "O' So Spice"},
    {code: 'USMLLC02', product: 'Fast Play'},
    {code: 'FBPP01', product: 'Salmon'},
  ];
  const catalog = {
    USMLLC01: {productLine: 'Ultra Stay Matte Liquid Lip Color', unitPrice: 225},
    USMLLC02: {productLine: 'Ultra Stay Matte Liquid Lip Color', unitPrice: 225},
    FBPP01: {productLine: 'Flawless Beauty Pressed Powder', unitPrice: 268},
  };

  it('emits a family-header band at each product_line change, with the printed price', () => {
    const t = buildFormTemplate(1, 'v1', items, catalog);
    const kinds = t.rows.map((r) => r.kind);
    expect(kinds).toEqual(['group', 'item', 'item', 'group', 'item']);
    const firstGroup = t.rows[0] as TemplateGroupRow;
    expect(firstGroup.line).toBe('Ultra Stay Matte Liquid Lip Color');
    expect(firstGroup.unitPrice).toBe(225);
    // Bands are not counted as item rows; three codes stay three rows to read.
    expect(t.itemCount).toBe(3);
    expect(templateItems(t)).toHaveLength(3);
  });

  it('keeps item rows in printed order and carries code, variant, group and price', () => {
    const rows = templateItems(buildFormTemplate(1, 'v1', items, catalog));
    expect(rows.map((r) => r.itemCode)).toEqual(['USMLLC01', 'USMLLC02', 'FBPP01']);
    const r0 = rows[0] as TemplateItemRow;
    expect(r0.product).toBe("O' So Spice");
    expect(r0.group).toBe('Ultra Stay Matte Liquid Lip Color');
    expect(r0.unitPrice).toBe(225);
  });

  it('never invents a band for an uncatalogued code (no product_line)', () => {
    const t = buildFormTemplate(1, 'v1', items, {}); // empty catalog
    expect(t.rows.every((r) => r.kind === 'item')).toBe(true);
    expect(t.itemCount).toBe(3);
    const r0 = t.rows[0] as TemplateItemRow;
    expect(r0.group).toBeNull();
    expect(r0.unitPrice).toBeNull();
  });
});

describe('isTemplatePage / templateManifest', () => {
  it('is false for the page 6 sales report and true for inventory pages 1 to 5', () => {
    expect(isTemplatePage(6)).toBe(false);
    expect(isTemplatePage(0)).toBe(false);
    for (const p of [1, 2, 3, 4, 5]) expect(isTemplatePage(p)).toBe(true);
  });

  it('builds a full template for a page: every manifest row becomes an item row, in order', () => {
    // Pure path (no catalog): item-only rows, but complete and in printed order.
    const t = buildFormTemplate(1, 'v1', templateManifest(1), {});
    expect(t.itemCount).toBe(MANIFESTS[1].length);
    expect(templateItems(t).map((r) => r.itemCode)).toEqual(MANIFESTS[1].map((i) => i.code));
  });
});
