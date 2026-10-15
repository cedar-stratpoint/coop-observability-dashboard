import 'server-only';
import {unstable_cache} from 'next/cache';
import {MOCK_DIGESTS} from '../mock';
import {dedupeReruns, sameWindow, windowOf, type DigestWindow} from '../digest-windows';
import {maskRows} from '../pii';
import {MOCK_POS_EVENTS, MOCK_POS_ORDERS} from '../pos-sales-mock';
import {logGuardTrip} from './audit';
import type {DigestSource} from './digest-lookup';
import {chatDigestClient, chatReadClient} from './read/client';
import {readDigestIndex, readDigestRowAt, readDigestRows, DIGEST_ROW_LIMIT, type DigestRow} from './read/digest';
import {loadMetricData} from './read/metric-data';
import {assertChatReadable} from './read/mode';
import type {ChatReadMode} from './read/relations';
import type {MetricData} from './result-types';

// Glue for the chat route: the cached MetricData loader and the unavailable-error. One place that touches env.

export class ChatUnavailableError extends Error {
  readonly status = 503;
}

let warned = false;

function mockData(): MetricData {
  return {
    source: 'mock',
    orders: MOCK_POS_ORDERS,
    events: MOCK_POS_EVENTS,
    prices: [],
    priceChanges: [],
    bulkReads: [
      {relation: 'mock_orders', rows: MOCK_POS_ORDERS.length},
      {relation: 'mock_events', rows: MOCK_POS_EVENTS.length},
    ],
  };
}

// The client lives inside the cached function (it cannot be cached), and its guard stats are dropped. Trips are
// logged through onTrip. A burst of questions inside 60 seconds reads the database once.
// The cache key is the function's arguments: `project` (the archive host, never a secret) keeps two Supabase projects from ever
// sharing an entry, and the miss log shows how close the data is to the 2 MiB data-cache item limit.
const projectOf = (): string => {
  try {
    return new URL(process.env.SUPABASE_URL_ARCHIVE ?? '').host;
  } catch {
    return 'none';
  }
};
const loadCached = unstable_cache(
  async (mode: ChatReadMode, _project: string): Promise<MetricData> => {
    const {client} = chatReadClient({mode, onTrip: (b) => logGuardTrip({layer: 'http_guard', detail: b})});
    const data = await loadMetricData(client, mode);
    console.info(JSON.stringify({event: 'chat_data_loaded', orders: data.orders.length, bytes: JSON.stringify(data).length}));
    return data;
  },
  ['chat-metric-data'],
  {revalidate: 60, tags: ['chat-metric-data']},
);

export async function getChatMetricData(): Promise<MetricData> {
  if (!process.env.SUPABASE_URL_ARCHIVE) return mockData();
  const readable = assertChatReadable(process.env);
  if (!readable.ok) throw new ChatUnavailableError(readable.message);
  if (readable.warning && !warned) {
    warned = true;
    console.warn(readable.warning);
  }
  return loadCached(readable.mode, projectOf());
}

export type ChatDataResult = {ok: true; data: MetricData} | {ok: false; reason: string};

const degradedSeen = new Set<string>();

/**
 * A loader error as a log-safe reason: the message (our own text plus what Supabase answered, such as "Invalid API key" or "JWT
 * expired") with anything token-like removed and the length capped, so the log says WHY the live path failed without secrets.
 */
