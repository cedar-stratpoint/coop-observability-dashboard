import {describe, expect, it} from 'vitest';
import {
  AUDIT_META,
  AUDIT_STATES,
  auditCell,
  auditRows,
  auditState,
  auditSummary,
  MATRIX_STATES,
  NEEDS_ACTION,
  openingState,
  parsePattern,
  patternState,
  productRollup,
  rankedSteps,
  recoAction,
  recoLetterOf,
  skuLines,
  type AuditCell,
  type AuditInput,
  type SearchableRow,
} from '../src/goldline-audit';

const Y = 'yes' as const;
const N = 'no' as const;
const U = 'unknown' as const;
const inp = (p: Partial<AuditInput> = {}): AuditInput => ({item_code: 'A', watsons: 3, inventory: 5, po: true, onForm: true, ...p});

// Justin's notebook matrix (Nov 23) and the recommendation each row carries (Nov 24).
describe('auditState', () => {
  it.each([
    [Y, Y, Y, 'ok', 'Keep'],
    [Y, N, Y, 'form_missing', 'Add to form'],
    [N, Y, Y, 'no_sales', 'Watsons to audit'],
    [N, N, Y, 'delivery_check', 'Check delivery'],
    [Y, Y, N, 'phasing_out', 'Retire, sell through'],
    [Y, N, N, 'accounting', 'Send to accounting'],
    [N, Y, N, 'watsons_audit', 'Report to Watsons'],
    [N, N, N, 'retire_candidate', 'Flag to retire'],
  ] as const)('W=%s I=%s PO=%s → %s', (w, i, p, state, label) => {
    expect(auditState(w, i, p)).toBe(state);
    expect(AUDIT_META[state].legs).toEqual({watsons: w, inventory: i, po: p});
    expect(AUDIT_META[state].label).toBe(label);
  });

  it('any unknown leg means no recommendation', () => {
    for (const [w, i, p] of [[U, Y, Y], [Y, U, N], [N, N, U], [U, U, U]] as const) expect(auditState(w, i, p)).toBe('unknown');
  });
});

describe('auditCell', () => {
  it('missing data is never read as a no', () => {
    for (const [p, why] of [
      [{watsons: 'month_not_loaded'}, 'month_not_loaded'],
      [{watsons: 'store_not_in_file'}, 'store_not_in_file'],
      [{watsons: 'not_linked'}, 'not_linked'],
      [{inventory: 'blank'}, 'blank'],
      [{inventory: 'page_missing'}, 'page_missing'],
      [{po: 'no_po_form'}, 'no_po_form'],
    ] as Array<[Partial<AuditInput>, string]>) {
      expect(auditCell(inp(p))).toMatchObject({state: 'unknown', reco: 'Can’t tell yet', why: [why]});
    }
  });

  it('with one mark missing, says which two it is between', () => {
    expect(auditCell(inp({po: false, inventory: 'blank'}))!.between).toEqual(['Retire, sell through', 'Send to accounting']);
    expect(auditCell(inp({watsons: 'month_not_loaded', inventory: 'blank'}))!.between).toEqual([]); // two missing: any of four
  });

  it('a counted zero is a no (decided Nov 23); returns that net to nothing are no sale', () => {
    expect(auditCell(inp({inventory: 0, watsons: 0}))).toMatchObject({inventory: 'no', watsons: 'no', state: 'delivery_check'});
    expect(auditCell(inp({watsons: -2}))).toMatchObject({watsons: 'no', units: -2});
  });

  it('a counted zero that sold is sold out, not missing from the form', () => {
    const restock = auditCell(inp({inventory: 0}))!;
    expect(restock).toMatchObject({state: 'form_missing', reco: 'Restock'});
    expect(recoAction(restock)).toMatch(/counted zero/);
    expect(auditCell(inp({inventory: 'absent', onForm: false}))).toMatchObject({state: 'form_missing', reco: 'Add to form'});
    expect(auditCell(inp({inventory: 0, po: false}))).toMatchObject({state: 'accounting', reco: 'Flag to retire'});
    expect(auditCell(inp({inventory: 'absent', onForm: false, po: false}))).toMatchObject({state: 'accounting', reco: 'Send to accounting'});
  });

  it('leaves out lines with nothing to say', () => {
    expect(auditCell(inp({po: false, watsons: 0, inventory: 'absent', onForm: false}))).toBeNull(); // nothing anywhere
    expect(auditCell(inp({inventory: 'no_count', watsons: 0, onForm: false}))).toBeNull(); // uncounted store, didn't sell it
    expect(auditCell(inp({inventory: 'no_count', watsons: 'month_not_loaded', onForm: false}))).toBeNull();
    expect(auditCell(inp({po: false, watsons: 0, inventory: 0, retired: true}))).toBeNull(); // already retired
    expect(auditCell(inp({po: false, watsons: 0, inventory: 0}))).toMatchObject({state: 'retire_candidate'}); // stock hit zero
    expect(auditCell(inp({inventory: 'no_count', onForm: false}))).toMatchObject({state: 'unknown', why: ['no_count']}); // sold, stock unknown
  });
});

