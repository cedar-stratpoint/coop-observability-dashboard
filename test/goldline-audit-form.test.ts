import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';
import {catalogCodeOf, inventoryAnswer, printedPages, type FormCount} from '../src/goldline-audit-form';
import {GENERATED_FORM_TEMPLATES} from '../src/goldline-form-templates.generated';

const catalog = new Set((JSON.parse(readFileSync(join(__dirname, 'fixtures/goldline-catalog.json'), 'utf8')) as Array<{item_code: string}>).map((c) => c.item_code));
const form = (rows: Record<string, number | null>, version: string | null = 'v1') => new Map<string, FormCount>(Object.entries(rows).map(([k, onHand]) => [k, {onHand, version}]));

describe('printed templates ↔ catalog codes', () => {
  it('every printed row maps to a catalog product, except five Legacy-only rows', () => {
    const missing = new Set(
      Object.values(GENERATED_FORM_TEMPLATES)
        .flatMap((pages) => Object.values(pages).flat())
        .map(catalogCodeOf)
        .filter((c) => !catalog.has(c)),
    );
    // Legacy-only rows with no catalog product. A new code here is a product the matrix
    // would wrongly call "not on the form".
    expect([...missing].sort()).toEqual(['EFTT1904', 'ELIF3125B', 'JLLS01', 'JLLS03', 'LQFD093']);
  });

  it('accessories that share a shelf code land on their own product', () => {
    expect(catalogCodeOf({code: 'ACCS 288', product: 'Nichido Stippling Brush #185'})).toBe('ACCS185');
    expect(catalogCodeOf({code: 'ACCS 03', product: 'Nichido #03 Oval Paddle Brush Small'})).toBe('ACCS03');
    expect(catalogCodeOf({code: '24/7SEPM', product: 'Midnight Matte'})).toBe('24/7SEPMM');
  });
});

describe('inventoryAnswer', () => {
  const page = printedPages('v1')!.get('FBPP01');
  const samePage = [...printedPages('v1')!].find(([c, p]) => p === page && c !== 'FBPP01')![0];

  it('reads the count, and keeps a zero apart from a blank', () => {
    expect(inventoryAnswer(form({FBPP01: 5}), 'FBPP01')).toBe(5);
    expect(inventoryAnswer(form({FBPP01: 0}), 'FBPP01')).toBe(0);
    expect(inventoryAnswer(form({FBPP01: null}), 'FBPP01')).toBe('blank');
  });
  it('a store with no form is not counted', () => {
    expect(inventoryAnswer(null, 'FBPP01')).toBe('no_count');
    expect(inventoryAnswer(form({}), 'FBPP01')).toBe('no_count');
  });
  it('a product is absent only when the form version does not print it', () => {
    expect(printedPages('v1')!.has('MUR')).toBe(false);
    expect(inventoryAnswer(form({FBPP01: 5}), 'MUR')).toBe('absent');
  });
  it('a product whose page was not uploaded is unknown, not absent', () => {
    expect(inventoryAnswer(form({FBPP01: 5}), 'EXT193')).toBe('page_missing');
    expect(inventoryAnswer(form({[samePage]: 5}), 'FBPP01')).toBe('blank'); // page in, row missing
  });
  it('an unknown form version can’t say a product isn’t printed', () => {
    expect(inventoryAnswer(form({FBPP01: 5}, 'unknown'), 'MUR')).toBe('page_missing');
  });
});
