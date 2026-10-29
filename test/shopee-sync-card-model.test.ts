import {describe, expect, it} from 'vitest';
import {agoText, behindTag, cardVisible, pollInterval, rangeText, statusMeta, stepsFor, syncButton} from '../src/shopee-sync/card-model';
import type {ShopeeSyncStatus, SyncJobView} from '../src/shopee-sync/status';

const now = new Date('2026-10-27T06:00:00Z');
const ago = (s: number) => new Date(now.getTime() - s * 1000).toISOString();
const job = (o: Partial<SyncJobView> = {}): SyncJobView => ({id: 'j', requestedBy: 'a@x.com', mine: true, days: ['2026-10-19', '2026-10-20'], status: 'running', error: null, progress: {}, createdAt: ago(60), finishedAt: null, awaitingSince: null, ...o});
const status = (o: Partial<ShopeeSyncStatus> = {}): ShopeeSyncStatus => ({signedInAs: 'a@x.com', isAdmin: false, mock: false, worker: null, login: {state: 'unknown', checkedAt: null, ageSeconds: null, stale: false}, workerOnline: false, remoteReady: false, remoteUrl: null, currentJob: null, lastJob: null, missingDays: ['2026-10-19', '2026-10-20', '2026-10-21'], moreMissing: 0, canSync: {ok: true, days: 3}, ...o});

describe('agoText', () => {
  it('speaks in seconds, minutes, hours, days', () => {
    expect(agoText(ago(12), now)).toBe('12 seconds ago');
    expect(agoText(ago(1), now)).toBe('1 second ago');
    expect(agoText(ago(180), now)).toBe('3 minutes ago');
    expect(agoText(ago(7300), now)).toBe('2 hours ago');
    expect(agoText(ago(3 * 86400 + 5), now)).toBe('3 days ago');
    expect(agoText(null, now)).toBe('never');
    expect(agoText(ago(-5), now)).toBe('just now');
  });
});

describe('rangeText', () => {
  it('names the first and last day and the count', () => {
    expect(rangeText(['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25'])).toBe('Mon 19 Oct to Sun 25 Oct, 7 days');
    expect(rangeText(['2026-10-25'])).toBe('Sun 25 Oct, 1 day');
    expect(rangeText([])).toBe('');
  });
  it('says so when the days are not one run', () => {
    expect(rangeText(['2026-10-19', '2026-10-22'])).toBe('Mon 19 Oct to Thu 22 Oct, 2 days with gaps');
  });
});

describe('cardVisible and behindTag', () => {
  it('shows when days are missing or a job is current, or one finished in the last day', () => {
    expect(cardVisible(status(), now)).toBe(true);
    expect(cardVisible(status({missingDays: []}), now)).toBe(false);
    expect(cardVisible(status({missingDays: [], currentJob: job()}), now)).toBe(true);
    expect(cardVisible(status({missingDays: [], lastJob: job({status: 'done', finishedAt: ago(3600)})}), now)).toBe(true);
    expect(cardVisible(status({missingDays: [], lastJob: job({status: 'done', finishedAt: ago(3 * 86400)})}), now)).toBe(false);
  });
  it('is hidden with no status, in mock mode', () => {
    expect(cardVisible(null, now)).toBe(false);
    expect(cardVisible(status({mock: true}), now)).toBe(false);
  });
  it('behind means days are missing', () => {
    expect(behindTag(status())).toBe(true);
    expect(behindTag(status({missingDays: []}))).toBe(false);
    expect(behindTag(null)).toBe(false);
    expect(behindTag(status({mock: true}))).toBe(false);
  });
});

describe('syncButton', () => {
  it('is labelled from canSync and enabled', () => {
    expect(syncButton(status())).toEqual({label: 'Sync 3 missing days', disabled: false, reason: null});
    expect(syncButton(status({canSync: {ok: true, days: 1}}))).toMatchObject({label: 'Sync 1 missing day'});
  });
  it('carries the server reason when off', () => {
    expect(syncButton(status({canSync: {ok: false, reason: 'Shopee is up to date'}}))).toEqual({label: 'Sync Shopee', disabled: true, reason: 'Shopee is up to date'});
  });
  it('is disabled while a job is current, with a plain reason when it is someone else\'s', () => {
    expect(syncButton(status({currentJob: job(), canSync: {ok: false, reason: 'A Shopee sync is already queued or running. Wait for it to finish.'}}))).toMatchObject({disabled: true});
    const other = syncButton(status({currentJob: job({mine: false, requestedBy: 'bea@x.com'}), canSync: {ok: false, reason: 'A Shopee sync is already queued or running. Wait for it to finish.'}}));
    expect(other.reason).toBe('Waiting for another sync to finish.');
  });
});

