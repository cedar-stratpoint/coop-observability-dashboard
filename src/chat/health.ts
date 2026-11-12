// Ask Coop deployment health: what THIS deployment sees in its environment, as booleans, lengths and kinds only. Never a value.
// It exists because the live path fails closed to digest-only without saying why, and a hosted deployment's env is invisible.
import {csv, parseUrl} from './explore/config';
import {EXPLORE_ROLE, type ExploreEnv} from './explore/types';
import {resolveChatReadMode, type ChatReadEnv} from './read/mode';

type Env = Record<string, string | undefined>;

/** What a pasted env value looks like, without echoing it. */
function shape(name: string, raw: string | undefined) {
  if (raw === undefined || raw === '') return {set: false as const};
  const v = raw;
  return {
    set: true as const,
    length: v.length,
    // The classic paste mistakes: the NAME= prefix came along, quotes, or a stray space/newline at either end.
    hasNamePrefix: v.startsWith(`${name}=`),
    hasQuotes: /^["'].*["']$/s.test(v),
    hasEdgeWhitespace: v !== v.trim(),
  };
}

export function describeChatEnv(env: Env) {
  const key = env.CHAT_RO_APIKEY;
  let mode: string;
  try {
    mode = resolveChatReadMode(env as ChatReadEnv);
  } catch (e) {
    mode = `error: ${(e as Error).message}`;
  }
  let host: string | null = null;
  try {
    host = new URL(env.SUPABASE_URL_ARCHIVE ?? '').host;
  } catch {
    host = null;
  }
  return {
    nodeEnv: env.NODE_ENV ?? null,
    vercelEnv: env.VERCEL_ENV ?? null, // production | preview | development: which scope's variables this deployment got
    mode,
    projectHost: host, // the project ref, not a secret: compare it with the project you mean
    CHAT_READ_MODE: env.CHAT_READ_MODE ?? null,
    CHAT_RO_JWT_SECRET: shape('CHAT_RO_JWT_SECRET', env.CHAT_RO_JWT_SECRET),
    CHAT_RO_APIKEY: {...shape('CHAT_RO_APIKEY', key), kind: !key ? null : key.startsWith('sb_publishable_') ? 'publishable' : key.startsWith('sb_secret_') ? 'SECRET (wrong key)' : key.startsWith('eyJ') ? 'jwt (anon or service_role)' : 'other'},
    SUPABASE_URL_ARCHIVE: shape('SUPABASE_URL_ARCHIVE', env.SUPABASE_URL_ARCHIVE),
    SUPABASE_SERVICE_ROLE_KEY_ARCHIVE: {set: Boolean(env.SUPABASE_SERVICE_ROLE_KEY_ARCHIVE)},
    ANTHROPIC_API_KEY: {set: Boolean(env.ANTHROPIC_API_KEY)},
    ANTHROPIC_WORKSPACE_ID: {set: Boolean(env.ANTHROPIC_WORKSPACE_ID?.trim())}, // org-scoped key only; the value is not shown
  };
}

/** Explore flags, no values: presence, a role check, the hostname only (no user, password, port or query), and list counts. */
export function describeExploreEnv(env: ExploreEnv) {
  const raw = env.EXPLORE_DATABASE_URL?.trim() ?? '';
  let url: {set: false} | {set: true; length: number; roleOk: boolean; host: string | null; kind: 'pooler' | 'direct' | 'loopback' | 'other'} = {set: false};
  if (raw !== '') {
    const p = parseUrl(raw);
    const host = p.ok ? p.hostname.replace(/^\[|\]$/g, '') : null;
    const kind = !host ? 'other' : ['127.0.0.1', 'localhost', '::1'].includes(host) ? 'loopback' : host.endsWith('.pooler.supabase.com') ? 'pooler' : /^db\.[a-z0-9]+\.supabase\.co$/.test(host) ? 'direct' : 'other';
    url = {set: true, length: raw.length, roleOk: p.ok && (p.username === EXPLORE_ROLE || p.username.startsWith(`${EXPLORE_ROLE}.`)), host, kind};
  }
  const list = (v: string | undefined) => ({set: csv(v).length > 0, count: csv(v).length});
  return {
    EXPLORE_MODE: {set: Boolean(env.EXPLORE_MODE), on: env.EXPLORE_MODE === 'on'},
    EXPLORE_DATABASE_URL: url,
    EXPLORE_ALLOWED_EMAILS: list(env.EXPLORE_ALLOWED_EMAILS),
    ALLOWED_EMAILS: list(env.ALLOWED_EMAILS),
  };
}
