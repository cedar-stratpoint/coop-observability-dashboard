import {describe, expect, it} from 'vitest';
import {buildFormTemplate, templateItems, type FormTemplate} from '../src/goldline-form-template';
import {generatedTemplateItems} from '../src/goldline-form-templates.generated';
import {
  buildAnchoredPrompt,
  buildAnchoredPromptP1,
  fitOptionalRows,
  mapAnchoredOutput,
  type AnchoredOutput,
  type AnchoredOutputP1,
} from '../src/goldline-anchored-extract';
import {printedOsRows} from '../src/printed-os';

// QA Nov 27: some V1 page 5 prints (stores 5300, 296) carry an INDIVIDUAL FLARE band (ELIF3125B,
// ₱238, O/S printed) between Elise Lashes and Feather Lite; most V1 copies and every V2 copy do
// not. The row is optional in the template: reported when printed, absent (no row, no flag) when not.

/** The real V1 page 5 template, the way getFormTemplate builds it from the generated rows. */
function v1Page5(): FormTemplate {
  const gen = generatedTemplateItems('v1', 5) ?? [];
  const items = gen.map((g) => ({code: g.code, product: g.product, ...(g.optional ? {optional: true} : {})}));
  const catalog = Object.fromEntries(gen.map((g) => [g.code, {productLine: g.group, unitPrice: g.price}]));
  return buildFormTemplate(5, 'v1', items, catalog);
}

const codes = (rows: Array<{item_code: string}>) => rows.map((r) => r.item_code);

describe('V1 page 5 template', () => {
  it('lists ELIF3125B as optional under its own optional band, after ELF8058', () => {
    const t = v1Page5();
    const items = templateItems(t);
    const i = items.findIndex((it) => it.itemCode === 'ELIF3125B');
    expect(i).toBeGreaterThan(0);
    expect(items[i - 1].itemCode).toBe('ELF8058');
    expect(items[i]).toMatchObject({optional: true, group: 'INDIVIDUAL FLARE', unitPrice: 238});
    expect(items.filter((it) => it.optional)).toHaveLength(1);
    const band = t.rows.find((r) => r.kind === 'group' && r.line === 'INDIVIDUAL FLARE');
    expect(band).toMatchObject({optional: true});
    expect(t.rows.find((r) => r.kind === 'group' && r.line === 'ELISE LASHES')).not.toHaveProperty('optional');
  });
  it('V2 page 5 does not list it', () => {
    expect((generatedTemplateItems('v2', 5) ?? []).some((g) => g.code === 'ELIF3125B')).toBe(false);
  });
  it('both prompts mark it and explain the some-copies rule; a template without optional rows has no rule', () => {
    const t = v1Page5();
    for (const p of [buildAnchoredPrompt(t), buildAnchoredPromptP1(t)]) {
      expect(p).toContain('[FAMILY] INDIVIDUAL FLARE (printed ₱238) (SOME COPIES ONLY)');
      expect(p).toMatch(/ELIF3125B.*3125 \(black\) \(SOME COPIES ONLY\)/);
      expect(p).toMatch(/printed on some copies of this page and not others/);
    }
    const plain = buildFormTemplate(5, 'v1', [{code: 'EFLLF11', product: 'F11'}], {});
    expect(buildAnchoredPromptP1(plain)).not.toMatch(/SOME COPIES ONLY/);
  });
});

