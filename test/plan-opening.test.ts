// Opening balances, with made-up numbers only (the repo is public). They are typed by an admin: the plan workbook's opening values are plan assumptions,
// never actuals (BHR-06), so nothing prefills them. Opening cash, settlement, freight and funding are unknown until typed and stay empty.
import {describe, expect, it} from 'vitest';
import {GAP, LINES, ALL_LINE_IDS, cashSeries, customerSeries, derivedActuals, filledCount, inventorySeries, lineInputText, monthComplete, nextEmptyLine, validateLine, type ActualCell} from '../src/plan-compute';

const ok = (value: number): ActualCell => ({value, state: 'ok'});
const RATES = {repeatRate: 0.1, aov: 500};

describe('the opening balances are editable typed measures, first month only, never needed to close', () => {
  it('are known lines in the right unit, and cannot be negative', () => {
    expect(ALL_LINE_IDS).toContain('opening_inventory');
    expect(ALL_LINE_IDS).toContain('opening_customers');
    expect(validateLine('opening_inventory', 410_000)).toBeNull();
    expect(validateLine('opening_inventory', -1)).toBe('Opening stock cannot be negative.');
    expect(validateLine('opening_customers', 420)).toBeNull();
    expect(validateLine('opening_customers', -1)).toBe('Opening customers cannot be negative.');
    expect(lineInputText('opening_inventory', 410_000)).toBe('410');
    expect(lineInputText('opening_customers', 420)).toBe('420');
  });
  it('are not among the lines that gate Close month', () => {
    const all = Object.fromEntries(LINES.map((l) => [l.id, [1]]));
    expect(monthComplete(all, 0)).toBe(true);
    expect(filledCount({...all, opening_inventory: [410_000], opening_customers: [420]}, 0)).toBe(21);
    expect(nextEmptyLine({opening_inventory: [410_000], opening_customers: [420]}, 0)).not.toMatch(/opening/);
  });
  it('typed funding counts for its own month only', () => {
    const lines = {bridge_funding: [null, 1_500_000, null]};
    expect(filledCount(lines, 1)).toBe(1);
    expect(filledCount(lines, 0)).toBe(0);
    expect(filledCount(lines, 2)).toBe(0);
    expect(monthComplete(lines, 1)).toBe(false); // one line of 21 does not make a month closable
    expect(nextEmptyLine(lines, 1)).not.toBe('bridge_funding');
    expect(nextEmptyLine(lines, 0)).toBeTruthy();
  });
});

describe('derived rows use the typed opening balance and wait without one', () => {
  it('stock on hand starts from the typed opening stock; with none typed it waits, never a guess', () => {
    const base = {inv_purchases_paid: [100], cogs: [40]};
    expect(inventorySeries(base, 1)[0]).toEqual(GAP);
    expect(inventorySeries({...base, opening_inventory: [410_000]}, 1)[0].value).toBe(410_060);
    expect(inventorySeries({...base, opening_inventory: [500_000]}, 1)[0].value).toBe(500_060);
    expect(inventorySeries({...base, opening_inventory: [0]}, 1)[0].value).toBe(60); // a typed 0 is a real 0
  });
  it('active customers start from the typed opening base; with none typed they wait', () => {
    const g = [ok(0), ok(0)];
    expect(customerSeries(g, g, {}, RATES).customers[0]).toEqual(GAP);
    expect(customerSeries(g, g, {opening_customers: [420]}, RATES).customers[0].value).toBe(420);
    expect(customerSeries(g, g, {opening_customers: [650]}, RATES).customers[0].value).toBe(650);
    expect(derivedActuals({months: ['2026-08-01', '2026-09-01'], targets: {}}, {}, {opening_customers: [650]}).customers[0].value).toBe(650);
  });
  it('without the repeat rate and order value (not loaded) the roll stops after month one, never a guess', () => {
    const g = [ok(1000), ok(1000)];
    const r = customerSeries(g, g, {opening_customers: [420]}, {repeatRate: null, aov: null});
    expect(r.customers[0].value).toBe(420);
    expect(r.customers[1]).toEqual(GAP);
    expect(r.cac).toEqual([GAP, GAP]);
  });
});

describe('cash: funding of 1,500k counts exactly as the workbook formula, but cash never exists without the opening cash', () => {
  const e = (v: number) => ok(v);
  const m = (n: number) => Array(n).fill(0);
  const lines = (over: Record<string, (number | null)[]> = {}) => ({cogs: m(2), inv_purchases_paid: m(2), liability_settlement: m(2), freight_onetime: m(2), bridge_funding: [0, 1_500_000], ...over});
  it('with an opening cash, Sep cash = Aug cash + EBITDA stuff + 1,500k', () => {
    const c = cashSeries([e(-100), e(-100)], {...lines(), opening_cash: [1000]});
    expect(c.map((x) => x.value)).toEqual([900, 1_500_800]);
  });
  it('without the opening cash every month waits, even with the funding in', () => {
    expect(cashSeries([e(-100), e(-100)], lines())).toEqual([GAP, GAP]);
  });
  it('the unknown lines stay missing and block cash: no settlement/freight typed means waiting', () => {
    const c = cashSeries([e(-100), e(-100)], {...lines({liability_settlement: [null, null]}), opening_cash: [1000]});
    expect(c.map((x) => x.value)).toEqual([null, null]);
  });
});
