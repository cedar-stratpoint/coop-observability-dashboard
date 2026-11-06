import 'server-only';
import {auth} from '@/auth';
import {canEditPlan, fetchMemberships} from '@/src/company';
import {devSessionWithMemberships} from '@/src/dev-auth';

/**
 * Who may type into the Business Health Report. The session supplies only the EMAIL; the roles are re-read from the database every time
 * (fetchMemberships drops suspended rows), so a just-revoked admin or a store manager holding a stale token cannot write. Used by the
 * server action (the real gate) and by the page (to decide whether to render inputs). Null = read-only or signed out.
 */
export async function planEditor(): Promise<{email: string} | null> {
  const session = devSessionWithMemberships() ?? (await auth());
  const email = session?.user?.email?.toLowerCase();
  if (!email) return null;
  return canEditPlan(await fetchMemberships(email)) ? {email} : null;
}
