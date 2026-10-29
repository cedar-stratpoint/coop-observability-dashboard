import {describe, expect, it} from 'vitest';
import {buildActivity, type LogEntry} from '../src/goldline-sku-activity';

const names = {skuName: (s: string) => (s === '38005998' ? 'Elise Diva Lashes' : 'Pressed Powder Tan'), itemName: (i: string) => (i === 'ACCSBELTBAG' ? 'Accessories · Belt Bag' : i)};
const log = (o: Partial<LogEntry>): LogEntry => ({id: 1, target: 'sku', key: '38005998', action: 'approved', summary: 'EDNH4291', done_by: 'Justin', done_at: '2026-10-29T03:00:00Z', undone_by: null, undone_at: null, ...o});

describe('SKU linking activity', () => {
  it('words each decision and lists newest first', () => {
    const a = buildActivity({
      ...names,
      log: [log({}), log({id: 2, key: '50027500', action: 'linked', summary: 'ELDF03', done_at: '2026-10-29T04:00:00Z'}), log({id: 3, target: 'item', key: 'ACCSBELTBAG', action: 'note', summary: null, done_at: '2026-10-29T05:00:00Z', noteRemoved: true})],
      reviews: [],
      notes: [],
      retired: [],
    });
    expect(a.map((e) => e.text)).toEqual([
      'Removed the note on Accessories · Belt Bag (ACCSBELTBAG)',
      'Chose ELDF03 for Pressed Powder Tan (50027500)',
      "Approved Coop's match EDNH4291 for Elise Diva Lashes (38005998)",
    ]);
  });

  it('adds an undo as its own event, after the decision', () => {
    const a = buildActivity({...names, log: [log({undone_by: 'Lance', undone_at: '2026-10-29T03:10:00Z'})], reviews: [], notes: [], retired: []});
    expect(a[0]).toMatchObject({kind: 'undo', by: 'Lance', text: "Undid: approved Coop's match EDNH4291 for Elise Diva Lashes (38005998)"});
    expect(a[1].kind).toBe('approved');
  });

  it('keeps older history from reviews, without doubling a logged decision', () => {
    const a = buildActivity({
      ...names,
      log: [log({})],
      reviews: [
        {sku_code: '38005998', action: 'approved', item_code: 'EDNH4291', action_by: 'Justin', action_at: '2026-10-29T03:00:02Z', remark: null, remark_by: null, remark_at: null},
        {sku_code: '38026223', action: 'rejected', item_code: 'MPEPTE', action_by: 'Sylvester', action_at: '2026-10-28T09:00:00Z', remark: 'wrong shade', remark_by: 'Sylvester', remark_at: '2026-10-28T09:00:00Z'},
      ],
      notes: [{item_code: 'ACCSBELTBAG', note_by: 'Lance', note_at: '2026-10-27T01:00:00Z'}],
      retired: [{item_code: 'ELDF03', retired_by: 'Lance', retired_at: '2026-10-26T01:00:00Z'}],
    });
    expect(a.map((e) => e.kind)).toEqual(['approved', 'rejected', 'note', 'decommissioned']);
    expect(a[1].text).toBe('Rejected MPEPTE for Pressed Powder Tan (38026223)');
  });

  it('counts a remark saved on its own as a separate event', () => {
    const a = buildActivity({
      ...names,
      log: [],
      reviews: [{sku_code: '38005998', action: 'approved', item_code: 'EDNH4291', action_by: 'Justin', action_at: '2026-10-28T01:00:00Z', remark: 'checked on shelf', remark_by: 'Justin', remark_at: '2026-10-29T01:00:00Z'}],
      notes: [],
      retired: [],
    });
    expect(a.map((e) => e.kind)).toEqual(['remark', 'approved']);
  });
});
