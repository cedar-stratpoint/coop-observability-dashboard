import {describe, expect, it} from 'vitest';
import {ENROL_TTL_MS, enrolmentUsable, hashSecret, newEnrolmentCode, newWorkerToken, verifySecret} from '../src/shopee-sync/tokens';

describe('worker tokens', () => {
  it('are random, long, and stored only as a sha256 hash', () => {
    const a = newWorkerToken();
    const b = newWorkerToken();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(43);
    expect(hashSecret(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashSecret(a)).not.toContain(a);
  });
  it('verify with a timing-safe compare of the hashes', () => {
    const t = newWorkerToken();
    expect(verifySecret(t, hashSecret(t))).toBe(true);
    expect(verifySecret(t + 'x', hashSecret(t))).toBe(false);
    expect(verifySecret('', hashSecret(t))).toBe(false);
    expect(verifySecret(t, 'short')).toBe(false);
  });
});

describe('enrolment codes', () => {
  it('are random and expire after 15 minutes, single use', () => {
    expect(newEnrolmentCode()).not.toBe(newEnrolmentCode());
    expect(ENROL_TTL_MS).toBe(15 * 60_000);
    const now = new Date('2026-10-27T10:00:00Z');
    const row = (o: object = {}) => ({expiresAt: new Date(now.getTime() + 60_000).toISOString(), usedAt: null, ...o});
    expect(enrolmentUsable(row(), now)).toBe(true);
    expect(enrolmentUsable(row({usedAt: now.toISOString()}), now)).toBe(false);
    expect(enrolmentUsable(row({expiresAt: new Date(now.getTime() - 1).toISOString()}), now)).toBe(false);
  });
});
