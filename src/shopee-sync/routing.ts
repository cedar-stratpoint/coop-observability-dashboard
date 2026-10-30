// Who is who in the sync: email matching, and what the cloud worker's last known Shopee login says.
import {LOGIN_MAX_AGE_MS} from './rules';
import type {Heartbeat, LoginState} from './types';

export const sameEmail = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

export interface CloudLogin {
  /** Whether the worker has ever sent a heartbeat. */
  hasWorker: boolean;
  /** The last reported login, or 'unknown' when none has been reported yet (or a Ready one is too old to trust). */
  state: LoginState | 'unknown';
  checkedAt: string | null;
  /** A Ready older than LOGIN_MAX_AGE_MS: reported as 'unknown' with its checkedAt kept. */
  stale: boolean;
}
/** The last known Shopee login of the cloud worker. Survives the server sleeping, because it is stored on the heartbeat row. */
export function cloudLogin(hb: Heartbeat | null, now: Date): CloudLogin {
  const checkedAt = hb?.loginState && hb.loginCheckedAt ? hb.loginCheckedAt : null;
  const stale = hb?.loginState === 'ready' && checkedAt !== null && now.getTime() - Date.parse(checkedAt) > LOGIN_MAX_AGE_MS;
  return {hasWorker: hb !== null, state: stale ? 'unknown' : (checkedAt ? hb!.loginState! : 'unknown'), checkedAt, stale};
}
