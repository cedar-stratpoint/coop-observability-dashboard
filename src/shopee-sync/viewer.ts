import 'server-only';
import {auth} from '@/auth';
import {fetchMemberships} from '../company';
import {emailAllowed} from './allowed';
import {DEV_SESSION, devAuthEnabled, devSessionWithMemberships} from '../dev-auth';
import type {Actor} from './service';

/**
 * The signed-in person, if they may use the sync (ALLOWED_EMAILS respected). Admin = an active Coop Admin role (no company, role coop_admin) re-read from the database: cancel, confirm, revoke, enrol the
 * cloud worker, sign in to Shopee on it and open the remote browser.
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
  const isAdmin = memberships.some((m) => m.companyId === null && m.role === 'coop_admin');
  return {email, isAdmin};
}
