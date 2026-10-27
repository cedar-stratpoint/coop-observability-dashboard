import {createHmac, randomUUID} from 'node:crypto';
import {createClient} from '@supabase/supabase-js';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {supabaseSyncStore} from '../src/shopee-sync/store-supabase';
import {hashSecret, newWorkerToken} from '../src/shopee-sync/tokens';
import {assertLocalSupabase} from './support/local-only';

// LOCAL INTEGRATION (skipped unless pointed at the throwaway local stack from scripts/local-supabase/up.sh, with supabase/shopee_sync.sql applied):
//   set -a; source scripts/local-supabase/.local-env; set +a; npx vitest run test/shopee-sync-local.integration.test.ts
// Proves the claim race against a real database: two workers claiming one job at once, exactly one wins; one in-flight sync team-wide.
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
  const clean = async () => {
    await sb.from('shopee_sync_jobs').delete().like('requested_by', 'race-%');
    await sb.from('shopee_sync_workers').delete().like('owner_email', 'race-%');
    await sb.from('shopee_sync_enrolments').delete().like('owner_email', 'race-%');
  };
  beforeAll(clean);
  afterAll(clean);

  it('two workers claim the same queued job at once: exactly one gets it', async () => {
    const now = new Date();
    const w1 = await store.createWorker({ownerEmail: owner, name: 'one', tokenHash: hashSecret(newWorkerToken())}, now);
    const w2 = await store.createWorker({ownerEmail: owner, name: 'two', tokenHash: hashSecret(newWorkerToken())}, now);
    await store.touchWorker(w1.id, {sessionState: 'ready'}, now);
    await store.touchWorker(w2.id, {sessionState: 'ready'}, now);
    const job = await store.createJob({requestedBy: owner, days: ['2026-10-19', '2026-10-20']}, now);
    if (job === 'conflict') throw new Error('conflict');
    const [a, b] = await Promise.all([store.claimJob(job.id, w1.id, now), store.claimJob(job.id, w2.id, now)]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    const winner = (a ?? b) as NonNullable<typeof a>;
    expect(winner).toMatchObject({status: 'running', days: ['2026-10-19', '2026-10-20']});
    expect(await store.claimJob(job.id, w2.id, now)).toBeNull(); // no longer queued
    // a second queued job cannot be created while one is queued, and a second sync cannot start while one runs
    expect(await store.transitionJob(job.id, ['running'], {status: 'done', finishedAt: now.toISOString()})).not.toBeNull();
  });

  it('refuses a second queued job, a claim by a signed-out, revoked or foreign worker, and a second in-flight sync', async () => {
    const now = new Date();
    const ready = await store.createWorker({ownerEmail: owner, name: 'ready', tokenHash: hashSecret(newWorkerToken())}, now);
    await store.touchWorker(ready.id, {sessionState: 'ready'}, now);
    const signedOut = await store.createWorker({ownerEmail: owner, name: 'so', tokenHash: hashSecret(newWorkerToken())}, now);
    const foreign = await store.createWorker({ownerEmail: `race-other-${randomUUID()}@example.com`, name: 'f', tokenHash: hashSecret(newWorkerToken())}, now);
    await store.touchWorker(foreign.id, {sessionState: 'ready'}, now);
    const j1 = await store.createJob({requestedBy: owner, days: ['2026-10-21']}, now);
    if (j1 === 'conflict') throw new Error('conflict');
    expect(await store.createJob({requestedBy: owner, days: ['2026-10-22']}, now)).toBe('conflict');
    expect(await store.claimJob(j1.id, signedOut.id, now)).toBeNull();
    expect(await store.claimJob(j1.id, foreign.id, now)).toBeNull();
    expect((await store.getJob(j1.id))?.status).toBe('queued');
    expect(await store.claimJob(j1.id, ready.id, now)).not.toBeNull();
    const j2 = await store.createJob({requestedBy: owner, days: ['2026-10-22']}, now);
    if (j2 === 'conflict') throw new Error('conflict');
    expect(await store.claimJob(j2.id, ready.id, now)).toBeNull(); // another sync is in flight
    await store.transitionJob(j1.id, ['running'], {status: 'done'});
    expect(await store.claimJob(j2.id, ready.id, now)).not.toBeNull();
    await store.transitionJob(j2.id, ['running'], {status: 'failed', error: 'x'});
  });

  it('an enrolment code is redeemed exactly once, even twice at once; a capped redemption keeps the code; an expired one is invalid', async () => {
    const now = new Date();
    const who = `race-enrol-${randomUUID()}@example.com`;
    const mk = async (expiresInMs = 60_000) => {
      const codeHash = hashSecret(`zse_${randomUUID()}`);
      await store.createEnrolment({codeHash, ownerEmail: who, workerName: 'm', expiresAt: new Date(now.getTime() + expiresInMs).toISOString(), usedAt: null});
      return codeHash;
    };
    const big = {perPerson: 100, perTeam: 1000};
    const code = await mk();
    const [a, b] = await Promise.all([store.redeemEnrolment(code, hashSecret(newWorkerToken()), now, big), store.redeemEnrolment(code, hashSecret(newWorkerToken()), now, big)]);
    expect([a, b].filter((r) => r.status === 'ok')).toHaveLength(1);
    expect([a, b].filter((r) => r.status === 'invalid')).toHaveLength(1);
    expect(await store.redeemEnrolment(await mk(-1000), hashSecret(newWorkerToken()), now, big)).toEqual({status: 'invalid'});
    // the person already has one live Mac: a cap of 1 refuses and leaves the code unspent, so it works under a bigger cap
    const held = await mk();
    expect(await store.redeemEnrolment(held, hashSecret(newWorkerToken()), now, {perPerson: 1, perTeam: 1000})).toEqual({status: 'capped', ownerEmail: who});
    expect((await store.redeemEnrolment(held, hashSecret(newWorkerToken()), now, big)).status).toBe('ok');
  });

  it('stores the login report and remote address, and the shared claim lets the cloud worker take another person\'s job (only when told to)', async () => {
    const now = new Date();
    const cloud = await store.createWorker({ownerEmail: `race-admin-${randomUUID()}@example.com`, name: 'cloud', tokenHash: hashSecret(newWorkerToken())}, now);
    await store.touchWorker(cloud.id, {sessionState: 'ready', login: {state: 'ready', checkedAt: now.toISOString()}, remoteReady: true}, now);
    expect(await store.setRemoteUrl(cloud.id, 'https://browser.example.com')).toBe(true);
    const back = (await store.listWorkers()).find((w) => w.id === cloud.id);
    expect(back).toMatchObject({loginState: 'ready', remoteReady: true, remoteUrl: 'https://browser.example.com', sessionState: 'ready'});
    expect(Date.parse(back?.loginCheckedAt as string)).toBe(now.getTime());
    await store.touchWorker(cloud.id, {}, now); // a poll that reports nothing keeps what was known
    expect((await store.listWorkers()).find((w) => w.id === cloud.id)).toMatchObject({loginState: 'ready', remoteReady: true});
    const job = await store.createJob({requestedBy: `race-user-${randomUUID()}@example.com`, days: ['2026-10-23']}, now);
    if (job === 'conflict') throw new Error('conflict');
    expect(await store.claimJob(job.id, cloud.id, now)).toBeNull(); // not the presser's worker
    const got = await store.claimJob(job.id, cloud.id, now, {anyOwner: true});
    expect(got).toMatchObject({status: 'running', claimedBy: cloud.id});
    const waiting = await store.transitionJob(job.id, ['running'], {status: 'awaiting_verification', awaitingSince: now.toISOString()});
    expect(Date.parse(waiting?.awaitingSince as string)).toBe(now.getTime());
    await store.transitionJob(job.id, ['awaiting_verification'], {status: 'expired', error: 'x', finishedAt: now.toISOString()});
    expect(await store.setRemoteUrl(cloud.id, null)).toBe(true);
    await store.revokeWorker(cloud.id, now);
    expect(await store.setRemoteUrl(cloud.id, 'https://x.example.com')).toBe(false);
  });
});