describe('fitOptionalRows + mapAnchoredOutput (P1, keyed by row)', () => {
  const base = (extra: Partial<AnchoredOutputP1> = {}): AnchoredOutputP1 => ({
    header: {store_code: '5300'},
    rows: [
      {row: 'ELF8058', ending_on_hand: 3, confidence: 0.9},
      {row: 'EFLLF11', selling_area: 1, ending_on_hand: 1, confidence: 0.9},
    ],
    ...extra,
  });

  it('a copy without the row: no ELIF3125B row, nothing kept blank for it, no band for it', () => {
    const t = v1Page5();
    const m = mapAnchoredOutput(t, base());
    expect(codes(m.page.rows)).not.toContain('ELIF3125B');
    expect(m.page.rows).toHaveLength(templateItems(t).length - 1);
    expect(m.page.rows.some((r) => r.off_manifest)).toBe(false);
    expect((m.page.bands ?? []).some((b) => b.group === 'INDIVIDUAL FLARE')).toBe(false);
    // Rows after the dropped one keep their own numbers.
    const f11 = m.page.rows.find((r) => r.item_code === 'EFLLF11');
    expect(f11?.ending_on_hand).toBe(1);
  });

  it('a copy with the row (reported blank, O/S printed): a printed row in place, not a write-in', () => {
    const t = v1Page5();
    const m = mapAnchoredOutput(t, base({rows: [...base().rows, {row: 'ELIF3125B', confidence: 0.9, flags: ['os_drawer']}]}));
    const rows = m.page.rows;
    const i = codes(rows).indexOf('ELIF3125B');
    expect(i).toBe(codes(rows).indexOf('ELF8058') + 1);
    expect(rows[i]).toMatchObject({off_manifest: false, os_printed: true});
    expect(rows[i].drawer ?? null).toBeNull();
    expect(rows.filter((r) => r.off_manifest)).toHaveLength(0);
  });

  it('the row reported as an extra (Oct 30 p21) is moved onto its printed row', () => {
    const t = v1Page5();
    const m = mapAnchoredOutput(t, base({extras: [{code: 'ELIF3125B', name: '3125 (black)', confidence: 0.5}]}));
    expect(m.page.rows.filter((r) => r.item_code === 'ELIF3125B')).toHaveLength(1);
    expect(m.page.rows.find((r) => r.item_code === 'ELIF3125B')?.off_manifest).toBe(false);
    expect(m.extras).toBe(0);
  });

  it('an extra named by its printed name only is matched too', () => {
    const fitted = fitOptionalRows(v1Page5(), base({extras: [{code: null, name: 'Individual Flare 3125 Black', ending_on_hand: 2}]}));
    expect(fitted.out.extras).toHaveLength(0);
    expect(fitted.out.rows.find((r) => r.row === 'ELIF3125B')).toMatchObject({ending_on_hand: 2});
  });

  it('a real write-in (Raspberry Float under Pink Champagne) stays a flagged extra', () => {
    const t = v1Page5();
    const m = mapAnchoredOutput(t, base({extras: [{code: null, name: 'Raspberry Float', ending_on_hand: 2, confidence: 0.5}]}));
    const extra = m.page.rows.filter((r) => r.off_manifest);
    expect(extra).toHaveLength(1);
    expect(extra[0].printed_name).toBe('Raspberry Float');
    expect(codes(m.page.rows)).not.toContain('ELIF3125B');
  });
});

describe('fitOptionalRows (index-keyed output)', () => {
  it('re-indexes rows after a dropped optional row', () => {
    const t = v1Page5();
    const items = templateItems(t);
    const flare = items.findIndex((it) => it.itemCode === 'ELIF3125B');
    const f11 = items.findIndex((it) => it.itemCode === 'EFLLF11');
    const out: AnchoredOutput = {rows: [{i: f11, ending_on_hand: 4, confidence: 0.9}]};
    const fitted = fitOptionalRows(t, out);
    expect(fitted.template.itemCount).toBe(items.length - 1);
    expect(fitted.out.rows).toEqual([{i: f11 - 1, ending_on_hand: 4, confidence: 0.9}]);
    expect(f11).toBe(flare + 1);
    const m = mapAnchoredOutput(t, out);
    expect(m.page.rows.find((r) => r.item_code === 'EFLLF11')?.ending_on_hand).toBe(4);
    expect(m.filledBlanks).toBe(items.length - 2);
  });
  it('leaves a template without optional rows untouched', () => {
    const plain = buildFormTemplate(5, 'v1', [{code: 'EFLLF11', product: 'F11'}], {});
    const out: AnchoredOutput = {rows: [{i: 0, confidence: 0.9}]};
    const fitted = fitOptionalRows(plain, out);
    expect(fitted.template).toBe(plain);
    expect(fitted.out).toBe(out);
  });
});

describe('printed O/S on V1 page 5', () => {
  it('ELIF3125B is printed O/S on V1 page 5 (and still on Legacy page 5)', () => {
    const rows = [{item_code: 'ELF8058'}, {item_code: 'ELIF3125B'}, {item_code: 'EFLLF11'}];
    expect([...printedOsRows(rows, 'v1', 5)]).toEqual([1]);
    expect([...printedOsRows(rows, 'legacy', 5)]).toEqual([1]);
    expect([...printedOsRows(rows, 'v2', 5)]).toEqual([]);
  });
});
