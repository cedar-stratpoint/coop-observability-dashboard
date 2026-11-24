import {describe, it, expect} from 'vitest';
import {GENERATED_FORM_TEMPLATES, generatedTemplateItems} from './goldline-form-templates.generated';
import {buildFormTemplate, templateItems} from './goldline-form-template';

// The generated per-(version, page) templates are the version-faithful row lists authored in
// docs/form-templates/*.xlsx. These guard the reason they exist: the versions paginate differently,
// so a page-only manifest flagged real printed rows (De Luxe) as handwritten.

describe('generated form templates', () => {
  const VERSIONS = ['legacy', 'v1', 'v2'] as const;

  it('every row has a non-empty code and product name (blank reserved rows excluded)', () => {
    for (const v of VERSIONS) {
      for (let p = 1; p <= 5; p++) {
        const items = GENERATED_FORM_TEMPLATES[v][p];
        expect(items.length, `${v} p${p}`).toBeGreaterThan(0);
        for (const it of items) {
          expect(it.code.trim(), `${v} p${p} code`).not.toBe('');
          expect(it.product.trim(), `${v} p${p} ${it.code} product`).not.toBe('');
        }
      }
    }
  });

  it('places Trulashes De Luxe on the version-correct page (V1 p4, V2 p5, never V2 p4)', () => {
    const has = (v: 'v1' | 'v2' | 'legacy', p: number, code: string) =>
      (generatedTemplateItems(v, p) ?? []).some((i) => i.code === code);
    expect(has('v1', 4, 'TLDL6619')).toBe(true);
    expect(has('v2', 5, 'TLDL6619')).toBe(true);
    expect(has('v2', 4, 'TLDL6619')).toBe(false);
    expect(has('legacy', 4, 'TLDL6619')).toBe(true);
  });

  it('keeps the full eyeshadow list on V1/Legacy but the trimmed list on V2 (page 2)', () => {
    const es = (v: 'v1' | 'v2' | 'legacy') =>
      (generatedTemplateItems(v, 2) ?? []).filter((i) => i.code.startsWith('TCES')).length;
    expect(es('v1')).toBe(15);
    expect(es('legacy')).toBe(15);
    expect(es('v2')).toBe(6);
  });

  it('keeps Legacy-only SKUs the newer versions dropped', () => {
    expect((generatedTemplateItems('legacy', 5) ?? []).some((i) => i.code === 'ELIF3125B')).toBe(true);
    expect((generatedTemplateItems('legacy', 1) ?? []).some((i) => i.code === 'PP01115')).toBe(true);
    expect((generatedTemplateItems('legacy', 5) ?? []).some((i) => i.code === 'EFTT1904')).toBe(true);
  });

  it('page 1 carries the 43 catalogued rows for V1 and V2 (reserved blank rows not counted)', () => {
    expect((generatedTemplateItems('v1', 1) ?? []).length).toBe(43);
    expect((generatedTemplateItems('v2', 1) ?? []).length).toBe(43);
  });

  it('builds a FormTemplate with family bands and one item row per code', () => {
    const gen = generatedTemplateItems('v2', 1) ?? [];
    const items = gen.map((g) => ({code: g.code, product: g.product}));
    const catalog: Record<string, {productLine: string | null; unitPrice: number | null}> =
      Object.fromEntries(gen.map((g) => [g.code, {productLine: g.group, unitPrice: g.price}]));
    const t = buildFormTemplate(1, 'v2', items, catalog);
    expect(templateItems(t).length).toBe(43);
    expect(t.rows.some((r) => r.kind === 'group' && r.line === 'NICHIDO FLAWLESS BEAUTY PRESSED POWDER')).toBe(true);
  });

  it('returns null for an unknown version or a non-template page', () => {
    expect(generatedTemplateItems('unknown', 1)).toBeNull();
    expect(generatedTemplateItems('v1', 6)).toBeNull();
  });
});
