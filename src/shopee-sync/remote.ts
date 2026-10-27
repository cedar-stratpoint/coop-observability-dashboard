// The admin-only link into the cloud worker's own browser (noVNC behind Cloudflare Access; see knowledge/best-practices/remote-browser-handoff.md).
// The password is typed THERE, in the worker's Chrome. Options go in the URL fragment, which is never sent to a server.
const MAX_URL = 200;

export const remoteBrowserHref = (remoteUrl: string): string => `${remoteUrl.replace(/\/+$/, '')}/vnc.html#autoconnect=1&reconnect=1&resize=remote`;

/** An address an admin may save: plain http(s), no credentials, query or fragment. Empty clears it. Returns it without a trailing slash. */
export function normaliseRemoteUrl(raw: string): {ok: true; url: string | null} | {ok: false; error: string} {
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
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return bad('The address must start with https://.');
  if (u.username || u.password) return bad('The address must not contain a user name or password.');
  if (u.search || u.hash) return bad('Leave off anything after the address (no ? or #).');
  return {ok: true, url: `${u.origin}${u.pathname}`.replace(/\/+$/, '')};
}
