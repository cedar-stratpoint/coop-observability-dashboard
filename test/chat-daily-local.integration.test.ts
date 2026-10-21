import {createHmac} from 'node:crypto';
import {createClient} from '@supabase/supabase-js';
import {describe, expect, it, vi} from 'vitest';

vi.mock('server-only', () => ({}));

import {chatDailyClient} from '../src/chat/read/client';
import {readDailyDigests, readDailyRows} from '../src/chat/read/daily';
import {rollupChannels} from '../src/period-rollup';
import type {ChatReadMode} from '../src/chat/read/relations';
import {assertLocalSupabase} from './support/local-only';

// LOCAL INTEGRATION (skipped unless pointed at the throwaway local stack from scripts/local-supabase/up.sh), with the backend's
// supabase/marketplace_daily_sales.sql and supabase/coop_chat_marketplace_daily.sql applied to it:
//   set -a; source scripts/local-supabase/.local-env; set +a; npx vitest run test/chat-daily-local.integration.test.ts
// Writes three fictional rows, reads them through the guarded daily client in BOTH read modes, and removes them.
const URL_ = process.env.SB_LOCAL_URL;
const SECRET = process.env.SB_LOCAL_JWT_SECRET;
if (URL_) assertLocalSupabase(URL_);
const local = !!URL_ && !!SECRET;

function serviceJwt(secret: string): string {
  const b = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const body = `${b({alg: 'HS256', typ: 'JWT'})}.${b({role: 'service_role', iss: 'supabase', iat: now, exp: now + 300})}`;
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
}
const env = () => ({SUPABASE_URL_ARCHIVE: URL_, SUPABASE_SERVICE_ROLE_KEY_ARCHIVE: SECRET ? serviceJwt(SECRET) : undefined, CHAT_RO_JWT_SECRET: SECRET});

describe.skipIf(!local)('the daily sales read on the local stack', () => {
  it.each<ChatReadMode>(['guarded_service', 'ro_role'])('%s: reads the saved days and a custom span sums exactly', async (mode) => {
    const sb = createClient(`${URL_}`, serviceJwt(SECRET as string), {auth: {persistSession: false}});
    const mine = [6, 7, 8].map((d) => ({day: `2026-07-0${d}`, channel: 'shopee', revenue: 100 * d, orders: d, units: 2 * d, window_from: '2026-07-05T16:00:00Z', window_to: '2026-07-08T16:00:00Z'}));
    try {
      expect((await sb.from('marketplace_daily_sales').upsert(mine, {onConflict: 'day,channel'})).error).toBeNull();
      const {client, stats} = chatDailyClient({mode, env: env()});
      const rows = (await readDailyRows(client, mode)).filter((r) => r.day >= '2026-07-06' && r.day <= '2026-07-08');
      expect(rows).toHaveLength(3);
      expect(Object.keys(rows[0]).sort()).toEqual(['captured_at', 'channel', 'day', 'orders', 'revenue', 'units', 'window_from', 'window_to']);
      const digests = await readDailyDigests(client, mode);
      const [b] = rollupChannels({fromDay: '2026-07-06', toDay: '2026-07-08', channels: ['shopee'], granularity: 'total', digests, website: null, offline: null});
      expect(b.channels[0]).toMatchObject({status: 'ok', revenue: 2100, orders: 21, units: 42});
      expect(stats.attemptedNonRead).toBe(0);
    } finally {
      await sb.from('marketplace_daily_sales').delete().gte('day', '2026-07-06').lte('day', '2026-07-08');
    }
  });
});
