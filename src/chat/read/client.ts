import 'server-only';
import {createClient} from '@supabase/supabase-js';
import {buildChatReadConfig} from './config';
import {createGuardedFetch, type GuardedFetchOptions, type GuardStats} from './guarded-fetch';
import {dailyRelationForMode, digestRelationForMode, relationsForMode, type ChatDailyRelation, type ChatDigestRelation, type ChatReadMode, type ChatRelation} from './relations';
import type {ReadBuilder} from '../../pos-orders-read';

// The ONLY file under src/chat that imports @supabase/supabase-js (layer 2).

/** Select-builder surface for chat reads. No insert/update/upsert/delete/rpc/storage/auth. */
export interface ChatReadBuilder extends ReadBuilder {
  order(column: string, options?: {ascending?: boolean}): ChatReadBuilder;
  range(from: number, to: number): ChatReadBuilder;
  limit(count: number): ChatReadBuilder;
  eq(column: string, value: string | number | boolean): ChatReadBuilder;
  in(column: string, values: readonly (string | number)[]): ChatReadBuilder;
  gte(column: string, value: string | number): ChatReadBuilder;
  lte(column: string, value: string | number): ChatReadBuilder;
  or(filters: string): ChatReadBuilder;
}

/** Layer 3: only `from(allowedRelation).select(...)` exists on the type. */
export interface ChatReadClient {
  from(relation: ChatRelation): {select(columns: string): ChatReadBuilder};
}

/** The digest client: one relation (the digest view or table), select only. */
export interface ChatDigestClient {
  from(relation: ChatDigestRelation): {select(columns: string): ChatReadBuilder};
}

/** The per-day marketplace sales client: one relation (the daily view or table), select only. */
export interface ChatDailyClient {
  from(relation: ChatDailyRelation): {select(columns: string): ChatReadBuilder};
}

export interface ChatReadClientOptions {
  /** Required: a caller that forgets it must fail, not silently get the service-role client (fail closed). */
  mode: ChatReadMode;
  env?: Record<string, string | undefined>;
  onTrip?: GuardedFetchOptions['onTrip'];
}

function build(opts: ChatReadClientOptions, relations: (mode: ChatReadMode) => readonly string[]) {
  const env = opts.env ?? process.env;
  const mode = opts.mode;
  if (mode !== 'guarded_service' && mode !== 'ro_role') throw new Error('chat read client: mode is required (guarded_service or ro_role)');
  const {url, key, apikey} = buildChatReadConfig({mode, env});

  const {fetch: guarded, stats} = createGuardedFetch({
    baseUrl: url,
    relations: relations(mode),
    underlying: fetch,
    onTrip: opts.onTrip,
  });
  const supabase = createClient(url, key, {
    auth: {persistSession: false, autoRefreshToken: false},
    // ro_role: the minted JWT stays the bearer token; an optional apikey header overrides supabase-js's default (key).
    global: {fetch: guarded, headers: apikey ? {apikey} : undefined},
  });
  return {supabase, stats, mode};
}

export function chatReadClient(opts: ChatReadClientOptions): {client: ChatReadClient; stats: GuardStats; mode: ChatReadMode} {
  const {supabase, stats, mode} = build(opts, (m) => relationsForMode(m).allowed);
  return {client: supabase as unknown as ChatReadClient, stats, mode};
}

/** Same layers, but the guard allows ONLY the digest relation for the mode: no POS table is reachable through it. */
export function chatDigestClient(opts: ChatReadClientOptions): {client: ChatDigestClient; stats: GuardStats; mode: ChatReadMode} {
  const {supabase, stats, mode} = build(opts, (m) => [digestRelationForMode(m)]);
  return {client: supabase as unknown as ChatDigestClient, stats, mode};
}

/** Same layers, but the guard allows ONLY the per-day marketplace sales relation for the mode. */
export function chatDailyClient(opts: ChatReadClientOptions): {client: ChatDailyClient; stats: GuardStats; mode: ChatReadMode} {
  const {supabase, stats, mode} = build(opts, (m) => [dailyRelationForMode(m)]);
  return {client: supabase as unknown as ChatDailyClient, stats, mode};
}
