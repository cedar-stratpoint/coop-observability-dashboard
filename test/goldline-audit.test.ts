import {describe, expect, it} from 'vitest';
import {auditMatrix, auditState, auditSummary, AUDIT_ACTION, type AuditInput} from '../src/goldline-audit';

describe('auditState', () => {
  it('maps the two legs to a matrix state', () => {
    expect(auditState(true, true)).toBe('matched');
    expect(auditState(true, false)).toBe('no_sales');
    expect(auditState(false, true)).toBe('not_counted');
  });
});

describe('auditMatrix', () => {
  const inp = (p: Partial<AuditInput> & {item_code: string}): AuditInput => ({inForm: false, inWatsons: false, ...p});
  it('drops SKUs in neither leg, keeps the rest', () => {
    const cells = auditMatrix([
      inp({item_code: 'A', inForm: true, inWatsons: true}),
      inp({item_code: 'B'}), // neither → dropped
    ]);
    expect(cells.map((c) => c.item_code)).toEqual(['A']);
  });
  it('sorts mismatches first (not_counted, no_sales, matched), then by code', () => {
    const cells = auditMatrix([
      inp({item_code: 'M1', inForm: true, inWatsons: true}),
      inp({item_code: 'NC1', inWatsons: true, units: 5}),
      inp({item_code: 'NS1', inForm: true, onHand: 3}),
      inp({item_code: 'M2', inForm: true, inWatsons: true}),
    ]);
    expect(cells.map((c) => `${c.item_code}:${c.state}`)).toEqual([
      'NC1:not_counted',
      'NS1:no_sales',
      'M1:matched',
      'M2:matched',
    ]);
  });
  it('carries units and onHand through, defaulting units to 0', () => {
    const [c] = auditMatrix([inp({item_code: 'A', inWatsons: true, units: 12})]);
    expect(c).toMatchObject({item_code: 'A', inForm: false, inWatsons: true, units: 12, state: 'not_counted'});
    const [d] = auditMatrix([inp({item_code: 'B', inForm: true, onHand: 7, units: null})]);
    expect(d).toMatchObject({units: 0, onHand: 7, state: 'no_sales'});
  });
});

describe('auditSummary', () => {
  it('tallies the states', () => {
    const cells = auditMatrix([
      {item_code: 'A', inForm: true, inWatsons: true},
      {item_code: 'B', inForm: true, inWatsons: false},
      {item_code: 'C', inForm: false, inWatsons: true},
      {item_code: 'D', inForm: false, inWatsons: true},
    ]);
    expect(auditSummary(cells)).toEqual({matched: 1, no_sales: 1, not_counted: 2, total: 4});
  });
});

describe('AUDIT_ACTION', () => {
  it('has a plain-language action for every state', () => {
    expect(AUDIT_ACTION.matched).toMatch(/no action/i);
    expect(AUDIT_ACTION.no_sales).toMatch(/watsons/i);
    expect(AUDIT_ACTION.not_counted).toMatch(/accounting/i);
  });
});
