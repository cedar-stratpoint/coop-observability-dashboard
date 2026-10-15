import NextAuth from 'next-auth';
import Google from 'next-auth/providers/google';
import {fetchMemberships, fetchViewPrefsResult, startViewKey, type Membership} from '@/src/company';

// Access is membership-driven (v2): a user may sign in only if a Coop Admin has
// granted them a role in company_users. No email allowlist — the first Coop Admin is
// seeded directly in the DB. See src/admin-data.ts for the grant path.

// Flip any `invited` memberships for this email to `active` on first sign-in, so a
// pre-granted email shows as active once the person actually arrives. Fail-soft.
async function activateInvites(email?: string | null) {
  const addr = email?.toLowerCase();
  const url = process.env.SUPABASE_URL_ARCHIVE;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY_ARCHIVE;
  if (!addr || !url || !key) return;
  try {
    await fetch(
      `${url}/rest/v1/company_users?user_email=eq.${encodeURIComponent(addr)}&status=eq.invited`,
      {
        method: 'PATCH',
        headers: {apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json', prefer: 'return=minimal'},
        body: JSON.stringify({status: 'active'}),
      },
    );
  } catch {
    // never block sign-in on a bookkeeping failure
  }
}

// Record a Coop sign-in into pos_dashboard_users so the low-stock email can reach
// everyone who actually uses the dashboard. Fires in the Node OAuth-callback route
// (never the edge middleware). Fail-soft: a logging hiccup must never block login.
// Uses a direct PostgREST upsert with the archive service-role key — no server-only
// import (which would pull Node code into the edge middleware bundle).
async function recordSignIn(email?: string | null) {
  const addr = email?.toLowerCase();
  const url = process.env.SUPABASE_URL_ARCHIVE;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY_ARCHIVE;
  if (!addr || !url || !key) return;
  try {
    await fetch(`${url}/rest/v1/pos_dashboard_users?on_conflict=email`, {
      method: 'POST',
      headers: {
        apikey: key,
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
        prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify({email: addr, last_seen: new Date().toISOString()}),
    });
  } catch {
    // never block sign-in on a logging failure
  }
}

export const {handlers, auth, signIn, signOut} = NextAuth({
  providers: [Google],
  // Trust the deployment host (Vercel staging/prod custom domains) so the OAuth
  // callback resolves the right origin instead of bouncing to the Configuration
  // error page. Auth errors land on /signin, not the raw Auth.js error screen.
  trustHost: true,
  pages: {signIn: '/signin', error: '/signin'},
  // Shorter-lived JWT sessions bound how long a stale membership snapshot can live;
  // updateAge rolls the token (and triggers the jwt refresh) ~every 5 min of activity.
  session: {strategy: 'jwt', maxAge: 8 * 60 * 60, updateAge: 5 * 60},
  callbacks: {
    // Gate who may sign in: membership-driven only. A user needs a non-suspended
    // role in company_users (granted by a Coop Admin). No email allowlist.
    async signIn({profile}) {
      const email = profile?.email?.toLowerCase();
      if (!email) return false;
      // Membership-driven: only a user a Coop Admin has granted a role may sign in.
      const memberships = await fetchMemberships(email);
      return memberships.length > 0;
    },
    // On sign-in, attach the user's tenant memberships to the JWT so pages can
    // resolve the active company without a per-request DB hit. `user` is only
    // present at sign-in; normal requests skip the fetch (edge-safe).
    async jwt({token, user, profile}) {
      const t = token as {
        memberships?: Membership[];
        mAt?: number;
        email?: string | null;
        viewSid?: string;
        startView?: string | null;
        svRetryAt?: number; // set while the starting view still needs its preferences
      };
      const email = (profile?.email ?? user?.email ?? t.email ?? '').toLowerCase();
      // Refresh memberships at sign-in AND periodically (every ~5 min) so a revoked
      // or role-changed membership stops taking effect quickly, rather than living in
      // the JWT until it expires. Suspended rows are dropped by fetchMemberships.
      const stale = typeof t.mAt !== 'number' || Date.now() - t.mAt > 5 * 60 * 1000;
      if (email && (user || stale)) {
        t.memberships = await fetchMemberships(email);
        t.mAt = Date.now();
      }
      // Each sign-in gets a fresh view session id + its starting view (pinned default
      // → most recent → first). The switcher's cookie is bound to viewSid, so a cookie
      // left from an earlier sign-in is ignored and the user lands in this view.
      if (email && user) t.viewSid = crypto.randomUUID();
      // Resolve the starting view at sign-in; if the preferences couldn't be read
      // (a blip), don't freeze a wrong landing for the whole session — leave it
      // unset (first view) and retry at most once a minute until it resolves.
      const retryDue = typeof t.svRetryAt === 'number' && Date.now() >= t.svRetryAt;
      if (email && (user || retryDue)) {
        const prefs = await fetchViewPrefsResult(email);
        if (prefs.ok) {
          t.startView = startViewKey(t.memberships ?? [], prefs.prefs);
          delete t.svRetryAt;
        } else {
          console.error('auth: view prefs unavailable at sign-in; will retry', email);
          if (user) t.startView = null;
          t.svRetryAt = Date.now() + 60_000;
        }
      }
      return token;
    },
    // Surface memberships on the session for Server Components (read via
    // src/company.ts → resolveActive to get the active company + role).
    session({session, token}) {
      const t = token as {memberships?: Membership[]; viewSid?: string; startView?: string | null};
      const s = session as {memberships?: Membership[]; viewSid?: string | null; startView?: string | null};
      s.memberships = t.memberships ?? [];
      s.viewSid = t.viewSid ?? null;
      s.startView = t.startView ?? null;
      return session;
    },
    // Used by the middleware export to protect pages.
    authorized({auth}) {
      return Boolean(auth?.user);
    },
  },
  events: {
    // A successful sign-in — capture the email for the alert recipient list, and
    // flip any pre-granted `invited` memberships to `active`.
    async signIn({user}) {
      await recordSignIn(user?.email);
      await activateInvites(user?.email);
    },
  },
});
