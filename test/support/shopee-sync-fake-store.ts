// In-memory SyncStore for tests. Models the database's guarantees: atomic compare-and-set, single-use enrolment, and the two unique
// indexes (one queued job, one in-flight job) from supabase/shopee_sync.sql.
import {randomUUID} from 'node:crypto';
import type {JobPatch, SyncStore} from '../../src/shopee-sync/store';
import {isActive, type Enrolment, type Job, type JobStatus, type Worker, type WorkerReport} from '../../src/shopee-sync/types';

export class FakeSyncStore implements SyncStore {
  workers: Worker[] = [];
  enrolments: Enrolment[] = [];
  jobs: Job[] = [];

  async listWorkers() {
    return this.workers.map((w) => ({...w}));
  }
  async findWorkerByTokenHash(h: string) {
    const w = this.workers.find((x) => x.tokenHash === h);
    return w ? {...w} : null;
  }
  async createWorker(w: {ownerEmail: string; name: string; tokenHash: string; isCloud?: boolean}, now: Date) {
    const row: Worker = {id: randomUUID(), ownerEmail: w.ownerEmail, name: w.name, tokenHash: w.tokenHash, lastSeen: null, sessionState: 'signed_out', createdAt: now.toISOString(), revokedAt: null, loginState: null, loginCheckedAt: null, remoteReady: false, remoteUrl: null, isCloud: w.isCloud ?? false};
    this.workers.push(row);
    return {...row};
  }
  async touchWorker(id: string, r: WorkerReport, now: Date) {
    const w = this.workers.find((x) => x.id === id);
    if (!w) return;
    Object.assign(w, {lastSeen: now.toISOString(), ...(r.sessionState && {sessionState: r.sessionState}), ...(r.login && {loginState: r.login.state, loginCheckedAt: r.login.checkedAt}), ...(r.remoteReady !== undefined && {remoteReady: r.remoteReady})});
  }
  async setRemoteUrl(id: string, url: string | null) {
    const w = this.workers.find((x) => x.id === id && !x.revokedAt);
    if (w) w.remoteUrl = url;
    return Boolean(w);
  }
  async revokeWorker(id: string, now: Date) {
    const w = this.workers.find((x) => x.id === id && !x.revokedAt);
    if (w) w.revokedAt = now.toISOString();
    return Boolean(w);
  }
  async createEnrolment(e: Enrolment) {
    this.enrolments.push({...e});
  }
  async redeemEnrolment(codeHash: string, tokenHash: string, now: Date, caps: {perPerson: number; perTeam: number}) {
    const e = this.enrolments.find((x) => x.codeHash === codeHash && x.usedAt === null && Date.parse(x.expiresAt) > now.getTime());
    if (!e) return {status: 'invalid' as const};
    const live = this.workers.filter((w) => !w.revokedAt);
    if (live.length >= caps.perTeam || live.filter((w) => w.ownerEmail.toLowerCase() === e.ownerEmail.toLowerCase()).length >= caps.perPerson) return {status: 'capped' as const, ownerEmail: e.ownerEmail};
    e.usedAt = now.toISOString();
    return {status: 'ok' as const, worker: await this.createWorker({ownerEmail: e.ownerEmail, name: e.workerName, tokenHash, isCloud: e.isCloud}, now)};
  }
  async recentJobs(limit: number) {
    return [...this.jobs].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit).map((j) => ({...j}));
  }
  async getJob(id: string) {
    const j = this.jobs.find((x) => x.id === id);
    return j ? {...j} : null;
  }
  async createJob(j: {requestedBy: string; days: string[]}, now: Date) {
    if (this.jobs.some((x) => x.status === 'queued')) return 'conflict' as const;
    const row: Job = {id: randomUUID(), requestedBy: j.requestedBy, days: j.days, status: 'queued', claimedBy: null, claimedAt: null, heartbeatAt: null, importIds: [], error: null, createdAt: now.toISOString(), finishedAt: null, progress: {}, awaitingSince: null};
    this.jobs.push(row);
    return {...row};
  }
  async claimJob(jobId: string, workerId: string, now: Date, opts?: {anyOwner?: boolean}) {
    const j = this.jobs.find((x) => x.id === jobId);
    const w = this.workers.find((x) => x.id === workerId);
    if (!j || j.status !== 'queued' || !w || w.revokedAt || w.sessionState !== 'ready' || (!opts?.anyOwner && w.ownerEmail.toLowerCase() !== j.requestedBy.toLowerCase())) return null;
    if (this.jobs.some((x) => isActive(x.status))) return null;
    Object.assign(j, {status: 'running', claimedBy: workerId, claimedAt: now.toISOString(), heartbeatAt: now.toISOString()});
    return {...j};
  }
  async transitionJob(id: string, from: readonly JobStatus[], p: JobPatch) {
    const j = this.jobs.find((x) => x.id === id);
    if (!j || !from.includes(j.status)) return null;
    if (p.status && isActive(p.status) && !isActive(j.status) && this.jobs.some((x) => x.id !== id && isActive(x.status))) return null;
    Object.assign(j, {
      ...(p.status !== undefined && {status: p.status}), ...(p.error !== undefined && {error: p.error}), ...(p.importIds !== undefined && {importIds: p.importIds}),
      ...(p.progress !== undefined && {progress: p.progress}), ...(p.heartbeatAt !== undefined && {heartbeatAt: p.heartbeatAt}), ...(p.finishedAt !== undefined && {finishedAt: p.finishedAt}), ...(p.awaitingSince !== undefined && {awaitingSince: p.awaitingSince}),
    });
    return {...j};
  }
}
