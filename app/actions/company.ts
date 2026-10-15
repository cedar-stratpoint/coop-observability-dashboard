'use server';

import {cookies} from 'next/headers';
import {revalidatePath} from 'next/cache';
import {after} from 'next/server';
import {auth} from '@/auth';
import {VIEW_COOKIE} from '@/src/active-context';
import {membershipViews, saveViewPrefs, viewCookieValue, type Membership} from '@/src/company';

// Persist the switcher's choice of active VIEW (a company id, or the `coop_admin`
// sentinel). Two parts:
//  • a cookie bound to this sign-in (`${viewSid}:${key}`) — what the rest of this
//    session uses. A HINT only: every data path re-resolves it against the user's
//    real memberships (resolveActive), so it can never grant access.
//  • `last_view` in company_user_prefs — the "most recent view" that next sign-in
//    starts in (unless they pinned one in Settings). Best-effort.
export async function setActiveView(viewKey: string): Promise<void> {
  const clean = /^[a-z0-9_-]{1,64}$/.test(viewKey) ? viewKey : '';
  const session = await auth();
  const sid = (session as {viewSid?: string | null} | null)?.viewSid;
  const memberships = (session as {memberships?: Membership[]} | null)?.memberships ?? [];
  const held = clean && membershipViews(memberships).some((v) => v.key === clean);
  if (held) {
    const store = await cookies();
    // Bound to this sign-in when the session has an id; a session from before
    // starting views shipped keeps the old bare cookie until its next sign-in.
    store.set(VIEW_COOKIE, sid ? viewCookieValue(sid, clean) : clean, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      secure: process.env.NODE_ENV === 'production',
    });
    // Remember it as "where I left off" without making the switch wait on it.
    const email = session?.user?.email;
    if (email) {
      after(async () => {
        if (!(await saveViewPrefs(email, {last_view: clean}))) console.error('setActiveView: last_view not saved', email);
      });
    }
  }
  revalidatePath('/', 'layout');
}

/** Settings → Starting view. `null` = start where I left off (most recent view);
 *  otherwise a view key the user holds. Validated against live memberships. */
export async function setDefaultViewAction(viewKey: string | null): Promise<{ok: true} | {ok: false; error: string}> {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) return {ok: false, error: 'Not signed in.'};
  const memberships = (session as {memberships?: Membership[]}).memberships ?? [];
  if (viewKey !== null && !membershipViews(memberships).some((v) => v.key === viewKey)) {
    return {ok: false, error: 'You don’t have access to that view.'};
  }
  const ok = await saveViewPrefs(email, {default_view: viewKey});
  if (!ok) return {ok: false, error: 'Couldn’t save your starting view. Please try again.'};
  revalidatePath('/settings');
  return {ok: true};
}
