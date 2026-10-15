// Coop environments (pure, unit-tested). Just two: Staging and Production — the
// develop branch deploys to Staging too, so there is no separate Development/QA.
// The list lives in code (public URLs, nothing secret), so no deployment needs extra
// settings.
//
// A deployment knows which environment it is from the DATABASE it's connected to
// (the Supabase project ref in its own server config) — not from the address it was
// reached on, since a site can be served from several hosts (deployment URLs, branch
// aliases, custom domains). The safety guard fails closed: an unrecognised database
// is treated as Production, so risky changes still need confirming.

export type CoopEnvKey = 'staging' | 'production';

export type CoopEnv = {
  key: CoopEnvKey;
  dbRef: string; // the Supabase project ref this environment's database has
  label: string;
  url: string; // canonical origin
  host: string;
  tone: string; // colour rail / pill
  dbLabel: string; // which Supabase it reads (masked project ref)
};

export const COOP_ENVS: readonly CoopEnv[] = [
  {
    key: 'staging',
    label: 'Staging',
    url: 'https://coop-brand-os-staging.vercel.app',
    host: 'coop-brand-os-staging.vercel.app',
    dbRef: 'syxwixxzmytvhwhkwdvw',
    tone: 'oklch(0.62 0.15 250)', // blue
    dbLabel: 'Staging Supabase (syxw…wdvw)',
  },
  {
    key: 'production',
    label: 'Production',
    url: 'https://coop-brand-os.vercel.app',
    host: 'coop-brand-os.vercel.app',
    dbRef: 'qkxbwzdxhwcbwgriwipi',
    tone: 'oklch(0.6 0.2 305)', // purple
    dbLabel: 'Coop production Supabase (qkxb…wipi)',
  },
] as const;

export const envByKey = (key: CoopEnvKey): CoopEnv => COOP_ENVS.find((e) => e.key === key) as CoopEnv;

/** The Supabase project ref from a project URL (https://<ref>.supabase.co), or null. */
export function dbRefOf(url: string | null | undefined): string | null {
  try {
    return url ? (new URL(url).hostname.split('.')[0] || null) : null;
  } catch {
    return null;
  }
}

/** The environment a database belongs to, or null if it's neither known database. */
export const envForDbRef = (ref: string | null | undefined): CoopEnv | null => COOP_ENVS.find((e) => e.dbRef === ref) ?? null;

/**
 * Which environment this deployment is — from its database. For the label only, an
 * unknown database falls back to the request host (first value of a forwarded list,
 * port and case ignored); for safety checks use `guardEnvKey`, which fails closed.
 */
export function resolveEnv(dbUrl: string | null | undefined, host: string | null | undefined): CoopEnv {
  const byDb = envForDbRef(dbRefOf(dbUrl));
  if (byDb) return byDb;
  return envForHost(host);
}

/** For safety checks: Staging only when the database is positively the Staging one. */
export const guardEnvKey = (dbUrl: string | null | undefined): CoopEnvKey => (envForDbRef(dbRefOf(dbUrl))?.key === 'staging' ? 'staging' : 'production');

/** Environment from a host alone (fallback label only). */
export function envForHost(host: string | null | undefined): CoopEnv {
  const h = (host ?? '').split(',')[0].trim().toLowerCase().replace(/:\d+$/, '');
  return h === envByKey('production').host ? envByKey('production') : envByKey('staging');
}

/** The same page on another environment: its origin + this path + query + hash. */
export function switchHref(target: CoopEnvKey, path: string, search = '', hash = ''): string {
  const p = path.startsWith('/') ? path : `/${path}`;
  const q = search && !search.startsWith('?') ? `?${search}` : search;
  const h = hash && !hash.startsWith('#') ? `#${hash}` : hash;
  return `${envByKey(target).url}${p}${q}${h}`;
}

/** The word a Coop Admin types to confirm a risky admin action in production. */
export const PROD_CONFIRM_WORD = 'PRODUCTION';

/** Risky admin actions in production must be confirmed by typing PROD_CONFIRM_WORD. */
export const prodConfirmOk = (env: CoopEnvKey, typed: string | null | undefined) => env !== 'production' || (typed ?? '').trim() === PROD_CONFIRM_WORD;