describe('tiles', () => {
  const summary = (s: Partial<Record<(typeof AUDIT_STATES)[number], number>>) => auditSummary(Object.entries(s).flatMap(([state, n]) => Array.from({length: n as number}, () => ({state: state as AuditCell['state']}))));

  it('missing data is not a step', () => {
    const s = summary({unknown: 10, ok: 2});
    expect(s).toMatchObject({needsAction: 0, total: 12});
    expect(NEEDS_ACTION.has('unknown')).toBe(false);
    expect(openingState(s)).toBe('unknown'); // never "nothing needs a step"
  });
  it('most urgent first; YYX is a step (Nov 24)', () => {
    const s = summary({phasing_out: 9, no_sales: 2, delivery_check: 1, unknown: 50});
    expect(rankedSteps(s)).toEqual(['delivery_check', 'no_sales', 'phasing_out']);
    expect(openingState(s)).toBe('delivery_check');
    expect(openingState(summary({ok: 3}))).toBe('ok');
  });
  it('every state is counted once', () => {
    expect(new Set(AUDIT_STATES).size).toBe(9);
    expect(MATRIX_STATES).toHaveLength(8);
  });
});

describe('patterns', () => {
  it.each([
    ['YYX', 'phasing_out'],
    [' yyx ', 'phasing_out'],
    ['Y Y N', 'phasing_out'],
    ['✓✓✗', 'phasing_out'],
    ['xxx', 'retire_candidate'],
  ])('%s is a tile', (q, state) => expect(patternState(q)).toBe(state));
  it('a ? is a pattern but not a tile; ordinary text is neither', () => {
    expect(parsePattern('Y?X')).toEqual({watsons: 'yes', inventory: 'unknown', po: 'no'});
    expect(patternState('Y?X')).toBeNull();
    for (const q of ['', 'YY', 'YYXX', 'lip', 'MUR', '473']) expect(parsePattern(q)).toBeNull();
  });
});

describe('auditRows', () => {
  const row = (store: string, product: string, p: Partial<AuditInput>): SearchableRow => ({...auditCell(inp({item_code: product.toUpperCase(), ...p}))!, store, storeName: `SM ${store}`, product});
  const rows = [
    row('10', 'Beta', {po: false, inventory: 4, watsons: 1}),
    row('2', 'Alpha', {po: false, inventory: 9, watsons: 7}),
    row('2', 'Gamma', {po: false, inventory: 'blank', watsons: 2}),
    row('3', 'Delta', {}),
  ];
  const run = (p: Partial<Parameters<typeof auditRows>[1]>) => auditRows(rows, {state: 'phasing_out', q: '', sort: 'reco', dir: 'asc', ...p}).map((r) => `${r.store}:${r.product}`);

  it('lists the picked state across stores', () => expect(run({})).toEqual(['2:Alpha', '10:Beta']));
  it('YYX lists exactly that tile; Y?X finds the lines still missing a count', () => {
    expect(run({q: 'YYX', state: 'ok'})).toEqual(run({}));
    expect(run({q: 'y?x'})).toEqual(['2:Gamma']);
  });
  it('text search spans every recommendation, by product, code or store', () => {
    expect(run({q: 'delta'})).toEqual(['3:Delta']);
    expect(run({q: 'sm 2'}).sort()).toEqual(['2:Alpha', '2:Gamma']);
  });
  it('sorts numbers both ways with unknowns last, and stores in number order', () => {
    expect(run({sort: 'units', dir: 'desc'})).toEqual(['2:Alpha', '10:Beta']);
    expect(run({sort: 'store'})).toEqual(['2:Alpha', '10:Beta']);
    expect(run({q: 'sm', sort: 'onHand', dir: 'asc'}).at(-1)).toBe('2:Gamma');
    expect(run({q: 'sm', sort: 'onHand', dir: 'desc'}).at(-1)).toBe('2:Gamma');
  });
  it('does not reorder the input', () => {
    const before = rows.map((r) => r.product);
    run({sort: 'product', dir: 'desc'});
    expect(rows.map((r) => r.product)).toEqual(before);
  });
});

describe('productRollup', () => {
  it('counts stores per state, the most steps first', () => {
    const r = productRollup([
      {item_code: 'X', state: 'ok', po: 'yes'},
      {item_code: 'Y', state: 'no_sales', po: 'yes'},
      {item_code: 'Y', state: 'unknown', po: 'yes'},
    ]);
    expect(r.map((x) => x.item_code)).toEqual(['Y', 'X']);
    expect(r[0]).toMatchObject({stores: 2, needsAction: 1});
  });
});