export function safeReason(err: unknown): string {
  const name = (err as Error)?.name ?? 'Error';
  const raw = String((err as Error)?.message ?? '');
  const clean = raw
    .replace(/eyJ[A-Za-z0-9_-]{10,}(\.[A-Za-z0-9_-]+){0,2}/g, '[token]') // JWTs
    .replace(/(sb_(secret|publishable)_|sk-ant-)[A-Za-z0-9_-]+/g, '[key]')
    .replace(/https?:\/\/[^\s"')]+/g, '[url]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
  return clean ? `data load failed (${name}): ${clean}` : `data load failed (${name})`;
}

/**
 * The data for this request, or a reason the live-data path is unavailable (production before the read-only role is
 * applied, a missing secret, a failed load). The caller then runs digest-only: no tools, no POS reads. Fail closed on
 * data, never on the whole chat. Each distinct reason is logged once per process.
 */
export async function getChatMetricDataOrDegrade(): Promise<ChatDataResult> {
  try {
    return {ok: true, data: await getChatMetricData()};
  } catch (err) {
    const reason = err instanceof ChatUnavailableError ? err.message : safeReason(err);
    if (!degradedSeen.has(reason)) {
      degradedSeen.add(reason);
      console.warn(JSON.stringify({event: 'chat_degraded', reason}));
    }
    return {ok: false, reason};
  }
}

// F10 + F.5: the stored digests for get_digest. Their own guarded client (one relation, `bundle` refused). Each read is cached for five
// minutes like the dashboard's digest read, under the same tag, so revalidateTag('digest-archive') refreshes all three.
const loadDigestCached = unstable_cache(
  async (mode: ChatReadMode, _project: string): Promise<DigestRow[]> => {
    const {client} = chatDigestClient({mode, onTrip: (b) => logGuardTrip({layer: 'http_guard', detail: b})});
    return readDigestRows(client, mode);
  },
  ['chat-digest'],
  {revalidate: 300, tags: ['digest-archive']},
);
// The window index: window_from, window_to and created_at of every row (no JSON), small enough for one cache entry.
const loadDigestIndexCached = unstable_cache(
  async (mode: ChatReadMode, _project: string): Promise<DigestWindow[]> => {
    const {client} = chatDigestClient({mode, onTrip: (b) => logGuardTrip({layer: 'http_guard', detail: b})});
    return readDigestIndex(client, mode);
  },
  ['chat-digest-index'],
  {revalidate: 300, tags: ['digest-archive']},
);
// One older document at a time (outside the DIGEST_ROW_LIMIT newest): one cache entry per window, never every JSON in one key.
const loadDigestRowCached = unstable_cache(
  async (mode: ChatReadMode, _project: string, from: string, to: string, createdAt: string): Promise<DigestRow | null> => {
    const {client} = chatDigestClient({mode, onTrip: (b) => logGuardTrip({layer: 'http_guard', detail: b})});
    return readDigestRowAt(client, mode, {from, to, createdAt});
  },
  ['chat-digest-row'],
  {revalidate: 300, tags: ['digest-archive']},
);

const mockRows = (): DigestRow[] => maskRows([...MOCK_DIGESTS].sort((a, b) => b.window_to.localeCompare(a.window_to)));
const byWindow = (ws: DigestWindow[]): DigestWindow[] => dedupeReruns(ws, (w) => w);

/** Every stored window (a narrow read, re-runs removed), newest first: the per-turn [digests] line. */
export async function getChatDigestIndex(): Promise<DigestWindow[]> {
  if (!process.env.SUPABASE_URL_ARCHIVE) return byWindow(mockRows().map(windowOf));
  const readable = assertChatReadable(process.env);
  if (!readable.ok) throw new ChatUnavailableError(readable.message);
  return byWindow(await loadDigestIndexCached(readable.mode, projectOf()));
}

export async function getChatDigest(): Promise<DigestSource> {
  if (!process.env.SUPABASE_URL_ARCHIVE) {
    const all = mockRows();
    return {source: 'mock', rows: all.slice(0, DIGEST_ROW_LIMIT), index: byWindow(all.map(windowOf)), rowAt: async (w) => all.find((r) => sameWindow(windowOf(r), w)) ?? null};
  }
  const readable = assertChatReadable(process.env);
  if (!readable.ok) throw new ChatUnavailableError(readable.message);
  const project = projectOf();
  const [rows, index] = await Promise.all([loadDigestCached(readable.mode, project), loadDigestIndexCached(readable.mode, project)]);
  return {source: 'live', rows, index: byWindow(index), rowAt: (w) => loadDigestRowCached(readable.mode, project, w.from, w.to, w.createdAt)};
}
