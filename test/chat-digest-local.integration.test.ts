import {createHmac} from 'node:crypto';
import {describe, expect, it, vi} from 'vitest';

vi.mock('server-only', () => ({}));

import {shapeDigest} from '../src/chat/digest-lookup';
import {chatDigestClient} from '../src/chat/read/client';
import {mintChatReadJwt} from '../src/chat/read/mint-jwt';
import {readDigestIndex, readDigestRowAt, readDigestRows} from '../src/chat/read/digest';
import type {ChatReadMode} from '../src/chat/read/relations';
import {assertLocalSupabase} from './support/local-only';

// LOCAL INTEGRATION (skipped unless pointed at the throwaway local stack from scripts/local-supabase/up.sh):
//   set -a; source scripts/local-supabase/.local-env; set +a; npx vitest run test/chat-digest-local.integration.test.ts
// Proves get_digest's read path against a real PostgREST: both read modes return the seeded digests, the `bundle` marker
// never comes back, and the database itself refuses the raw table to the read-only role.
const URL_ = process.env.SB_LOCAL_URL;
const SECRET = process.env.SB_LOCAL_JWT_SECRET;
if (URL_) assertLocalSupabase(URL_); // a set but non-local URL fails the file loudly instead of skipping: a hosted project is never read
const local = !!URL_ && !!SECRET;
const MARKER = 'SHOULD-NEVER-BE-SELECTED';

function serviceJwt(secret: string): string {
  const b = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const body = `${b({alg: 'HS256', typ: 'JWT'})}.${b({role: 'service_role', iss: 'supabase', iat: now, exp: now + 300})}`;
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
}
const env = () => ({SUPABASE_URL_ARCHIVE: URL_, SUPABASE_SERVICE_ROLE_KEY_ARCHIVE: SECRET ? serviceJwt(SECRET) : undefined, CHAT_RO_JWT_SECRET: SECRET});

describe.skipIf(!local)('get_digest read path on the local stack', () => {
  it.each<ChatReadMode>(['guarded_service', 'ro_role'])('%s: reads the six seeded digests newest first, without the bundle', async (mode) => {
    const {client, stats} = chatDigestClient({mode, env: env()});
    const rows = await readDigestRows(client, mode);
    expect(rows).toHaveLength(6);
    expect(rows[0].digest.headline).toMatch(/Lazada and Shopee both grew/);
    expect(rows.some((r) => /quieter week/.test(r.digest.headline))).toBe(true);
    expect(JSON.stringify(rows)).not.toContain(MARKER);
    expect(Object.keys(rows[0]).sort()).toEqual(['created_at', 'digest', 'window_from', 'window_to']);
    expect(rows[0].digest.customers?.outreach[0].name).toBe('Maria S.'); // masked at the seam

    const out = shapeDigest({window: 'latest', section: 'comparison'}, {source: 'live', rows}, new Date('2026-09-30T04:00:00Z'));
    if ('error' in out) throw new Error(out.error);
    expect(out.result.meta.source).toBe('digest');
    expect(out.result.rows.find((r) => r.channel === 'Lazada')).toMatchObject({revenue: 6300, orders: 14});
    expect(JSON.stringify(out)).not.toMatch(/Maria|Santos|FICTIONAL/);

    const index = await readDigestIndex(client, mode);
    expect(index).toHaveLength(6);
    expect(JSON.stringify(index)).not.toContain(MARKER);
    expect(stats).toMatchObject({attemptedNonRead: 0, allowed: 2});
  });

  // rowAt (Task 1) matches an older digest by eq on the created_at TEXT the index returned. Proves the round trip against real PostgREST
  // (timestamptz text such as "+00:00", with the "+" surviving the query string), for EVERY stored window, in both modes.
  it.each<ChatReadMode>(['guarded_service', 'ro_role'])('%s: readDigestRowAt finds every window by the text the index returned', async (mode) => {
    const {client} = chatDigestClient({mode, env: env()});
    const index = await readDigestIndex(client, mode);
    expect(index).toHaveLength(6);
    for (const w of index) {
      const row = await readDigestRowAt(client as never, mode, w);
      expect(row, `${w.from} ${w.to} ${w.createdAt}`).not.toBeNull();
      expect([row?.window_from, row?.window_to, row?.created_at]).toEqual([w.from, w.to, w.createdAt]);
    }
    const oldest = index[index.length - 1];
    expect(await readDigestRowAt(client as never, mode, {...oldest, createdAt: '2020-01-01T00:00:00+00:00'})).toBeNull();
  });

  it('the guard refuses a select of bundle before it reaches the database, in both modes', async () => {
    for (const mode of ['guarded_service', 'ro_role'] as const) {
      const {client, stats} = chatDigestClient({mode, env: env()});
      type Loose = {from(r: string): {select(c: string): {retry(on: boolean): PromiseLike<{data: unknown; error: {message: string} | null}>}}};
      const r = await (client as unknown as Loose).from(mode === 'ro_role' ? 'coop_chat_digest' : 'digest_archive').select('window_to,bundle').retry(false);
      expect(r.error?.message).toMatch(/forbidden column bundle/);
      expect(r.data).toBeNull();
      expect(stats.attemptedNonRead).toBe(1);
    }
  });

  it('the database refuses the raw table to the read-only role, and the view has no bundle column', async () => {
    const token = mintChatReadJwt({secret: SECRET as string});
    const get = (path: string) => fetch(`${URL_}/rest/v1/${path}`, {headers: {Authorization: `Bearer ${token}`}});
    expect((await get('digest_archive?select=window_to&limit=1')).status).toBe(403);
    const view = await get('coop_chat_digest?select=bundle&limit=1');
    expect(view.status).toBe(400); // column does not exist on the view
    const ok = await get('coop_chat_digest?select=window_to,digest&limit=1');
    expect(ok.status).toBe(200);
    expect(await ok.text()).not.toContain(MARKER);
  });
});
