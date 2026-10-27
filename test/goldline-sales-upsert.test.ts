import {beforeEach, describe, expect, it, vi} from 'vitest';

// upsertSales writes through the upsert_sales RPC (which encrypts the peso figures with
// the Vault key, supabase/nichido/s1_sales_encryption.sql), never straight into sales.
const rpc = vi.hoisted(() => vi.fn(async () => ({data: 0, error: null as {message: string} | null})));
const from = vi.hoisted(() => vi.fn());

vi.mock('server-only', () => ({}));
vi.mock('../src/nichido-client', () => ({
  nichidoConfigured: () => true,
  nichidoDb: () => ({rpc, from}),
}));

import type {PosSaleRow} from '../src/goldline-csv';
import {upsertSales} from '../src/goldline-data';

const row = (i: number): PosSaleRow => ({
  storeCode: `S${i}`,
  storeName: 'Store',
  skuCode: `K${i}`,
  skuDesc: 'Sku',
  grossRetail: 100 + i,
  units: i,
  netOfVat: 90 + i,
});

describe('upsertSales', () => {
  beforeEach(() => {
    rpc.mockClear();
    from.mockClear();
  });

  it('sends rows to upsert_sales, not a direct table write', async () => {
    const n = await upsertSales('goldline', [row(1)], {start: '2026-09-01', end: '2026-09-30'}, 'u-1');
    expect(n).toBe(1);
    expect(from).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledWith('upsert_sales', {
      p_company: 'goldline',
      p_rows: [
        {
          store_code: 'S1',
          sku_code: 'K1',
          period_start: '2026-09-01',
          period_end: '2026-09-30',
          gross_retail: 101,
          units: 1,
          net_of_vat: 91,
          source_upload_id: 'u-1',
        },
      ],
    });
  });

  it('chunks a big month into 2000-row calls', async () => {
    const rows = Array.from({length: 4500}, (_, i) => row(i));
    expect(await upsertSales('goldline', rows, {start: '2026-09-01', end: '2026-09-30'}, 'u-1')).toBe(4500);
    expect(rpc.mock.calls.map((c) => (c as unknown as [string, {p_rows: unknown[]}])[1].p_rows.length)).toEqual([2000, 2000, 500]);
  });

  it('throws when the database refuses a chunk', async () => {
    rpc.mockResolvedValueOnce({data: 0, error: {message: 'goldline_sales_key missing from Vault'}});
    await expect(upsertSales('goldline', [row(1)], {start: '2026-09-01', end: '2026-09-30'}, 'u-1')).rejects.toThrow(
      'sales upsert failed: goldline_sales_key missing from Vault',
    );
  });

  it('does nothing for an empty file', async () => {
    expect(await upsertSales('goldline', [], {start: '2026-09-01', end: '2026-09-30'}, 'u-1')).toBe(0);
    expect(rpc).not.toHaveBeenCalled();
  });
});
