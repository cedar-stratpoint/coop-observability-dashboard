import {describe, expect, it} from 'vitest';
import {packPage, parseDraft, readingId, unpackPage} from './review-draft';

const reading = [
  {item_code: 'A', stockroom: 47, drawer: 52, selling_area: 33, delivery: null, ending_on_hand: 162, confidence: 0.5},
  {item_code: 'B', stockroom: 3, drawer: null, selling_area: null, delivery: null, ending_on_hand: null, confidence: 0.9},
];

describe('review drafts', () => {
  it('keeps nothing when the reviewer changed nothing', () => {
    expect(packPage(reading, reading.map((r) => ({...r})), [])).toBeNull();
  });

  it('round-trips edited counts and checked flags, keeping the other row fields', () => {
    const edited = [{...reading[0], drawer: 82}, {...reading[1], stockroom: null}];
    const d = packPage(reading, edited, [0]);
    const back = unpackPage(reading, JSON.parse(JSON.stringify(d)));
    expect(back?.rows[0].drawer).toBe(82);
    expect(back?.rows[1].stockroom).toBeNull();
    expect(back?.rows[0].confidence).toBe(0.5);
    expect([...(back?.resolved ?? [])]).toEqual([0]);
  });

  it('keeps a draft that only has checked flags', () => {
    expect(packPage(reading, reading, [1])?.resolved).toEqual([1]);
  });

  it('drops a draft made on a different reading (the page was read again)', () => {
    const d = packPage(reading, [{...reading[0], drawer: 82}, reading[1]], []);
    const reread = [{...reading[0], drawer: 82}, reading[1]];
    expect(readingId(reread)).not.toBe(readingId(reading));
    expect(unpackPage(reread, d)).toBeNull();
  });

  it('ignores malformed drafts and out-of-range flags', () => {
    expect(parseDraft('not json')).toBeNull();
    expect(parseDraft('{"v":2,"pages":{}}')).toBeNull();
    expect(unpackPage(reading, {reading: readingId(reading), values: [[1, 2, 3, 4, 5]], resolved: []})).toBeNull();
    const ok = unpackPage(reading, {reading: readingId(reading), values: reading.map(() => [1, null, null, null, 1]), resolved: [0, 9, -1]});
    expect([...(ok?.resolved ?? [])]).toEqual([0]);
  });
});
