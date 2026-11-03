// The admin-only link into the cloud worker's own browser (noVNC behind Cloudflare Access; see knowledge/best-practices/remote-browser-handoff.md).
// The password is typed THERE, in the worker's Chrome. Options go in the URL fragment, which is never sent to a server.
const MAX_URL = 200;

export const remoteBrowserHref = (remoteUrl: string): string => `${remoteUrl.replace(/\/+$/, '')}/vnc.html#autoconnect=1&reconnect=1&resize=remote`;

/** SHOPEE_SYNC_REMOTE_HOSTS: comma-separated hosts the remote address may use. Unset or empty means no restriction beyond https. */
export const parseHosts = (env: string | undefined): string[] => (env ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);

/**
 * The remote browser address from the environment: https only, no credentials, query or fragment. Empty means none. Returns it without a trailing slash.
 * When `allowedHosts` is not empty the host must be exactly one of them, so a look-alike page cannot be put where an admin types the Shopee password.
 */
export function normaliseRemoteUrl(raw: string, allowedHosts: readonly string[] = []): {ok: true; url: string | null} | {ok: false; error: string} {
  const t = (raw ?? '').trim();
  if (!t) return {ok: true, url: null};
  const bad = (error: string) => ({ok: false as const, error});
  if (t.length > MAX_URL) return bad(`Use an address of at most ${MAX_URL} characters.`);
  let u: URL;
  try {
    u = new URL(t);
  } catch {
    return bad('Enter a full address, for example https://browser.example.com.');
  }
  if (u.protocol !== 'https:') return bad('The address must start with https://.');
  if (allowedHosts.length > 0 && !allowedHosts.includes(u.hostname.toLowerCase())) return bad('That host is not in the allowed list (SHOPEE_SYNC_REMOTE_HOSTS).');
  if (u.username || u.password) return bad('The address must not contain a user name or password.');
  if (u.search || u.hash) return bad('Leave off anything after the address (no ? or #).');
  return {ok: true, url: `${u.origin}${u.pathname}`.replace(/\/+$/, '')};
}

/** SHOPEE_SYNC_REMOTE_URL checked against SHOPEE_SYNC_REMOTE_HOSTS: the address to offer an admin, or null (unset or invalid: the card then shows no link). */
export function remoteUrlFromEnv(rawUrl: string | undefined, rawHosts: string | undefined): string | null {
  const r = normaliseRemoteUrl(rawUrl ?? '', parseHosts(rawHosts));
  return r.ok ? r.url : null;
}
