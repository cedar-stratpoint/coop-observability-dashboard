// The server-side rules around starting and keeping a sync: one in flight team-wide, cooldown, daily cap, Monday quiet window, stale jobs.
// Pure: give it the clock and the jobs.
import {isActive, type Job, type JobStatus} from './types';
import {phDay} from './missing-days';

export const COOLDOWN_MS = 10 * 60_000;
export const DAILY_CAP = 6;
export const HEARTBEAT_STALE_MS = 10 * 60_000;
export const QUEUE_EXPIRY_MS = 30 * 60_000;
export const ONLINE_WITHIN_MS = 2 * 60_000;
/** A sync paused for an admin to sign in to Shopee ends after this long (it expires; the Monday import still fills the gap). */
export const AWAITING_EXPIRY_MS = 60 * 60_000;
// The coworker's weekly Shopee export runs on Mondays about 09:00 PHT with the same Seller Centre login; two sessions risk a forced sign-out.
export const QUIET_START_MIN = 8 * 60 + 30;
export const QUIET_END_MIN = 11 * 60;

export type JobLike = Pick<Job, 'id' | 'status' | 'createdAt' | 'heartbeatAt'> & {awaitingSince?: string | null};

export function inQuietWindow(now: Date): boolean {
  const ph = new Date(now.getTime() + 8 * 3_600_000);
  if (ph.getUTCDay() !== 1) return false;
  const min = ph.getUTCHours() * 60 + ph.getUTCMinutes();
  return min >= QUIET_START_MIN && min < QUIET_END_MIN;
}

/** Why a new sync may not be created right now, in words for the person; null when it may. */
export function startBlock(now: Date, jobs: readonly JobLike[]): string | null {
  if (inQuietWindow(now)) return 'Monday morning is reserved for the weekly Shopee export (08:30 to 11:00 Manila time). Try again after 11:00.';
  if (jobs.some((j) => j.status === 'queued' || isActive(j.status))) return 'A Shopee sync is already queued or running. Wait for it to finish.';
  const last = Math.max(0, ...jobs.map((j) => Date.parse(j.createdAt)));
  if (now.getTime() - last < COOLDOWN_MS) return `Please wait ${Math.ceil((COOLDOWN_MS - (now.getTime() - last)) / 60_000)} more minute(s) after the last sync.`;
  const today = phDay(now);
  if (jobs.filter((j) => phDay(new Date(j.createdAt)) === today).length >= DAILY_CAP) return `The daily limit of ${DAILY_CAP} syncs is used up. It resets at midnight Manila time.`;
  return null;
}

export interface Sweep {
  id: string;
  from: JobStatus;
  to: 'failed' | 'expired';
  error: string;
}
/** Jobs that went quiet: in flight with no heartbeat for 10 minutes (worker lost), paused for a sign-in for over an hour, or queued and unclaimed for 30 minutes (worker offline). */
export function staleSweep(now: Date, jobs: readonly JobLike[]): Sweep[] {
  const out: Sweep[] = [];
  for (const j of jobs) {
    if (isActive(j.status) && now.getTime() - Date.parse(j.heartbeatAt ?? j.createdAt) > HEARTBEAT_STALE_MS) out.push({id: j.id, from: j.status, to: 'failed', error: 'worker lost'});
    else if (j.status === 'awaiting_verification' && now.getTime() - Date.parse(j.awaitingSince ?? j.heartbeatAt ?? j.createdAt) > AWAITING_EXPIRY_MS) out.push({id: j.id, from: j.status, to: 'expired', error: `Nobody signed in to Shopee within ${AWAITING_EXPIRY_MS / 60_000} minutes`});
    else if (j.status === 'queued' && now.getTime() - Date.parse(j.createdAt) > QUEUE_EXPIRY_MS) out.push({id: j.id, from: 'queued', to: 'expired', error: 'worker offline'});
  }
  return out;
}

export const isOnline = (lastSeen: string | null, now: Date): boolean => lastSeen !== null && now.getTime() - Date.parse(lastSeen) <= ONLINE_WITHIN_MS;
