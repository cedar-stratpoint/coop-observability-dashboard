// Who may run a job and how many Macs may exist. A sync runs only on a READY, non-revoked worker owned by the person who pressed Sync,
// so the person who pressed it is the person who types the Shopee password, on their own Mac.
import type {LoginState, SessionState} from './types';

export const MAX_PER_PERSON = 2;
export const MAX_PER_TEAM = 3;

export interface WorkerLike {
  id: string;
  ownerEmail: string;
  sessionState: SessionState;
  revokedAt: string | null;
}
export const sameEmail = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();
const live = <W extends Pick<WorkerLike, 'revokedAt'>>(ws: readonly W[]): W[] => ws.filter((w) => !w.revokedAt);

/** The one cloud worker is the one flagged at enrolment (by a SHOPEE_SYNC_ADMINS member); it serves whoever pressed Sync. A Mac, even an admin's, serves only its owner. */
export const isCloudWorker = (w: {isCloud: boolean}): boolean => w.isCloud;

/** `anyOwner`: the worker is the shared cloud worker, so the presser need not be its owner. */
export const canClaim = (w: WorkerLike, job: {requestedBy: string}, anyOwner = false): boolean => !w.revokedAt && w.sessionState === 'ready' && (anyOwner || sameEmail(w.ownerEmail, job.requestedBy));

/** The oldest queued job this worker may claim. */
export function chooseJob<J extends {requestedBy: string; createdAt: string}>(w: WorkerLike, queued: readonly J[], anyOwner = false): J | null {
  return [...queued].filter((j) => canClaim(w, j, anyOwner)).sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0] ?? null;
}

/** Why `owner` may not add another Mac; null when they may. */
export function canAddWorker(workers: readonly WorkerLike[], owner: string): string | null {
  const l = live(workers);
  if (l.filter((w) => sameEmail(w.ownerEmail, owner)).length >= MAX_PER_PERSON) return `You already have ${MAX_PER_PERSON} Macs. Remove one first.`;
  if (l.length >= MAX_PER_TEAM) return `The team already has ${MAX_PER_TEAM} Macs. Remove one first.`;
  return null;
}

export interface CloudLogin {
  /** Whether any cloud worker is enrolled at all. */
  hasCloud: boolean;
  /** The newest login check across live cloud workers, or 'unknown' when none has reported one yet. */
  state: LoginState | 'unknown';
  checkedAt: string | null;
}
/** The last known Shopee login of the cloud worker(s): the newest check wins. Survives the server sleeping, because it is stored on the worker row. */
export function cloudLogin(workers: readonly (WorkerLike & {isCloud: boolean; loginState: LoginState | null; loginCheckedAt: string | null})[]): CloudLogin {
  const cloud = live(workers).filter(isCloudWorker);
  const checked = cloud.filter((w) => w.loginState && w.loginCheckedAt).sort((a, b) => (b.loginCheckedAt as string).localeCompare(a.loginCheckedAt as string))[0];
  return {hasCloud: cloud.length > 0, state: checked?.loginState ?? 'unknown', checkedAt: checked?.loginCheckedAt ?? null};
}
