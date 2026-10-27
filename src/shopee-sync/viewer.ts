import 'server-only';
import {auth} from '@/auth';
import {fetchMemberships} from '../company';
import {isSyncAdmin} from './admins';
import {emailAllowed} from './allowed';
import {DEV_SESSION, devAuthEnabled, devSessionWithMemberships} from '../dev-auth';
import type {Actor} from './service';

/**
 * The signed-in person, if they may use the sync (ALLOWED_EMAILS respected). Admin = listed in SHOPEE_SYNC_ADMINS (may sign in to Shopee on the
 * cloud worker, open the remote browser, get the alerts), or an active Coop Admin role re-read from the database (the existing cancel, confirm
 * and revoke powers).
 */
export async function syncViewer(): Promise<Actor | null> {
  let email: string | undefined;
  // Local dev with DEV_AUTH_BYPASS has no real session; use the stand-in one (inert on any deployment, see src/dev-auth.ts).
  const dev = devSessionWithMemberships();
  try {
    email = (dev ?? (devAuthEnabled() ? DEV_SESSION : await auth()))?.user?.email?.toLowerCase();
  } catch {
    return null;
  }
  if (!email || !emailAllowed(email, process.env.ALLOWED_EMAILS)) return null;
  const memberships = dev ? dev.memberships : await fetchMemberships(email);
  const isAdmin = isSyncAdmin(email, process.env.SHOPEE_SYNC_ADMINS) || memberships.some((m) => m.companyId === null && m.role === 'coop_admin');
  return {email, isAdmin};
}