describe('what the unknown lines are missing (Nov 25)', () => {
  const rows: SearchableRow[] = [
    {...auditCell(inp({item_code: 'A', watsons: 'month_not_loaded', inventory: 'blank'}))!, store: '1', storeName: null, product: 'A'},
    {...auditCell(inp({item_code: 'B', watsons: 'month_not_loaded'}))!, store: '1', storeName: null, product: 'B'},
    {...auditCell(inp({item_code: 'C', inventory: 'page_missing'}))!, store: '1', storeName: null, product: 'C'},
    {...auditCell(inp({item_code: 'D'}))!, store: '1', storeName: null, product: 'D'},
  ];
  it('counts each reason over the unknown lines (a line can miss two)', () => {
    const s = auditSummary(rows);
    expect(s.unknown).toBe(3);
    expect(s.why).toMatchObject({month_not_loaded: 2, blank: 1, page_missing: 1, not_linked: 0});
  });
  it('a reason narrows "Can’t tell yet" to the lines missing it', () => {
    const run = (why: Parameters<typeof auditRows>[1]['why']) => auditRows(rows, {state: 'unknown', why, q: '', sort: 'product', dir: 'asc'}).map((r) => r.item_code);
    expect(run(null)).toEqual(['A', 'B', 'C']);
    expect(run('month_not_loaded')).toEqual(['A', 'B']);
    expect(run('blank')).toEqual(['A']);
  });
  it('the reason is ignored for any other state', () => {
    expect(auditRows(rows, {state: 'ok', why: 'blank', q: '', sort: 'product', dir: 'asc'}).map((r) => r.item_code)).toEqual(['D']);
  });
});

describe('Reco A to D (Syl, Nov 25)', () => {
  const at = (p: Partial<AuditInput>) => auditCell(inp(p))!;
  it('maps each state to its letter and C covers both Watsons states', () => {
    expect(recoLetterOf(at({po: false, watsons: 3, inventory: 5}))).toBe('A');
    expect(recoLetterOf(at({po: false, watsons: 3, inventory: 'absent'}))).toBe('B');
    expect(recoLetterOf(at({po: true, watsons: 0, inventory: 5}))).toBe('C');
    expect(recoLetterOf(at({po: false, watsons: 0, inventory: 5}))).toBe('C');
    expect(recoLetterOf(at({po: true, watsons: 3, inventory: 'absent'}))).toBe('D');
    expect(recoLetterOf(at({po: true, watsons: 3, inventory: 5}))).toBeNull();
    expect(recoLetterOf(at({po: true, watsons: 0, inventory: 0}))).toBeNull();
  });
  it('a sold-out line is in no letter (Restock, Flag to retire)', () => {
    expect(at({po: true, watsons: 3, inventory: 0}).reco).toBe('Restock');
    expect(recoLetterOf(at({po: true, watsons: 3, inventory: 0}))).toBeNull();
    expect(recoLetterOf(at({po: false, watsons: 3, inventory: 0}))).toBeNull();
  });
  it('the summary counts letters', () => {
    const s = auditSummary([at({po: false, watsons: 0, inventory: 5}), at({po: true, watsons: 0, inventory: 2}), at({po: false, watsons: 3, inventory: 5})]);
    expect(s.letters).toEqual({A: 1, B: 0, C: 2, D: 0});
  });
  it('a letter filters the rows; a search overrides it', () => {
    const row = (store: string, product: string, p: Partial<AuditInput>): SearchableRow => ({...at({item_code: product.toUpperCase(), ...p}), store, storeName: null, product});
    const rows = [row('1', 'Alpha', {po: true, watsons: 0, inventory: 5}), row('2', 'Beta', {po: false, watsons: 0, inventory: 1}), row('3', 'Gamma', {po: false, watsons: 3, inventory: 5})];
    const run = (reco: 'A' | 'C', q = '') => auditRows(rows, {state: 'ok', reco, q, sort: 'product', dir: 'asc'}).map((r) => r.product);
    expect(run('C')).toEqual(['Alpha', 'Beta']);
    expect(run('A')).toEqual(['Gamma']);
    expect(run('A', 'beta')).toEqual(['Beta']);
  });
});

describe('skuLines', () => {
  it('groups lines per product with its stores, recommendations and totals', () => {
    const base = {product: 'Gold Frost', reco: 'Watsons to audit', units: 0};
    const out = skuLines([
      {item_code: 'T1', store: '473', onHand: 2, ...base},
      {item_code: 'T2', store: '10', onHand: null, product: 'Pink', reco: 'Report to Watsons', units: null},
      {item_code: 'T1', store: '5300', onHand: 3, ...base, reco: 'Report to Watsons'},
    ]);
    expect(out).toEqual([
      {item_code: 'T1', product: 'Gold Frost', recos: ['Watsons to audit', 'Report to Watsons'], stores: ['473', '5300'], units: 0, onHand: 5},
      {item_code: 'T2', product: 'Pink', recos: ['Report to Watsons'], stores: ['10'], units: null, onHand: null},
    ]);
  });
});
