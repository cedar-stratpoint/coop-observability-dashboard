import {createHmac} from 'node:crypto';
import {describe, expect, it} from 'vitest';
import {createClient} from '@supabase/supabase-js';
import {readPosOrders, type ReadClient} from '../src/pos-orders-read';
import {readChatOrders} from '../src/chat/read/pos-orders';
import {buildChatReadConfig} from '../src/chat/read/config';
import {createGuardedFetch} from '../src/chat/read/guarded-fetch';
import {relationsForMode, type ChatReadMode} from '../src/chat/read/relations';
import {loadMetricData} from '../src/chat/read/metric-data';
import {METRICS, METRIC_IDS} from '../src/chat/metrics-registry';
import {runMetric} from '../src/chat/query-metric';
import {assertLocalSupabase} from './support/local-only';

// LOCAL INTEGRATION (skipped unless pointed at a throwaway local Supabase that already ran
// scripts/coop-chat-ro-proof.mjs, so the fixture and coop_chat_* views exist):
//   SB_LOCAL_URL=http://127.0.0.1:54321 SB_LOCAL_JWT_SECRET=<local secret> npx vitest run test/chat-ro-local.integration.test.ts
// Acceptance (design, slice 1R-DB #5): answers through the real read path in ro_role mode equal
// answers in guarded_service mode on the same data, and customer fields never come back.
const URL_ = process.env.SB_LOCAL_URL;
const SECRET = process.env.SB_LOCAL_JWT_SECRET;
if (URL_) assertLocalSupabase(URL_); // a set but non-local URL fails the file loudly instead of skipping: a hosted project is never read
const local = !!URL_ && !!SECRET;

function serviceJwt(secret: string): string {
  const b = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const body = `${b({alg: 'HS256', typ: 'JWT'})}.${b({role: 'service_role', iss: 'supabase', iat: now, exp: now + 300})}`;
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
}

function guardedClient(mode: ChatReadMode) {
  const env = {
    SUPABASE_URL_ARCHIVE: URL_,
    SUPABASE_SERVICE_ROLE_KEY_ARCHIVE: SECRET ? serviceJwt(SECRET) : undefined,
    CHAT_RO_JWT_SECRET: SECRET,
  };
  const cfg = buildChatReadConfig({mode, env});
  const g = createGuardedFetch({baseUrl: cfg.url, relations: relationsForMode(mode).allowed, underlying: fetch});
  const client = createClient(cfg.url, cfg.key, {
    auth: {persistSession: false, autoRefreshToken: false},
    global: {fetch: g.fetch},
  });
  return {client: client as unknown as ReadClient, stats: g.stats};
}

describe.skipIf(!local)('ro_role equals guarded_service on the local stack', () => {
  it('returns identical orders in both modes, through the real guard', async () => {
    const svc = guardedClient('guarded_service');
    const ro = guardedClient('ro_role');
    const viaService = await readChatOrders(svc.client, 'guarded_service');
    const viaRole = await readChatOrders(ro.client, 'ro_role');
    expect(viaService.length).toBeGreaterThan(0);
    expect(viaRole).toEqual(viaService);
    expect(svc.stats.attemptedNonRead).toBe(0);
    expect(ro.stats.attemptedNonRead).toBe(0);
    expect(ro.stats.allowed).toBeGreaterThan(0);
  });

  it('no customer-level value ever comes back, and it matches the full read apart from those fields', async () => {
    const ro = guardedClient('ro_role');
    const viaRole = await readChatOrders(ro.client, 'ro_role');
    expect(viaRole.every((o) => o.customer_handle === null && o.remarks === null)).toBe(true);

    const full = createClient(URL_ as string, serviceJwt(SECRET as string), {auth: {persistSession: false}});
    const everything = await readPosOrders(full as unknown as ReadClient);
    const strip = (o: (typeof everything)[number]) => ({...o, customer_handle: null, remarks: null, client_uuid: '', device_id: null});
    expect(viaRole).toEqual(everything.map(strip));
    expect(everything.some((o) => o.customer_handle !== null || o.remarks !== null)).toBe(true); // the fixture does hold customer data
  });

  it('every registry metric gives identical results in ro_role and guarded_service mode', async () => {
    const svc = guardedClient('guarded_service');
    const ro = guardedClient('ro_role');
    const dataSvc = await loadMetricData(svc.client, 'guarded_service');
    const dataRo = await loadMetricData(ro.client, 'ro_role');
    // the stock read is stamped with the clock at load time: align the stamps, the rows must still be identical
    expect(dataRo.stock).not.toBeNull();
    if (dataRo.stock && dataSvc.stock) dataRo.stock = {...dataRo.stock, asOf: dataSvc.stock.asOf};
    // identical data; only the relation NAMES inside bulkReads differ (tables vs views), so compare their row counts
    expect({...dataRo, bulkReads: dataRo.bulkReads.map((r) => r.rows)}).toEqual({...dataSvc, bulkReads: dataSvc.bulkReads.map((r) => r.rows)});
    expect(dataRo.orders.length).toBeGreaterThan(0);
    expect(dataRo.prices.length).toBeGreaterThan(0);
    const now = new Date();
    for (const id of METRIC_IDS) {
      const def = METRICS[id];
      const req = {metric: id, dimension: def.defaultDimension, measure: 'default', range: 'all_available', from: '', to: '', channel: 'offline', event: 'all', pet: 'all', compare_to: 'none', sort: 'default', limit: 25};
      const a = runMetric(req, dataSvc, now);
      const b = runMetric(req, dataRo, now);
      expect(b, id).toEqual(a);
      expect('error' in a, `${id}: ${'error' in a ? a.error : ''}`).toBe(false);
    }
    expect(svc.stats.attemptedNonRead).toBe(0);
    expect(ro.stats.attemptedNonRead).toBe(0);
  });

  it('the minted role cannot reach the base table even if the guard were bypassed', async () => {
    const cfg = buildChatReadConfig({mode: 'ro_role', env: {SUPABASE_URL_ARCHIVE: URL_, CHAT_RO_JWT_SECRET: SECRET}});
    const raw = createClient(cfg.url, cfg.key, {auth: {persistSession: false}}); // no guard
    const res = await raw.from('pos_orders').select('id').limit(1);
    expect(res.error).not.toBeNull();
    const write = await raw.from('coop_chat_orders').insert({id: 'x'} as never);
    expect(write.error).not.toBeNull();
  });
});
