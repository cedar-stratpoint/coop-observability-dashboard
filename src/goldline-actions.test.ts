import {describe, expect, it} from 'vitest';
import {buildActions} from './goldline-actions';
import {storeMovement, type Count} from './goldline-movement';
import type {InventoryRowIn} from './goldline-inventory';

const r = (item_code: string, onHand: number | null, delivery: number | null = null): InventoryRowIn => ({
  item_code,
  stockroom: onHand,
  drawer: null,
  selling_area: null,
  delivery,
  ending_on_hand: null,
});
const c = (start: string, end: string, rows: InventoryRowIn[]): Count => ({period_start: start, period_end: end, rows});
const catalog = {OUT: {name: 'BB 02 Skin', price: 238}, LOW: {name: '#2 Natural', price: 185}, DEAD: {name: 'Pink Champagne', price: 88}, OK: {name: 'Salmon', price: 150}};

describe('buildActions', () => {
  const m = storeMovement([
    c('2026-09-01', '2026-09-15', [r('OUT', 30), r('LOW', 60), r('DEAD', 23), r('OK', 100)]),
    c('2026-09-16', '2026-09-30', [r('OUT', 18), r('LOW', 38), r('DEAD', 23), r('OK', 95)]),
    c('2026-10-01', '2026-10-15', [r('OUT', 0), r('LOW', 9), r('DEAD', 23), r('OK', 90)]),
  ]);
  const base = {storeCode: '1', items: m.items, catalog, currentPeriod: {start: '2026-10-01', end: '2026-10-15'}, lastCountEnd: '2026-10-15'};

  it('ranks critical first, then by pesos at stake', () => {
    const a = buildActions({...base, countedCurrent: true});
    expect(a.map((x) => [x.kind, x.severity, x.itemCode])).toEqual([
      ['reorder', 'critical', 'OUT'],
      ['reorder', 'warn', 'LOW'],
      ['dead', 'info', 'DEAD'],
    ]);
    expect(a[0].title).toBe('BB 02 Skin is out of stock');
    expect(a[2].detail).toMatch(/₱2,024 tied up/);
  });

  it('a store without this period\'s count gets only the missing-count action', () => {
    const a = buildActions({...base, countedCurrent: false});
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({kind: 'gap', severity: 'critical'});
    expect(a[0].title).toMatch(/Oct 1 to Oct 15/);
  });

  it('is empty when nothing needs doing', () => {
    expect(buildActions({...base, items: m.items.filter((i) => i.item_code === 'OK'), countedCurrent: true})).toEqual([]);
  });
});
