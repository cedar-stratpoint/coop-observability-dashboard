// Fail-closed website CRM access for Ask Coop (Train 4; knowledge/best-practices/chat-readonly-api-tools.md). Pure: the caller passes
// process.env; no logging; never throws. This is the ONLY file under src/chat or app/api/chat that names the CRM env variables.
export type CrmEnv = Record<string, string | undefined>;
export type CrmAccess =
  | {enabled: true; baseUrl: string; token: string; tools: boolean}
  | {enabled: false; reason: 'not_configured' | 'url_invalid'};

const LOOPBACK = new Set(['localhost', '127.0.0.1']);

/**
 * enabled = the GET-only client may be built (get_channel_report's Website row uses it). `tools` = the four CRM tools are also sent;
 * CHAT_CRM_TOOLS=off hides them without touching the pages or the channel report.
 */
export function resolveCrmAccess(env: CrmEnv): CrmAccess {
  const rawUrl = (env.CRM_API_URL ?? '').trim();
  const token = (env.CRM_API_READ_TOKEN ?? '').trim();
  if (!rawUrl || !token) return {enabled: false, reason: 'not_configured'};
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return {enabled: false, reason: 'url_invalid'};
  }
  const schemeOk = u.protocol === 'https:' || (u.protocol === 'http:' && LOOPBACK.has(u.hostname));
  if (!schemeOk || u.username || u.password || u.search || u.hash || rawUrl.includes('#')) return {enabled: false, reason: 'url_invalid'};
  return {enabled: true, baseUrl: `${u.origin}${u.pathname.replace(/\/+$/, '')}`, token, tools: (env.CHAT_CRM_TOOLS ?? '').trim().toLowerCase() !== 'off'};
}
