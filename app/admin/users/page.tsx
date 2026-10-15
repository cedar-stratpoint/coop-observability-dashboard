import {redirect} from 'next/navigation';
import {auth} from '@/auth';
import {getActiveContext} from '@/src/active-context';
import {canManageRoles} from '@/src/company';
import {homeFor} from '@/src/company-nav';
import {listCompanies, listUsers} from '@/src/admin-data';
import {guardEnv} from '@/src/coop-env-server';
import {AdminUsersView} from '@/components/analyst/admin-users-view';

export const dynamic = 'force-dynamic';

// Coop Admin role console. Gated to the Coop Admin view (data-blind): a non-admin
// view is bounced to its home; signed-out falls to the root (sign-in flow).
export default async function Page() {
  const ctx = await getActiveContext();
  if (!ctx) redirect('/');
  if (!canManageRoles(ctx.role)) redirect(homeFor(ctx));
  const [users, companies, session] = await Promise.all([listUsers(), listCompanies(), auth()]);
  // The confirm UI follows the same fail-closed rule as the server guard.
  const env = {key: guardEnv()};
  // `me` only drives UI hints ("You", disabled self-removal); the server actions
  // enforce the real self/last-admin guards.
  return <AdminUsersView users={users} companies={companies} me={session?.user?.email?.toLowerCase() ?? null} env={env.key} />;
}
