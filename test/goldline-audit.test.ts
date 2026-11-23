import {describe, expect, it} from 'vitest';
import {AUDIT_META, AUDIT_STATES, auditMatrix, auditState, auditSummary, productRollup, type AuditInput} from '../src/goldline-audit';

// Justin's notebook matrix (Nov 23): Watsons · Inventory · PO → state.
describe('auditState', () => {
  it.each([
    [true, true, true, 'ok'],
    [true, false, true, 'form_missing'],
    [false, true, true, 'no_sales'],
    [false, false, true, 'delivery_check'],
    [true, true, false, 'phasing_out'],
    [true, false, false, 'accounting'],
    [false, true, false, 'watsons_audit'],
    [false, false, false, 'retire_candidate'],
  ] as const)('W=%s I=%s PO=%s → %s', (w, i, p, state) => {
    expect(auditState(w, i, p)).toBe(state);
    expect(AUDIT_META[state].legs).toEqual({watsons: w, inventory: i, po: p});
  });
});

describe('auditMatrix', () => {
  const inp = (p: Partial<AuditInput> & {item_code: string}): AuditInput => ({onForm: false, onPo: false, ...p});

  it('a counted zero is Inventory no (decided Nov 23)', () => {
    const [c] = auditMatrix([inp({item_code: 'A', onPo: true, onForm: true, onHand: 0, units: 3})]);
    expect(c).toMatchObject({inInventory: false, onHand: 0, state: 'form_missing'});
  });

  it('every PO product gets a row; inactive ones only when on the form or selling', () => {
    const cells = auditMatrix([
      inp({item_code: 'ACTIVE_NOTHING', onPo: true}), // row 4: check delivery
      inp({item_code: 'GONE'}), // inactive, nothing anywhere, not on the form → no row
      inp({item_code: 'ZERO', onForm: true, onHand: 0}), // row 8: still printed, stock hit zero
      inp({item_code: 'SOLD', units: 2}), // row 6: accounting
    ]);
    expect(Object.fromEntries(cells.map((c) => [c.item_code, c.state]))).toEqual({
      ACTIVE_NOTHING: 'delivery_check',
      ZERO: 'retire_candidate',
      SOLD: 'accounting',
    });
  });

  it('sorts in the notebook order (active group first)', () => {
    const cells = auditMatrix([
      inp({item_code: 'Z', onForm: true, onHand: 0}),
      inp({item_code: 'B', onPo: true, onForm: true, onHand: 5, units: 1}),
      inp({item_code: 'A', onPo: true}),
    ]);
    expect(cells.map((c) => c.state)).toEqual(['ok', 'delivery_check', 'retire_candidate']);
  });

  it('summary counts every state and what needs a step', () => {
    const s = auditSummary(
      auditMatrix([
        inp({item_code: 'A', onPo: true, onForm: true, onHand: 1, units: 1}), // ok
        inp({item_code: 'B', onForm: true, onHand: 3, units: 1}), // phasing out
        inp({item_code: 'C', onPo: true}), // delivery check
      ]),
    );
    expect(s.total).toBe(3);
    expect(s.needsAction).toBe(1);
    expect(AUDIT_STATES.reduce((a, k) => a + s[k], 0)).toBe(3);
  });
});

describe('productRollup', () => {
  it('counts stores per state and orders active products with the most steps first', () => {
    const rows = productRollup([
      {item_code: 'X', state: 'ok', onPo: true},
      {item_code: 'Y', state: 'no_sales', onPo: true},
      {item_code: 'Y', state: 'delivery_check', onPo: true},
      {item_code: 'Z', state: 'accounting', onPo: false},
    ]);
    expect(rows.map((r) => r.item_code)).toEqual(['Y', 'X', 'Z']);
    expect(rows[0]).toMatchObject({stores: 2, needsAction: 2});
    expect(rows[0].counts.no_sales).toBe(1);
  });
});
