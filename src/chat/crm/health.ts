// What a deployment sees of the website CRM, for /api/chat/health, and the SAFE reason a CRM read failed, for the Website row of a channel
// report. Booleans, lengths, the host and an error CLASS only: never the URL path, the token or upstream text (the client already throws codes only).
import {createCrmClient, CrmError, type CrmErrorCode} from './client';
import {describeCrmEnv, resolveCrmAccess, type CrmEnv} from './config';

const REASON: Record<CrmErrorCode, string> = {
  refused: 'the request was refused by a guard (check CRM_API_URL)',
  call_cap: 'too many CRM reads in one turn',
  timeout: 'the CRM did not answer in time',
  unreachable: 'the CRM could not be reached (check CRM_API_URL)',
  upstream_error: 'the CRM answered with an error (check CRM_API_READ_TOKEN and that the URL is the right worker)',
  too_large: 'the CRM response was over the size cap',
  bad_shape: 'the CRM answered with something that is not JSON',
};

/** The safe, human reason a CRM read failed. Anything that is not a CrmError is "unknown": its text may hold a URL or a token. */
export function crmReason(e: unknown): string {
  if (!(e instanceof CrmError)) return 'an unknown error';
  const s = e.status;
  if (e.code === 'upstream_error' && typeof s === 'number') {
    if (s === 401 || s === 403) return `the CRM refused the token (HTTP ${s}): CRM_API_READ_TOKEN does not belong to this CRM worker`;
    if (s === 404) return 'the CRM has no such endpoint (HTTP 404): check CRM_API_URL points to the right worker';
    if (s >= 500) return `the CRM had an error of its own (HTTP ${s})`;
    return `the CRM answered with HTTP ${s} (check CRM_API_READ_TOKEN and that the URL is the right worker)`;
  }
  return REASON[e.code];
}

export interface CrmProbe {
  endpoint: 'metrics' | 'orders';
  ok: boolean;
  ms: number;
  bytes?: number;
  reason?: string;
}

/** Env facts (host only) and, when the CRM is enabled, one GET of the lightest endpoint (metrics) and one of the endpoint the channel report reads (orders). Never throws. */
export async function crmHealth(env: CrmEnv, deps: {fetch?: typeof fetch} = {}) {
  const access = resolveCrmAccess(env);
  const facts = describeCrmEnv(env);
  if (!access.enabled) return {...facts, probes: [] as CrmProbe[]};
  const client = createCrmClient({baseUrl: access.baseUrl, token: access.token, fetch: deps.fetch ?? fetch});
  const probes: CrmProbe[] = [];
  for (const endpoint of ['metrics', 'orders'] as const) {
    const t0 = Date.now();
    try {
      const r = await client.get(endpoint);
      probes.push({endpoint, ok: true, ms: r.ms, bytes: r.bytes});
    } catch (e) {
      probes.push({endpoint, ok: false, ms: Date.now() - t0, reason: crmReason(e)});
    }
  }
  return {...facts, probes};
}
