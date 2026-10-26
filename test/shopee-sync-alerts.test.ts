import {describe, expect, it, vi} from 'vitest';
import {alertsDue, alertMessage, AWAITING_ALERT_MS, dispatchAlerts, type AlertMessage} from '../src/shopee-sync/alerts';
import type {Job} from '../src/shopee-sync/types';

const now = new Date('2026-10-27T06:00:00Z');
const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
const job = (o: Partial<Job> = {}): Job => ({id: 'job-1', requestedBy: 'a@x.com', days: ['2026-10-19', '2026-10-20'], status: 'failed', claimedBy: 'w', claimedAt: ago(9e5), heartbeatAt: ago(6e5), importIds: [], error: 'worker lost', createdAt: ago(1e6), finishedAt: ago(1e5), progress: {}, ...o});

describe('alertsDue', () => {
  it('alerts on a failed job and on one stuck awaiting verification past the timeout', () => {
    const jobs = [job(), job({id: 'job-2', status: 'awaiting_verification', error: null, finishedAt: null, claimedAt: ago(AWAITING_ALERT_MS + 1000), heartbeatAt: ago(1000)})];
    expect(alertsDue(jobs, now, new Set()).map((a) => [a.job.id, a.kind])).toEqual([['job-1', 'failed'], ['job-2', 'awaiting_verification']]);
  });
  it('is quiet for jobs that are fine, still inside the timeout, or ended by a person', () => {
    const jobs = [
      job({id: 'ok', status: 'done', error: null}),
      job({id: 'running', status: 'running', error: null, finishedAt: null}),
      job({id: 'fresh', status: 'awaiting_verification', error: null, finishedAt: null, claimedAt: ago(60_000)}),
      job({id: 'cancel', error: 'Cancelled by a@x.com'}),
      job({id: 'removed', error: 'The Mac was removed during the sync'}),
      job({id: 'exp', status: 'expired', error: 'worker offline'}),
    ];
    expect(alertsDue(jobs, now, new Set())).toEqual([]);
  });
  it('sends each alert once: a key already sent is skipped', () => {
    const [a] = alertsDue([job()], now, new Set());
    expect(a.key).toBe('job-1:failed');
    expect(alertsDue([job()], now, new Set(['job-1:failed']))).toEqual([]);
  });
});

describe('alertMessage', () => {
  const [a] = alertsDue([job({progress: {'2026-10-19': {state: 'loaded', importId: 'imp-1', note: 'buyer Maria Santos'}}})], now, new Set());
  const m = alertMessage(a);
  it('carries the job id, the days and the reason', () => {
    expect(m.subject).toMatch(/failed/i);
    expect(m.text).toContain('job-1');
    expect(m.text).toMatch(/Mon 19 Oct to Tue 20 Oct/);
    expect(m.text).toContain('worker lost');
  });
  it('carries nothing else: no per-day notes, no requester email, no links or attachments', () => {
    expect(m.text).not.toContain('Maria');
    expect(m.text).not.toContain('a@x.com');
    expect(m.text).not.toMatch(/https?:|screenshot|attach/i);
    expect(Object.keys(m).sort()).toEqual(['subject', 'text']);
  });
  it('scrubs emails, phone-like numbers and anything that looks like a password or code out of the reason', () => {
    const bad = alertMessage(alertsDue([job({error: 'login failed for bea@x.com phone 09171234567 password: hunter2 otp 123456'})], now, new Set())[0]);
    expect(bad.text).not.toMatch(/bea@x\.com|09171234567|hunter2|123456/);
    expect(bad.text).toContain('job-1');
  });
  it('clips a very long reason', () => {
    const long = alertMessage(alertsDue([job({error: 'x'.repeat(2000)})], now, new Set())[0]);
    expect(long.text.length).toBeLessThan(900);
  });
  it('words the awaiting-verification alert as a person to act, without asking for the password', () => {
    const w = alertMessage(alertsDue([job({status: 'awaiting_verification', error: null, finishedAt: null, claimedAt: ago(AWAITING_ALERT_MS + 1)})], now, new Set())[0]);
    expect(w.subject).toMatch(/verification/i);
    expect(w.text).toMatch(/Shopee/);
  });
});

describe('dispatchAlerts', () => {
  it('sends through the injected sender and returns the keys that went, so the caller can remember them', async () => {
    const send = vi.fn(async (_m: AlertMessage) => {});
    const sent = await dispatchAlerts({jobs: [job()], now, alreadySent: new Set(), send});
    expect(send).toHaveBeenCalledTimes(1);
    expect(sent).toEqual(['job-1:failed']);
  });
  it('a sender that throws does not stop the others and its key is not reported as sent', async () => {
    const send = vi.fn(async (m: AlertMessage) => {
      if (m.text.includes('job-1')) throw new Error('smtp down');
    });
    const sent = await dispatchAlerts({jobs: [job(), job({id: 'job-2'})], now, alreadySent: new Set(), send});
    expect(sent).toEqual(['job-2:failed']);
  });
});
