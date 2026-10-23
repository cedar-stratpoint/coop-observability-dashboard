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

const shape = (raw: string | undefined) =>
  raw === undefined || raw.trim() === '' ? {set: false as const} : {set: true as const, length: raw.length, hasQuotes: /^["'].*["']$/s.test(raw), hasEdgeWhitespace: raw !== raw.trim(), /** the code trims before use, so a paste mistake does not break the chat, but fix the env anyway */ trimmedByCode: raw !== raw.trim()};

/** What this deployment sees of the CRM env, for /api/chat/health: set flags, lengths, paste mistakes and the HOST only. Never a value. */
export function describeCrmEnv(env: CrmEnv) {
  let host: string | null = null;
  try {
    host = new URL((env.CRM_API_URL ?? '').trim()).host;
  } catch {
    host = null;
  }
  const access = resolveCrmAccess(env);
  return {CRM_API_URL: {...shape(env.CRM_API_URL), host}, CRM_API_READ_TOKEN: shape(env.CRM_API_READ_TOKEN), enabled: access.enabled, ...(access.enabled ? {tools: access.tools} : {reason: access.reason})};
}
