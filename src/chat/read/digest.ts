import {maskDigestPII} from '../../pii';
import type {PagedResult} from '../../pos-fetch-paginate';
import type {DigestDocument} from '../../types';
import type {DigestWindow} from '../../digest-windows';
import {DIGEST_COLUMNS, DIGEST_INDEX_COLUMNS, digestRelationForMode, type ChatReadMode} from './relations';

// The chat's OWN digest reader (F10). src/data.ts is the dashboard's reader (a full-power service-role client) and the chat
// tree must never import it: this takes an INJECTED client instead (the digest client, which the guard limits to the one
// digest relation). It selects only the rendered `digest` plus its window and timestamp. `bundle` (verbatim customer
// quotes) is never named here and the guard refuses it. Names are masked at this seam, like src/data.ts does.
// No server-only, no next/*, no supabase-js import: pure and unit tested.

export interface DigestRow {
  window_from: string;
  window_to: string;
  created_at: string;
  digest: DigestDocument;
}

/** The slice of a select builder this read uses. */
interface DigestReadBuilder extends PromiseLike<PagedResult> {
  order(column: string, options?: {ascending?: boolean}): DigestReadBuilder;
  limit(count: number): DigestReadBuilder;
}
export interface DigestReadClient {
  from(relation: string): {select(columns: string): DigestReadBuilder};
}

/** How many stored digests are read in full (latest, previous, and recent windows); older ones are read one at a time by readDigestRowAt. */
export const DIGEST_ROW_LIMIT = 12;

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

function toRow(raw: unknown): DigestRow | null {
  if (!isRecord(raw) || typeof raw.window_to !== 'string' || !isRecord(raw.digest)) return null;
  return {
    window_from: typeof raw.window_from === 'string' ? raw.window_from : '',
    window_to: raw.window_to,
    created_at: typeof raw.created_at === 'string' ? raw.created_at : '',
    digest: maskDigestPII(raw.digest as unknown as DigestDocument),
  };
}

/** Newest first. A row whose shape is unusable is dropped, not guessed at. Throws when the read fails. */
export async function readDigestRows(client: DigestReadClient, mode: ChatReadMode): Promise<DigestRow[]> {
  const {data, error} = await client
    .from(digestRelationForMode(mode))
    .select(DIGEST_COLUMNS)
    .order('window_to', {ascending: false})
    .limit(DIGEST_ROW_LIMIT);
  if (error) throw new Error(`digest read failed: ${error.message}`);
  return (data ?? []).map(toRow).filter((r): r is DigestRow => r !== null);
}

/** A cap, not a page: far above the archive's size (14 rows on PROD, 2026-10-07). */
export const DIGEST_INDEX_LIMIT = 500;

/** Every stored window, newest window_to first, without the documents (spec F.5 window index). Throws when the read fails. */
export async function readDigestIndex(client: DigestReadClient, mode: ChatReadMode): Promise<DigestWindow[]> {
  const {data, error} = await client.from(digestRelationForMode(mode)).select(DIGEST_INDEX_COLUMNS).order('window_to', {ascending: false}).limit(DIGEST_INDEX_LIMIT);
  if (error) throw new Error(`digest index read failed: ${error.message}`);
  return (data ?? []).flatMap((raw) =>
    isRecord(raw) && typeof raw.window_from === 'string' && typeof raw.window_to === 'string' && typeof raw.created_at === 'string'
      ? [{from: raw.window_from, to: raw.window_to, createdAt: raw.created_at}]
      : [],
  );
}

interface DigestFilterBuilder extends DigestReadBuilder {
  eq(column: string, value: string): DigestFilterBuilder;
}
export interface DigestRowReadClient {
  from(relation: string): {select(columns: string): DigestFilterBuilder};
}

/** One stored digest by its exact window and run (one older than the DIGEST_ROW_LIMIT newest). Null when absent. */
export async function readDigestRowAt(client: DigestRowReadClient, mode: ChatReadMode, w: DigestWindow): Promise<DigestRow | null> {
  const {data, error} = await client
    .from(digestRelationForMode(mode))
    .select(DIGEST_COLUMNS)
    .eq('window_from', w.from)
    .eq('window_to', w.to)
    .eq('created_at', w.createdAt)
    .limit(1);
  if (error) throw new Error(`digest read failed: ${error.message}`);
  return (data ?? []).map(toRow).find((r): r is DigestRow => r !== null) ?? null;
}
