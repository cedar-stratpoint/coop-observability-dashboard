import {createHmac} from 'node:crypto';
import {createClient} from '@supabase/supabase-js';
import {describe, expect, it, vi} from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('react', async (orig) => ({...(await orig<typeof import('react')>()), cache: <T>(fn: T) => fn}));
vi.mock('next/cache', () => ({unstable_cache: <T>(fn: T) => fn}));

import {dailyRowsToDigests} from '../src/daily-sales-digests';
import {readDailyRows} from '../src/marketplace-daily-data';
import {rollupChannels} from '../src/period-rollup';
import {assertLocalSupabase} from './support/local-only';

// LOCAL INTEGRATION (skipped unless pointed at the throwaway local stack from scripts/local-supabase/up.sh), with the backend's
// supabase/marketplace_daily_sales.sql applied to it:
//   set -a; source scripts/local-supabase/.local-env; set +a; npx vitest run test/marketplace-daily-local.integration.test.ts
// Writes three fictional July rows, reads them back through the real reader, rolls a custom span up from them, and removes them.
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

describe.skipIf(!local)('marketplace_daily_sales reader on the local stack', () => {
  it('reads saved rows and a custom span sums exactly from them', async () => {
    const sb = createClient(`${URL_}`, serviceJwt(SECRET as string), {auth: {persistSession: false}});
    const mine = [6, 7, 8].map((d) => ({day: `2026-07-0${d}`, channel: 'shopee', revenue: 100 * d, orders: d, units: 2 * d, window_from: '2026-07-05T16:00:00Z', window_to: '2026-07-08T16:00:00Z'}));
    try {
      const up = await sb.from('marketplace_daily_sales').upsert(mine, {onConflict: 'day,channel'});
      expect(up.error).toBeNull();
      const rows = (await readDailyRows(sb)).filter((r) => r.day >= '2026-07-06' && r.day <= '2026-07-08');
      expect(rows).toHaveLength(3);
      expect(rows[0]).toMatchObject({day: '2026-07-06', channel: 'shopee', revenue: 600, orders: 6, units: 12});
      const [b] = rollupChannels({fromDay: '2026-07-06', toDay: '2026-07-08', channels: ['shopee'], granularity: 'total', digests: dailyRowsToDigests(rows), website: null, offline: null});
      expect(b.channels[0]).toMatchObject({status: 'ok', revenue: 2100, orders: 21, units: 42});
    } finally {
      await sb.from('marketplace_daily_sales').delete().gte('day', '2026-07-06').lte('day', '2026-07-08');
    }
  });
});
