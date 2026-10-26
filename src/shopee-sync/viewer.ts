import 'server-only';
import {auth} from '@/auth';
import {fetchMemberships} from '../company';
import {emailAllowed} from './allowed';
import type {Actor} from './service';

/** The signed-in person, if they may use the sync (ALLOWED_EMAILS respected). Admin = an active Coop Admin role, re-read from the database. */
export async function syncViewer(): Promise<Actor | null> {
  let email: string | undefined;
  try {
    email = (await auth())?.user?.email?.toLowerCase();
  } catch {
    return null;
  }
  if (!email || !emailAllowed(email, process.env.ALLOWED_EMAILS)) return null;
  const isAdmin = (await fetchMemberships(email)).some((m) => m.companyId === null && m.role === 'coop_admin');
  return {email, isAdmin};
}
