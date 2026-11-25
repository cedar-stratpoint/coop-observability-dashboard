// RET-14: Ask Coop's list_crm_customers takes `voucher`, the Website CRM page's Voucher filter (same voucherMatch): a code used on ANY order.
import {describe, expect, it} from 'vitest';
import {crmCustomersResult, readCustomersInput, type CrmGet} from '../src/chat/crm/tools';
import {CRM_BODIES, ORDERS, fakeCrmClient} from './support/crm-fixtures';

const NOW = new Date('2026-10-07T04:00:00Z');
const withCodes = (o: (typeof ORDERS)[number], codes: string[]) => ({...o, raw: JSON.stringify({discount_codes: codes.map((code) => ({code, amount: '300.00'}))})});
// Ana (c1): #1001 GRAND300 (her 2nd, newest order), #1003 no code. Ben (c2): #1002 no code.
const orders = [withCodes(ORDERS[0], ['GRAND300']), withCodes(ORDERS[1], []), withCodes(ORDERS[2], [])];
const get = (): CrmGet => (e) => fakeCrmClient({...CRM_BODIES, orders: {orders}}).client.get(e);
const BASE = {joined_from: '', joined_to: '', tier: 'all', buyers: 'all', group_by: 'none', sort: 'spend_desc', limit: 10, offset: 0};
const ok = <T,>(v: T | {error: string}): T => {
  if (v && typeof v === 'object' && 'error' in v) throw new Error(v.error);
  return v as T;
};

describe('list_crm_customers voucher (RET-14)', () => {
  it('normalises the input: "" = no filter, any/none lower case, a code upper case; long text is refused', () => {
    expect(ok(readCustomersInput(BASE)).voucher).toBe('all');
    expect(ok(readCustomersInput({...BASE, voucher: ' grand300 '})).voucher).toBe('GRAND300');
    expect(ok(readCustomersInput({...BASE, voucher: 'NONE'})).voucher).toBe('none');
    expect(readCustomersInput({...BASE, voucher: 'x'.repeat(41)})).toEqual({error: expect.stringMatching(/voucher must be/)});
  });
  it('lists the customers who used a code on any order, with name and email', async () => {
    const r = await crmCustomersResult(ok(readCustomersInput({...BASE, voucher: 'grand300'})), get(), NOW);
    expect(r.rows.map((x) => [x.name, x.email])).toEqual([['Ana Cruz', 'ana@example.com']]);
  });
  it('"none" lists buyers who never used a code', async () => {
    const r = await crmCustomersResult(ok(readCustomersInput({...BASE, voucher: 'none'})), get(), NOW);
    expect(r.rows.map((x) => x.email)).toEqual(['ben@example.com']);
  });
});
