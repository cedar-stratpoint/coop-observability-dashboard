import {describe, expect, it} from 'vitest';
import {parseAuditFields, planAudit, type LinkState} from '../src/goldline-audit-answers';

const state = (o: Partial<LinkState> = {}): LinkState => ({
  linkedItemBySku: new Map(),
  skuByItem: new Map(),
  suggestionBySku: new Map([
    ['38006108', 'LQFD091'],
    ['38006204', 'TCES1731'],
  ]),
  knownSkus: new Set(['38006108', '38006204', '38006202', '70075146']),
  knownItems: new Set(['LQFD091', 'TCES1731', 'RELB2011', 'MUBBEP']),
  ...o,
});

describe('audit answers', () => {
  it('reads every part of the worksheet', () => {
    const a = parseAuditFields({
      'A~38006108~LQFD091.answer': 'Correct',
      'A~38006108~LQFD091.notes': ' same shade ',
      'A~38006204~TCES1731.answer': 'Wrong',
      'A~38006204~TCES1731.notes': '',
      'B~38006202.itemCode': 'relb2011',
      'B~38006202.formPage': '3',
      'B~38006202.notes': '',
      'C~MUBBEP.answer': 'Sold at Watsons',
      'C~MUBBEP.watsonsCode': '70075146',
      'C~MUBBEP.notes': '',
      'L~38006011~ELB160.looksWrong': true,
      'L~38005996~CS0164.looksWrong': false,
    });
    expect(a.matches).toEqual([
      {sku: '38006108', item: 'LQFD091', answer: 'correct', notes: 'same shade'},
      {sku: '38006204', item: 'TCES1731', answer: 'wrong', notes: ''},
    ]);
    expect(a.picks[0]).toMatchObject({sku: '38006202', itemCode: 'relb2011'});
    expect(a.formItems[0]).toMatchObject({item: 'MUBBEP', atWatsons: 'sold', watsonsCode: '70075146'});
    expect(a.flagged).toEqual([{sku: '38006011', item: 'ELB160'}]);
  });

  it('plans approve, reject and hand links', () => {
    const plan = planAudit(
      parseAuditFields({
        'A~38006108~LQFD091.answer': 'Correct',
        'A~38006108~LQFD091.notes': 'same shade',
        'A~38006204~TCES1731.answer': 'Wrong',
        'B~38006202.itemCode': 'relb2011',
        'C~MUBBEP.watsonsCode': '7007 5146',
      }),
      state(),
    );
    expect(plan.actions).toEqual([
      {kind: 'approve', sku: '38006108', item: 'LQFD091', remark: 'same shade'},
      {kind: 'reject', sku: '38006204', item: 'TCES1731', remark: ''},
      {kind: 'link', sku: '38006202', item: 'RELB2011', remark: '', from: 'B'},
      {kind: 'link', sku: '70075146', item: 'MUBBEP', remark: '', from: 'C'},
    ]);
    expect(plan.skipped).toEqual([]);
  });

  it('never acts on a suggestion that changed after printing', () => {
    const plan = planAudit(parseAuditFields({'A~38006108~LQFD091.answer': 'Correct'}), state({suggestionBySku: new Map([['38006108', 'LQFD092']])}));
    expect(plan.actions).toEqual([]);
    expect(plan.skipped[0].why).toMatch(/changed/);
  });

  it('skips what is already done or taken, and catches unknown codes', () => {
    const plan = planAudit(
      parseAuditFields({
        'A~38006108~LQFD091.answer': 'Correct',
        'B~38006202.itemCode': 'XYZ999',
        'B~70075146.itemCode': 'LQFD091', // taken by the approve above
      }),
      state({linkedItemBySku: new Map([['38006108', 'LQFD091']]), skuByItem: new Map([['LQFD091', '38006108']])}),
    );
    expect(plan.actions).toEqual([]);
    expect(plan.skipped.map((s) => s.why)).toEqual([
      'Already linked to that item.',
      '"XYZ999" is not an item code in the catalog.',
      'LQFD091 is already linked to another Watsons SKU.',
    ]);
  });

  it('keeps "not ours" as a remark and hands people the rest', () => {
    const plan = planAudit(
      parseAuditFields({
        'B~38006202.itemCode': 'Not ours',
        'B~38006202.notes': 'promo pack',
        'C~MUBBEP.answer': 'Not sold at Watsons',
        'L~38006011~ELB160.looksWrong': true,
      }),
      state(),
    );
    expect(plan.actions).toEqual([{kind: 'remark', sku: '38006202', remark: 'Not one of ours (audit PDF). promo pack'}]);
    expect(plan.forUs.map((f) => f.where)).toEqual(['C · MUBBEP', 'Appendix · 38006011 → ELB160']);
  });
});
