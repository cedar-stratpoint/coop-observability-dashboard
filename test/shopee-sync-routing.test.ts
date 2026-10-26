import {describe, expect, it} from 'vitest';
import {canAddWorker, canClaim, chooseJob, MAX_PER_PERSON, MAX_PER_TEAM, type WorkerLike} from '../src/shopee-sync/routing';

const w = (o: Partial<WorkerLike> = {}): WorkerLike => ({id: 'w1', ownerEmail: 'a@x.com', sessionState: 'ready', revokedAt: null, ...o});
const j = (o: Partial<{id: string; requestedBy: string; createdAt: string}> = {}) => ({id: 'j1', requestedBy: 'a@x.com', createdAt: '2026-10-27T01:00:00Z', ...o});

describe('canClaim', () => {
  it('only a ready, non-revoked worker owned by the presser', () => {
    expect(canClaim(w(), j())).toBe(true);
    expect(canClaim(w({sessionState: 'signed_out'}), j())).toBe(false);
    expect(canClaim(w({sessionState: 'expired'}), j())).toBe(false);
    expect(canClaim(w({revokedAt: '2026-10-27T00:00:00Z'}), j())).toBe(false);
    expect(canClaim(w({ownerEmail: 'b@x.com'}), j())).toBe(false);
  });
  it('matches emails case-insensitively', () => {
    expect(canClaim(w({ownerEmail: 'A@X.com'}), j({requestedBy: 'a@x.COM'}))).toBe(true);
  });
});

describe('chooseJob', () => {
  it('takes the oldest job this worker may claim', () => {
    const jobs = [j({id: 'late', createdAt: '2026-10-27T03:00:00Z'}), j({id: 'theirs', requestedBy: 'b@x.com', createdAt: '2026-10-27T00:00:00Z'}), j({id: 'early', createdAt: '2026-10-27T02:00:00Z'})];
    expect(chooseJob(w(), jobs)?.id).toBe('early');
  });
  it('returns null when none fits', () => {
    expect(chooseJob(w({sessionState: 'signed_out'}), [j()])).toBeNull();
  });
});

describe('canAddWorker', () => {
  const live = (owner: string, n: number) => Array.from({length: n}, (_, i) => w({id: `${owner}${i}`, ownerEmail: owner}));
  it('caps 2 per person and 3 per team, ignoring revoked workers', () => {
    expect([MAX_PER_PERSON, MAX_PER_TEAM]).toEqual([2, 3]);
    expect(canAddWorker([], 'a@x.com')).toBeNull();
    expect(canAddWorker(live('a@x.com', 1), 'a@x.com')).toBeNull();
    expect(canAddWorker(live('a@x.com', 2), 'a@x.com')).toMatch(/2/);
    expect(canAddWorker([...live('a@x.com', 2), ...live('b@x.com', 1)], 'c@x.com')).toMatch(/3/);
    expect(canAddWorker([...live('a@x.com', 2), w({id: 'gone', ownerEmail: 'a@x.com', revokedAt: '2026-10-01T00:00:00Z'})], 'b@x.com')).toBeNull();
  });
});
