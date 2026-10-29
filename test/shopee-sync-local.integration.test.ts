import {createHmac, randomUUID} from 'node:crypto';
import {createClient} from '@supabase/supabase-js';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {supabaseSyncStore} from '../src/shopee-sync/store-supabase';
import {assertLocalSupabase} from './support/local-only';

// LOCAL INTEGRATION (skipped unless pointed at the throwaway local stack from scripts/local-supabase/up.sh, with supabase/shopee_sync.sql applied):
//   set -a; source scripts/local-supabase/.local-env; set +a; npx vitest run test/shopee-sync-local.integration.test.ts
// Proves the claim race against a real database: two polls claiming one job at once, exactly one wins; one in-flight sync team-wide; the single heartbeat row.
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

describe.skipIf(!local)('shopee sync store on the local stack', () => {
  const sb = createClient(URL_ ?? 'http://127.0.0.1:1', local ? serviceJwt(SECRET as string) : 'x', {auth: {persistSession: false}});
  const store = supabaseSyncStore(sb);
  const owner = `race-${randomUUID()}@example.com`;
  const ready = {login: {state: 'ready' as const, checkedAt: new Date().toISOString()}};
  const clean = async () => {
    await sb.from('shopee_sync_jobs').delete().like('requested_by', 'race-%');
    await sb.from('shopee_sync_worker').delete().eq('id', 1);
  };
  beforeAll(clean);
  afterAll(clean);

  it('the heartbeat is one row: polls upsert it, and a poll that leaves a field out keeps it', async () => {
    const now = new Date();
    expect(await store.getHeartbeat()).toBeNull();
    await store.touchHeartbeat({...ready, remoteReady: true}, now);
    const second = await store.touchHeartbeat({}, new Date(now.getTime() + 1000));
    expect(second).toMatchObject({loginState: 'ready', remoteReady: true, lastSeen: new Date(now.getTime() + 1000).toISOString()});
    const {data} = await sb.from('shopee_sync_worker').select('id');
    expect(data).toEqual([{id: 1}]);
  });

  it('two claims for the same queued job at once: exactly one gets it', async () => {
    const now = new Date();
    await store.touchHeartbeat(ready, now);
    const job = await store.createJob({requestedBy: owner, days: ['2026-10-19', '2026-10-20']}, now);
    if (job === 'conflict') throw new Error('conflict');
    const [a, b] = await Promise.all([store.claimJob(job.id, now), store.claimJob(job.id, now)]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    const winner = (a ?? b) as NonNullable<typeof a>;
    expect(winner).toMatchObject({status: 'running', days: ['2026-10-19', '2026-10-20']});
    expect(await store.claimJob(job.id, now)).toBeNull(); // no longer queued
    expect(await store.transitionJob(job.id, ['running'], {status: 'done', finishedAt: now.toISOString()})).not.toBeNull();
  });

  it('refuses a second queued job, a claim while the login is not Ready, and a second in-flight sync', async () => {
    const now = new Date();
    await store.touchHeartbeat({login: {state: 'needs_password', checkedAt: now.toISOString()}}, now);
    const j1 = await store.createJob({requestedBy: owner, days: ['2026-10-21']}, now);
    if (j1 === 'conflict') throw new Error('conflict');
    expect(await store.createJob({requestedBy: owner, days: ['2026-10-22']}, now)).toBe('conflict');
    expect(await store.claimJob(j1.id, now)).toBeNull();
    expect((await store.getJob(j1.id))?.status).toBe('queued');
    await store.touchHeartbeat(ready, now);
    expect(await store.claimJob(j1.id, now)).not.toBeNull();
    const j2 = await store.createJob({requestedBy: owner, days: ['2026-10-22']}, now);
    if (j2 === 'conflict') throw new Error('conflict');
    expect(await store.claimJob(j2.id, now)).toBeNull(); // another sync is in flight
    await store.transitionJob(j1.id, ['running'], {status: 'done'});
    expect(await store.claimJob(j2.id, now)).not.toBeNull();
    await store.transitionJob(j2.id, ['running'], {status: 'failed', error: 'x'});
  });
});
