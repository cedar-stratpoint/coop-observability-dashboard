// Who may run a job and how many Macs may exist. A sync runs only on a READY, non-revoked worker owned by the person who pressed Sync,
// so the person who pressed it is the person who types the Shopee password, on their own Mac.
import type {SessionState} from './types';

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

export const canClaim = (w: WorkerLike, job: {requestedBy: string}): boolean => !w.revokedAt && w.sessionState === 'ready' && sameEmail(w.ownerEmail, job.requestedBy);

/** The oldest queued job this worker may claim. */
export function chooseJob<J extends {requestedBy: string; createdAt: string}>(w: WorkerLike, queued: readonly J[]): J | null {
  return [...queued].filter((j) => canClaim(w, j)).sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0] ?? null;
}

/** Why `owner` may not add another Mac; null when they may. */
export function canAddWorker(workers: readonly WorkerLike[], owner: string): string | null {
  const l = live(workers);
  if (l.filter((w) => sameEmail(w.ownerEmail, owner)).length >= MAX_PER_PERSON) return `You already have ${MAX_PER_PERSON} Macs. Remove one first.`;
  if (l.length >= MAX_PER_TEAM) return `The team already has ${MAX_PER_TEAM} Macs. Remove one first.`;
  return null;
}
