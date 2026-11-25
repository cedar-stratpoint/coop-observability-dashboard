import {describe, expect, it} from 'vitest';
import {addedRow, addWarning, searchAddable, type AddableItem} from '../src/review-add-row';
import {packPage, unpackPage} from '../src/review-draft';

const item = (code: string, name: string, line: string | null, printedPage: number | null = null): AddableItem => ({code, name, line, price: 200, printedPage});
const ITEMS = [
  item('TSP01204', 'Creamy Glow Final Powder', 'Translucent Setting Powder', 1),
  item('TSP01205', 'Peach Glow Final Powder', 'Translucent Setting Powder', null),
  item('BP01205', 'Go Bronzo', 'Bronzing Powder', 3),
  item('LMU1451', 'Copper', 'Leg Make-Up', null),
];

describe('searchAddable', () => {
  it('opens on the lines already on the page', () => {
    expect(searchAddable(ITEMS, '', new Set(['Translucent Setting Powder'])).map((i) => i.code).slice(0, 2)).toEqual(['TSP01204', 'TSP01205']);
  });
  it('an exact code first, then codes that start with it, then names with every word', () => {
    expect(searchAddable(ITEMS, 'bp01205', new Set()).map((i) => i.code)).toEqual(['BP01205']);
    expect(searchAddable(ITEMS, 'tsp012', new Set()).map((i) => i.code)).toEqual(['TSP01204', 'TSP01205']);
    expect(searchAddable(ITEMS, 'peach glow', new Set()).map((i) => i.code)).toEqual(['TSP01205']);
    expect(searchAddable(ITEMS, 'glow', new Set(), 1)).toHaveLength(1);
    expect(searchAddable(ITEMS, 'zzz', new Set())).toEqual([]);
  });
});

describe('addWarning', () => {
  it('blocks a product already on the page; warns when printed on another page', () => {
    expect(addWarning(ITEMS[0], new Set(['TSP01204']), 1)).toMatchObject({block: true});
    expect(addWarning(ITEMS[2], new Set(), 1)).toMatchObject({block: false, text: expect.stringContaining('page 3')});
    expect(addWarning(ITEMS[1], new Set(), 1)).toBeNull();
    expect(addWarning(ITEMS[0], new Set(), 1)).toBeNull();
  });
});

describe('addedRow', () => {
  it('is blank, full confidence and marked added', () => {
    expect(addedRow(ITEMS[1])).toMatchObject({item_code: 'TSP01205', printed_name: 'Peach Glow Final Powder', stockroom: null, ending_on_hand: null, confidence: 1, added: true});
  });
});

describe('drafts keep added rows', () => {
  const original = [{item_code: 'A', stockroom: 1, drawer: null, selling_area: 2, delivery: null, ending_on_hand: 3}];
  it('packs and restores an added row with its counts', () => {
    const edited = [{...original[0]}, {...addedRow(ITEMS[1]), selling_area: 4}];
    const d = packPage(original, edited, [])!;
    expect(d.added).toEqual([{code: 'TSP01205', name: 'Peach Glow Final Powder'}]);
    const back = unpackPage(original, d)!;
    expect(back.rows).toHaveLength(2);
    expect(back.rows[1]).toMatchObject({item_code: 'TSP01205', selling_area: 4, added: true, confidence: 1});
  });
  it('an old draft without added rows still restores', () => {
    const d = packPage(original, [{...original[0], drawer: 5}], [0])!;
    expect(d.added).toBeUndefined();
    expect(unpackPage(original, d)!.rows[0].drawer).toBe(5);
  });
  it('nothing changed and nothing added = no draft', () => expect(packPage(original, [{...original[0]}], [])).toBeNull());
});
