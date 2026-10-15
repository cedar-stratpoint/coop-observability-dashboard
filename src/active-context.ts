import 'server-only';
import {cache} from 'react';
import {cookies} from 'next/headers';
import {redirect} from 'next/navigation';
import {auth} from '@/auth';
import {homeFor, shouldRedirectFromZoomy} from '@/src/company-nav';
import {currentEnv} from '@/src/coop-env-server';
import {devSessionWithMemberships} from '@/src/dev-auth';
import type {CoopEnvKey} from '@/src/coop-env';
import {
  COOP_VIEW_KEY,
  fetchCompanies,
  membershipViews,
  resolveActive,
  pickCookieView,
  type ActiveContext,
  type CompanyRole,
  type Membership,
} from '@/src/company';

/** Cookie the switcher writes to pick the active VIEW — `${viewSid}:${viewKey}`
 *  (see viewCookieValue). A hint only: always re-validated against real memberships. */
export const VIEW_COOKIE = 'active_view';

type ViewSession = {viewSid?: string | null; startView?: string | null};

/** The view to use for this request: the switcher's choice made during THIS sign-in,
 *  else the sign-in's starting view (pinned default → most recent → first). */
async function cookieView(session: ViewSession | null): Promise<string | null> {
  let raw: string | null = null;
  try {
    raw = (await cookies()).get(VIEW_COOKIE)?.value ?? null;
  } catch {
    raw = null;
  }
  return pickCookieView(raw, session?.viewSid, session?.startView);
}

// Server-side seam for tenant scoping. A Server Component or route calls
// getActiveContext() to learn which view is active (which company's data, and
// whether the caller may see data at all). The multi-role selection — and the
// data-blind Coop Admin rule — lives in the pure resolveActive() in src/company.ts.

/**
 * Resolve the active view for the current request, or null if the user is not
 * signed in / has no memberships. `requested` is a view key (a company id, or the
 * `coop_admin` sentinel) — e.g. the upload route's `?company=`; otherwise the
 * `active_view` cookie set by the switcher. resolveActive ignores a view the user
 * doesn't hold and falls back to one they do, so it can never grant access.
 */
// One session read per request (the layout, the page and the nav all ask for it).
// (Local dev only: DEV_AUTH_AS can stand in a session with memberships — see dev-auth.)
const sessionOnce = cache(async () => devSessionWithMemberships() ?? (await auth()));

export async function getActiveContext(requested?: string | null): Promise<ActiveContext | null> {
  const session = await sessionOnce();
  if (!session) return null;
  const memberships = (session as {memberships?: Membership[]}).memberships ?? [];
  const pick = requested ?? (await cookieView(session as ViewSession));
  return resolveActive(memberships, pick);
}

/**
 * Like getActiveContext but for data pages: returns a context that may read a
 * company's data, or null when the caller may not (not signed in, no membership,
 * or the data-blind Coop Admin view). Callers treat null as "redirect / show no data".
 */
export async function getDataContext(requested?: string | null): Promise<ActiveContext | null> {
  const ctx = await getActiveContext(requested);
  if (!ctx || !ctx.canSeeData || !ctx.companyId) return null;
  return ctx;
}

/**
 * Guard for Zoomy-only routes (the legacy pages that read Zoomy data with no company
 * dimension). A non-Zoomy active view (a company view other than Zoomy, or the
 * data-blind Coop Admin) is redirected to that view's home instead of seeing Zoomy
 * data. Signed-out / no-membership (and local dev-auth bypass, where auth() is null)
 * are a no-op, so the normal auth flow and local dev are unaffected.
 */
export async function requireZoomyData(): Promise<void> {
  const ctx = await getActiveContext();
  if (shouldRedirectFromZoomy(ctx)) redirect(homeFor(ctx));
}

/** One selectable view for the shell switcher, with a display name resolved. */
export type NavView = {key: string; companyId: string | null; role: CompanyRole; name: string};

/** Chrome for the app shell: the active view + every view the user can switch into.
 *  Null when not signed in / no membership. */
export type NavContext = {
  activeKey: string;
  companyId: string | null;
  role: CompanyRole;
  isCoopAdmin: boolean;
  views: NavView[];
  /** Holds an active Coop Admin role — in ANY view (drives the environment switcher). */
  holdsCoopAdmin: boolean;
  /** The environment this request is on (Staging / Production). */
  env: CoopEnvKey;
};

export const getNavContext = cache(async (): Promise<NavContext | null> => {
  const session = await sessionOnce();
  if (!session) return null;
  const memberships = (session as {memberships?: Membership[]}).memberships ?? [];
  const active = resolveActive(memberships, await cookieView(session as ViewSession));
  if (!active) return null;

  const views = membershipViews(memberships);
  const companyIds = views.filter((v) => v.companyId).map((v) => v.companyId as string);
  const named = companyIds.length ? await fetchCompanies(companyIds) : [];
  const navViews: NavView[] = views.map((v) => ({
    key: v.key,
    companyId: v.companyId,
    role: v.role,
    name: v.companyId ? (named.find((c) => c.id === v.companyId)?.name ?? v.companyId) : 'Coop Admin',
  }));

  return {
    activeKey: active.companyId ?? COOP_VIEW_KEY,
    companyId: active.companyId,
    role: active.role,
    isCoopAdmin: active.isCoopAdmin,
    views: navViews,
    holdsCoopAdmin: holdsCoopAdmin(memberships),
    env: (await currentEnv()).key,
  };
});

/** An active Coop Admin membership, whatever view is in use (suspended rows are
 *  already dropped from the session's memberships). */
export const holdsCoopAdmin = (memberships: Membership[]) => memberships.some((m) => !m.companyId && m.role === 'coop_admin');

/** Session check for Coop-Admin-holder pages (e.g. Manage environments), any view. */
export async function getCoopAdminHolder(): Promise<{email: string} | null> {
  const session = await sessionOnce();
  if (!session) return null;
  const memberships = (session as {memberships?: Membership[]}).memberships ?? [];
  const email = session.user?.email?.toLowerCase();
  return email && holdsCoopAdmin(memberships) ? {email} : null;
}
