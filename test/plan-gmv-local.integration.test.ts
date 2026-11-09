import {createHmac} from 'node:crypto';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {createClient} from '@supabase/supabase-js';
import {assertLocalSupabase} from './support/local-only';
import {readPosOrders} from '../src/pos-orders-read';
import {dailyRowsToDigests} from '../src/daily-sales-digests';
import {rollupChannels} from '../src/period-rollup';
import {eventsCells, marketplaceCells, totalCells, websiteCells} from '../src/plan-gmv';
import type {PosEvent} from '../src/pos-sales-types';

// LOCAL INTEGRATION (skipped unless pointed at the throwaway stack from scripts/local-supabase/up.sh):
//   set -a; source scripts/local-supabase/.local-env; set +a; npx vitest run test/plan-gmv-local.integration.test.ts
// Events come from the real pos_* tables on the local stack through the app's own reader (readPosOrders); the CRM is a stub (the harness blocks
// every remote call); marketplace days are the per-day shape the backend writes, fed through the same rollup the page uses.
const URL_ = process.env.SB_LOCAL_URL;
const SECRET = process.env.SB_LOCAL_JWT_SECRET;
if (URL_) assertLocalSupabase(URL_);
const local = !!URL_ && !!SECRET;
const MONTHS = ['2026-08-01', '2026-09-01', '2026-10-01', '2026-11-01'];
const NOW = '2026-11';
const IDS = [1, 2, 3, 4, 5].map((n) => `00000000-0000-4000-8000-0000000b03${String(n).padStart(2, '0')}`);

function jwt(role: string): string {
  const b = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const body = `${b({alg: 'HS256', typ: 'JWT'})}.${b({role, iss: 'supabase', iat: now, exp: now + 300})}`;
  return `${body}.${createHmac('sha256', SECRET!).update(body).digest('base64url')}`;
}
const sb = () => createClient(URL_!, jwt('service_role'), {auth: {persistSession: false}});

describe.skipIf(!local)('GMV actuals against the local pos_* tables', () => {
  beforeAll(async () => {
    const c = sb();
    await c.from('pos_orders').delete().in('client_uuid', IDS);
    const r = await c.from('pos_orders').insert([
      {client_uuid: IDS[0], subtotal: 30000, total: 30000, status: 'completed', created_at: '2026-08-31T23:59:00+08:00', event_id: 'EV4'},
      {client_uuid: IDS[1], subtotal: 100000, total: 100000, status: 'completed', created_at: '2026-09-01T00:00:00+08:00', event_id: 'EV1'},
      {client_uuid: IDS[2], subtotal: 5000, total: 5000, status: 'completed', created_at: '2026-09-15T12:00:00+08:00', event_id: null},
      {client_uuid: IDS[3], subtotal: 9999, total: 9999, status: 'voided', created_at: '2026-09-16T12:00:00+08:00', event_id: 'EV1'},
      {client_uuid: IDS[4], subtotal: 0, total: 0, status: 'completed', created_at: '2026-10-11T12:00:00+08:00', event_id: 'EV3'}, // a free taste
    ]);
    expect(r.error).toBeNull();
  });
  afterAll(async () => { await sb().from('pos_orders').delete().in('client_uuid', IDS); });

  async function readPos() {
    const c = sb();
    const orders = await readPosOrders(c as never);
    const ev = await c.from('pos_events').select('event_id,starts_on,ends_on');
    // the browser demo fixture (plan-gmv-fixture.sql, b02) may be loaded too: this test counts only its own rows
    return {orders: orders.filter((o) => !o.client_uuid.includes('0000000b02')), events: (ev.data ?? []) as unknown as PosEvent[]};
  }

  it('Events GMV: 31 Aug 23:59 lands in August and 1 Sep 00:00 in September; voided, non-event and a free taste add nothing', async () => {
    const cells = eventsCells(MONTHS, NOW, await readPos());
    expect(cells[0]).toMatchObject({value: 30000, state: 'ok'});
    expect(cells[1]).toMatchObject({value: 100000, state: 'ok'});
    expect(cells[2]).toMatchObject({value: 0, state: 'ok'}); // a real zero: the POS was live and this month had only a free taste
  });

  it('a stubbed CRM and a stubbed per-day marketplace feed give the other channels, and the total follows the gap rules', async () => {
    const win = {window_from: '2026-07-31T16:00:00Z', window_to: '2026-09-30T16:00:00Z', captured_at: '2026-10-05T00:00:00Z'};
    const days = Array.from({length: 31}, (_, i) => `2026-08-${String(i + 1).padStart(2, '0')}`);
    const rows = (['shopee', 'lazada'] as const).flatMap((channel) => days.map((day) => ({day, channel, revenue: 1000, orders: 1, units: 1, ...win})));
    const buckets = rollupChannels({fromDay: '2026-08-01', toDay: '2026-11-05', channels: ['shopee', 'lazada'], granularity: 'month', digests: dailyRowsToDigests(rows), website: null, offline: null});
    const marketplace = marketplaceCells(MONTHS, NOW, buckets);
    const website = websiteCells(MONTHS, NOW, {truncated: false, orders: [{createdAt: '2026-08-05T04:00:00Z', lines: [{price: 2000, quantity: 2}]}, {createdAt: '2026-08-06T04:00:00Z', lines: [{price: 1000, quantity: 1}]}]});
    expect(marketplace[0]).toMatchObject({value: 62000, state: 'ok'});
    expect(marketplace[2]).toMatchObject({value: null, state: 'gap'});
    expect(website[0]).toMatchObject({value: 5000, state: 'ok'}); // Shopify gross sales of every order: price x quantity of the lines
    const events = eventsCells(MONTHS, NOW, await readPos());
    expect(totalCells([events, website, marketplace])[0]).toMatchObject({value: 97000, state: 'ok'});
    expect(totalCells([events, website, marketplace])[2]).toMatchObject({state: 'partial'}); // marketplace is a gap in October
  });

  it('a failed CRM read is a gap, never an understated number', () => {
    for (const c of websiteCells(MONTHS, NOW, null)) expect(c).toMatchObject({value: null, state: 'gap'});
  });
});
