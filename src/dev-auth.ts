import type {Session} from 'next-auth';

// Dev-only auth bypass. Lets `next dev` load the dashboard without Google
// sign-in, for local work against Staging. Double-gated so it can NEVER
// activate on a deployment: it needs BOTH NODE_ENV === 'development' (Vercel
// preview and prod both build as 'production') AND an explicit opt-in flag.
// Keep this module import-light (no server-only, no auth import) so it is safe
// to reference from Edge middleware.
export function devAuthEnabled(): boolean {
  return process.env.NODE_ENV === 'development' && process.env.DEV_AUTH_BYPASS === 'true';
}

// The stand-in session used while the bypass is on.
export const DEV_SESSION: Session = {
  user: {name: 'Local Dev', email: 'dev@localhost', image: null},
  expires: '2999-12-31T23:59:59.000Z',
};

/**
 * DEV ONLY: give the bypass session memberships so tenant pages render locally,
 * e.g. DEV_AUTH_AS="goldline:company_admin" or "goldline:company_admin,coop_admin".
 * Same double gate as devAuthEnabled() — inert on any deployment. Null when unset
 * (the bypass then behaves exactly as before: no memberships).
 */
export function devSessionWithMemberships(): (Session & {memberships: Array<{companyId: string | null; role: string; status: 'active'}>}) | null {
  if (!devAuthEnabled()) return null;
  const spec = process.env.DEV_AUTH_AS?.trim();
  if (!spec) return null;
  const memberships = spec
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => (s === 'coop_admin' ? {companyId: null, role: 'coop_admin'} : {companyId: s.split(':')[0], role: s.split(':')[1] || 'company_admin'}))
    .map((m) => ({...m, status: 'active' as const}));
  return {...DEV_SESSION, memberships};
}
