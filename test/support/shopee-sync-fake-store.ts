// In-memory SyncStore for tests. Models the database's guarantees: atomic compare-and-set, the single heartbeat row, and the two unique
// indexes (one queued job, one in-flight job) from supabase/shopee_sync.sql.
import {randomUUID} from 'node:crypto';
import type {JobPatch, SyncStore} from '../../src/shopee-sync/store';
import {isActive, type Heartbeat, type Job, type JobStatus, type WorkerReport} from '../../src/shopee-sync/types';

export class FakeSyncStore implements SyncStore {
  heartbeat: Heartbeat | null = null;
  jobs: Job[] = [];

  async getHeartbeat() {
    return this.heartbeat ? {...this.heartbeat} : null;
  }
  async touchHeartbeat(r: WorkerReport, now: Date) {
    const h = this.heartbeat ?? {lastSeen: null, loginState: null, loginCheckedAt: null, remoteReady: false};
    this.heartbeat = {...h, lastSeen: now.toISOString(), ...(r.login && {loginState: r.login.state, loginCheckedAt: r.login.checkedAt}), ...(r.remoteReady !== undefined && {remoteReady: r.remoteReady})};
    return {...this.heartbeat};
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
    const row: Job = {id: randomUUID(), requestedBy: j.requestedBy, days: j.days, status: 'queued', claimedAt: null, heartbeatAt: null, importIds: [], error: null, createdAt: now.toISOString(), finishedAt: null, progress: {}, awaitingSince: null};
    this.jobs.push(row);
    return {...row};
  }
  async claimJob(jobId: string, now: Date) {
    const j = this.jobs.find((x) => x.id === jobId);
    if (!j || j.status !== 'queued' || this.heartbeat?.loginState !== 'ready') return null;
    if (this.jobs.some((x) => isActive(x.status))) return null;
    Object.assign(j, {status: 'running', claimedAt: now.toISOString(), heartbeatAt: now.toISOString()});
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
