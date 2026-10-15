import {describe, expect, it} from 'vitest';
import {tableBasisNotes} from '../src/chat/explore/basis';

describe('2.5 basis caveat written by code from the parsed tables', () => {
  it('names the order and stock basis from the relations read', () => {
    expect(tableBasisNotes(['pos_orders_completed'])).toEqual(['Basis: completed orders only (status = completed, the pos_orders_completed default).']);
    expect(tableBasisNotes(['pos_orders'])).toEqual(['Basis: all orders (pos_orders), including voided ones unless the query filters status.']);
    expect(tableBasisNotes(['coop_explore_stock_event', 'pos_products'])).toEqual(['Basis: Event (sellable) stock only.']);
    expect(tableBasisNotes(['pos_inventory'])).toEqual(['Basis: stock at all locations (event + office).']);
    expect(tableBasisNotes(['coop_explore_inventory_by_location'])).toEqual(['Basis: stock per location.']);
    expect(tableBasisNotes(['spin_wheel_leads'])).toEqual([]);
  });
});
