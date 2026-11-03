import {beforeEach, describe, expect, it} from 'vitest';
import {periodIsWindow} from '../src/shopee-import/api';
import type {ReportPeriod} from '../src/shopee-import/pipeline';
import {handleClaim, handleProgress, type SyncApiDeps} from '../src/shopee-sync/api';
import {syncButton} from '../src/shopee-sync/card-model';
import {missingReportWeeks, remainingReports, wireWindows} from '../src/shopee-sync/missing-reports';
import {requestSync, syncGate, type SyncDeps} from '../src/shopee-sync/service';
import {buildSyncStatus} from '../src/shopee-sync/status';
import {issuedWindows, windowsFor} from '../src/shopee-sync/windows';
import {FakeSyncStore} from './support/shopee-sync-fake-store';
import {exactReports} from './support/shopee-sync-reports';

// "now" = Tue 27 Oct 14:00 PH, yesterday = Mon 26 Oct. Week 19-25 Oct is closed and final; 26 Oct opens the next week.
const at = (phIso: string) => new Date(`${phIso}+08:00`);
const NOW = at('2026-10-27T14:00:00');
const range = (from: string, n: number) => Array.from({length: n}, (_, i) => new Date(Date.parse(`${from}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10));
const ALL = range('2026-10-12', 15); // 12 Oct .. 26 Oct, every sales day loaded
const WK1 = range('2026-10-12', 7);
const WK2 = range('2026-10-19', 7);
const ads = (from: string, to: string): ReportPeriod => ({reportType: 'ads', periodFrom: from, periodTo: to});
const sku = (from: string, to: string): ReportPeriod => ({reportType: 'sku_detail', periodFrom: from, periodTo: to});
const WK1_REPORTS = exactReports(WK1);
const WORKER = 'worker-secret-for-tests';

describe('missingReportWeeks', () => {
  it('a closed week with all sales loaded and no Ads or SKU is missing', () => {
    expect(missingReportWeeks(ALL, WK1_REPORTS, NOW)).toEqual(['2026-10-19']);
  });
  it('an exact Ads and SKU window means nothing to request', () => {
    expect(missingReportWeeks(ALL, exactReports(ALL), NOW)).toEqual([]);
  });
  it('an OVERLAPPING non-exact Ads window (even a week-and-a-bit) is never re-requested', () => {
    expect(missingReportWeeks(ALL, [...WK1_REPORTS, ads('2026-10-22', '2026-10-25'), sku('2026-10-19', '2026-10-25')], NOW)).toEqual([]);
    expect(missingReportWeeks(ALL, [...WK1_REPORTS, ads('2026-10-12', '2026-10-25'), sku('2026-10-12', '2026-10-25')], NOW)).toEqual([]);
  });
  it('only the SKU missing still counts: that week is requested', () => {
    expect(missingReportWeeks(ALL, [...WK1_REPORTS, ads('2026-10-19', '2026-10-25')], NOW)).toEqual(['2026-10-19']);
  });
  it('a week with a sales day missing waits (its days load first); the open week and an unfinal Sunday never count', () => {
    expect(missingReportWeeks(ALL.filter((d) => d !== '2026-10-21'), WK1_REPORTS, NOW)).toEqual([]);
    expect(missingReportWeeks(ALL, WK1_REPORTS, at('2026-10-26T03:00:00'))).toEqual([]); // Sun 25 Oct is not final until 06:00 Mon
  });
  it('a week older than the 35-day reach is left for the Monday import', () => {
    const old = range('2026-08-31', 7);
    expect(missingReportWeeks([...old, ...ALL], exactReports(ALL), NOW)).toEqual([]);
  });
});

describe('wireWindows: the worker is only told what is missing', () => {
  const week = windowsFor(WK2, NOW);
  it('a loaded week lists only its missing Ads/SKU (Ads only when SKU is in)', () => {
    expect(wireWindows(week, ALL, WK1_REPORTS)[0].files).toEqual(['ads', 'sku_detail']);
    expect(wireWindows(week, ALL, [...WK1_REPORTS, sku('2026-10-19', '2026-10-25')])[0].files).toEqual(['ads']);
  });
  it('a week whose sales are NOT loaded keeps all five files', () => {
    expect(wireWindows(week, WK1, [])[0].files).toHaveLength(5);
  });
  it('everything loaded in the meantime leaves sales only, never an empty list', () => {
    expect(wireWindows(week, ALL, exactReports(ALL))[0].files).toEqual(['sales_overview']);
  });
  it('day windows are untouched', () => {
    const d = windowsFor(['2026-10-26'], NOW);
    expect(wireWindows(d, ALL, [])).toEqual(d);
  });
});

describe('remainingReports (the Done check)', () => {
  it('names a job week whose Ads/SKU are still missing, and nothing once they are loaded', () => {
    expect(remainingReports(WK2, ALL, WK1_REPORTS, NOW)).toEqual(['2026-10-19..2026-10-25/ads', '2026-10-19..2026-10-25/sku_detail']);
    expect(remainingReports(WK2, ALL, exactReports(ALL), NOW)).toEqual([]);
  });
  it('an overlapping window is not held against the job; a day-window week and an aged-out week are skipped', () => {
    expect(remainingReports(WK2, ALL, [...WK1_REPORTS, ads('2026-10-20', '2026-10-24'), sku('2026-10-20', '2026-10-24')], NOW)).toEqual([]);
    expect(remainingReports(['2026-10-20', '2026-10-21'], ALL, [], NOW)).toEqual([]);
    expect(remainingReports(range('2026-08-31', 7), range('2026-08-31', 7), [], NOW)).toEqual([]);
  });
});

describe('syncGate and requestSync', () => {
  let store: FakeSyncStore;
  let periods: ReportPeriod[];
  let loaded: string[];
  const deps = (): SyncDeps => ({store, now: () => NOW, loadLoadedDays: async () => loaded, loadReportPeriods: async () => periods});
  beforeEach(async () => {
    store = new FakeSyncStore();
    loaded = [...ALL];
    periods = [...WK1_REPORTS];
    await store.touchHeartbeat({login: {state: 'ready', checkedAt: NOW.toISOString()}}, NOW);
  });

  it('all days loaded but no Ads: Sync queues a job whose window is a week with the missing report files, not a refresh', async () => {
    const r = await requestSync(deps(), 'a@x.com');
    if (!r.ok) throw new Error(r.error);
    expect(r.job.days).toEqual(WK2);
    expect(windowsFor(r.job.days, NOW)).toEqual([{kind: 'week', from: '2026-10-19', to: '2026-10-25', files: expect.any(Array)}]);
    expect(wireWindows(issuedWindows(r.job.days, r.job.createdAt, NOW), loaded, periods)).toEqual([{kind: 'week', from: '2026-10-19', to: '2026-10-25', files: ['ads', 'sku_detail']}]);
  });
  it('the server still accepts only the issued week window (periodIsWindow), nothing wider', async () => {
    const r = await requestSync(deps(), 'a@x.com');
    if (!r.ok) throw new Error(r.error);
    const w = issuedWindows(r.job.days, r.job.createdAt, NOW);
    expect(periodIsWindow('2026-10-19', '2026-10-25', w, 'ads')).toBe(true);
    expect(periodIsWindow('2026-10-12', '2026-10-25', w, 'ads')).toBe(false);
    expect(periodIsWindow('2026-10-19', '2026-10-24', w, 'ads')).toBe(false);
  });
  it('an exact Ads+SKU window loaded: it is a refresh of the latest day, nothing else requested', () => {
    periods = exactReports(ALL);
    const g = syncGate({now: NOW, jobs: [], heartbeat: {lastSeen: NOW.toISOString(), loginState: 'ready', loginCheckedAt: NOW.toISOString(), remoteReady: false}, loadedDays: loaded, reportPeriods: periods});
    expect(g).toMatchObject({ok: true, refresh: true, days: ['2026-10-26'], reportWeeks: []});
  });
  it('an overlapping non-exact Ads/SKU window loaded: not requested', () => {
    periods = [...WK1_REPORTS, ads('2026-10-22', '2026-10-25'), sku('2026-10-22', '2026-10-25')];
    const g = syncGate({now: NOW, jobs: [], heartbeat: {lastSeen: NOW.toISOString(), loginState: 'ready', loginCheckedAt: NOW.toISOString(), remoteReady: false}, loadedDays: loaded, reportPeriods: periods});
    expect(g).toMatchObject({ok: true, refresh: true, reportWeeks: []});
  });
  const HB = () => ({lastSeen: NOW.toISOString(), loginState: 'ready' as const, loginCheckedAt: NOW.toISOString(), remoteReady: false});
  it('missing sales days come first: a report week is added only if every planned day still fits the caps', () => {
    // Three missing full weeks (5-25 Oct) leave room: the older loaded week 28 Sep (no reports) is added as a fourth week window.
    const room = syncGate({now: NOW, jobs: [], heartbeat: HB(), loadedDays: [...range('2026-09-28', 7), '2026-10-26'], reportPeriods: []});
    if (!room.ok) throw new Error(room.error);
    expect(room.days).toEqual(range('2026-09-28', 28));
    expect(room.reportWeeks).toEqual(['2026-09-28']);
    // Four missing full weeks (28 Sep-25 Oct) fill MAX_WEEK_WINDOWS: the loaded week 21 Sep waits and must not push a missing week out.
    const full = syncGate({now: NOW, jobs: [], heartbeat: HB(), loadedDays: [...range('2026-09-21', 7), '2026-10-26'], reportPeriods: []});
    if (!full.ok) throw new Error(full.error);
    expect(full.days).toEqual(range('2026-09-28', 28));
    expect(full.reportWeeks).toEqual([]);
    expect(full.more).toBe(7);
  });
  it('the job never exceeds 31 days: report weeks that do not fit wait and are counted as more', () => {
    const g = syncGate({now: NOW, jobs: [], heartbeat: HB(), loadedDays: range('2026-09-21', 36), reportPeriods: []}); // five full weeks loaded, none with reports
    if (!g.ok) throw new Error(g.error);
    expect(g.reportWeeks).toEqual(['2026-09-28', '2026-10-05', '2026-10-12', '2026-10-19']); // newest first, 4 week windows
    expect(g.days).toHaveLength(28);
    expect(g.more).toBe(7); // the oldest week waits
  });
  it('the card says what it will load, and the status carries the week count', () => {
    const s = buildSyncStatus({viewer: {email: 'a@x.com', isAdmin: false}, now: NOW, heartbeat: {lastSeen: NOW.toISOString(), loginState: 'ready', loginCheckedAt: NOW.toISOString(), remoteReady: false}, remoteUrl: null, jobs: [], loadedDays: ALL, reportPeriods: periods});
    expect(s.canSync).toEqual({ok: true, days: 7, reportWeeks: 1});
    expect(syncButton(s).label).toBe('Sync ads for 1 week');
  });
});

describe('claim and done through the worker routes', () => {
  let store: FakeSyncStore;
  let periods: ReportPeriod[];
  const api = (o: Partial<SyncApiDeps> = {}): SyncApiDeps => ({store, now: () => NOW, workerToken: WORKER, loadLoadedDays: async () => ALL, loadReportPeriods: async () => periods, ...o});
  const post = (path: string, body: unknown) => new Request(`https://coop.example/api/shopee/sync/${path}`, {method: 'POST', body: JSON.stringify(body), headers: {'content-type': 'application/json', authorization: `Bearer ${WORKER}`}});
  beforeEach(async () => {
    store = new FakeSyncStore();
    periods = [...WK1_REPORTS];
    await store.touchHeartbeat({login: {state: 'ready', checkedAt: NOW.toISOString()}}, NOW);
    const sd: SyncDeps = {store, now: () => NOW, loadLoadedDays: async () => ALL, loadReportPeriods: async () => periods};
    expect((await requestSync(sd, 'a@x.com')).ok).toBe(true);
  });
  const claim = async () => (await (await handleClaim(post('claim', {login: {state: 'ready', checkedAt: NOW.toISOString()}}), api())).json()).job;

  it('a claim hands the worker the Ads/SKU-only week window', async () => {
    expect((await claim()).windows).toEqual([{kind: 'week', from: '2026-10-19', to: '2026-10-25', files: ['ads', 'sku_detail']}]);
  });
  it('the worker may report on and upload the issued Ads file of the week', async () => {
    const job = await claim();
    const res = await handleProgress(post('progress', {jobId: job.id, status: 'running', files: {'2026-10-19..2026-10-25/ads': {state: 'loaded'}}}), api());
    expect(res.status).toBe(200);
  });
  it('done is refused while the Ads file is still missing, and accepted once it is loaded', async () => {
    const job = await claim();
    const failed = await handleProgress(post('progress', {jobId: job.id, status: 'done'}), api());
    expect((await failed.json()).job.status).toBe('failed');
    expect((await store.getJob(job.id))?.error).toBe('Still missing reports: 2026-10-19..2026-10-25/ads, 2026-10-19..2026-10-25/sku_detail.');
  });
  it('done is accepted once Ads and SKU are loaded', async () => {
    const job = await claim();
    periods = exactReports(ALL);
    expect((await (await handleProgress(post('progress', {jobId: job.id, status: 'done'}), api())).json()).job.status).toBe('done');
  });
});