describe('statusMeta', () => {
  it('covers every status with a label and a title, and never asks for a password in the body of the card', () => {
    for (const st of ['queued', 'running', 'awaiting_verification', 'importing', 'done', 'failed', 'review', 'expired'] as const) {
      const m = statusMeta(job({status: st, error: 'x'}));
      expect(m.label).toBeTruthy();
      expect(m.title).toBeTruthy();
      expect(m.body).toBeTruthy();
    }
  });
  it('awaiting_verification tells an admin to type the password in the worker\'s browser, and offers no input', () => {
    const m = statusMeta(job({status: 'awaiting_verification'}), {isAdmin: true});
    expect(m.label).toBe('Needs your sign-in');
    expect(m.body).toMatch(/worker's Chrome, not in Coop/);
    expect(m.body).toMatch(/continues by itself/);
    expect(m.actions).toEqual(['cancel']);
  });
  it('maps the actions: queued and running cancel; failed, expired retry; review confirm and discard-free', () => {
    expect(statusMeta(job({status: 'queued'})).actions).toEqual(['cancel']);
    expect(statusMeta(job({status: 'running'})).actions).toEqual(['cancel']);
    expect(statusMeta(job({status: 'importing'})).actions).toEqual(['cancel']);
    expect(statusMeta(job({status: 'failed', error: 'boom'})).actions).toEqual(['retry']);
    expect(statusMeta(job({status: 'expired', error: 'nobody'})).actions).toEqual(['retry']);
    expect(statusMeta(job({status: 'review'})).actions).toEqual(['confirm']);
    expect(statusMeta(job({status: 'done'})).actions).toEqual([]);
  });
  it('only the requester gets actions', () => {
    expect(statusMeta(job({status: 'running', mine: false, requestedBy: 'b@x.com'}), {isAdmin: false}).actions).toEqual([]);
    expect(statusMeta(job({status: 'running', mine: false, requestedBy: 'b@x.com'}), {isAdmin: true}).actions).toEqual(['cancel']);
  });
  it('failed shows the server reason, done names how far it loaded', () => {
    expect(statusMeta(job({status: 'failed', error: 'The file failed a date check.'})).body).toMatch(/The file failed a date check\./);
    const done = statusMeta(job({status: 'done', days: ['2026-10-19', '2026-10-20'], progress: {'2026-10-19': {state: 'loaded'}, '2026-10-20': {state: 'loaded'}}}));
    expect(done.title).toBe('Loaded through Tue 20 Oct');
    expect(done.body).toMatch(/2 days/);
  });
  it('ends the reason with a full stop before the next sentence', () => {
    expect(statusMeta(job({status: 'failed', error: 'Cancelled by a@x.com'})).body).toMatch(/^Cancelled by a@x\.com\. Days/);
  });
  it('running reports how many days are done', () => {
    const m = statusMeta(job({status: 'running', days: ['2026-10-19', '2026-10-20', '2026-10-21'], progress: {'2026-10-19': {state: 'loaded'}}}));
    expect(m.body).toMatch(/1 of 3 days/);
  });
});

describe('pollInterval', () => {
  it('polls every 3 seconds while a job is current, never when idle or no status', () => {
    expect(pollInterval(status({currentJob: job()}))).toBe(3000);
    expect(pollInterval(status())).toBeNull();
    expect(pollInterval(null)).toBeNull();
    expect(pollInterval(status({mock: true}))).toBeNull();
  });
});

describe('stepsFor', () => {
  const labels = (j: SyncJobView) => stepsFor(j).map((s) => `${s.label}:${s.state}`);
  it('marks progress through the steps, adding the password step only while it is needed', () => {
    expect(labels(job({status: 'queued'}))).toEqual(['Requested:now', 'Exporting from Shopee:todo', 'Importing orders:todo', 'Done:todo']);
    expect(labels(job({status: 'running'}))).toEqual(['Requested:done', 'Exporting from Shopee:now', 'Importing orders:todo', 'Done:todo']);
    expect(labels(job({status: 'awaiting_verification'}))).toEqual(['Requested:done', 'Exporting from Shopee:done', 'Admin signs in:now', 'Importing orders:todo', 'Done:todo']);
    expect(labels(job({status: 'importing'}))).toEqual(['Requested:done', 'Exporting from Shopee:done', 'Importing orders:now', 'Done:todo']);
    expect(labels(job({status: 'done'}))).toEqual(['Requested:done', 'Exporting from Shopee:done', 'Importing orders:done', 'Done:done']);
  });
  it('failed marks the step it stopped at: exporting when nothing came back, importing when something did', () => {
    expect(labels(job({status: 'failed'}))[1]).toBe('Exporting from Shopee:bad');
    expect(labels(job({status: 'failed', progress: {'2026-10-19': {state: 'loaded'}}}))[2]).toBe('Importing orders:bad');
  });
});

