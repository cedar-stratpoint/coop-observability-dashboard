// The audit fingerprint of a validated statement (spec 4.5). libpg-query is parse-only for Postgres 13 to 17 (no `fingerprint`), so
// we compute our own: a shape hash without literals, and a separate truncated hash of the literal values. Neither is reversible and
// neither contains SQL text, a literal or a row, so both are safe to log.
//
// Hashing lives in THIS one file, and the CRM tools' params fingerprint. `createHash(...).update(...)` trips the architecture scanner's ban on `.update(` (a database write
// method); the fix is a pinned exception for exactly this file and method in WRITE_CALL_EXCEPTIONS (test/support/chat-arch-scan.ts),
// not a contorted hashing API (lesson fix-the-gate-not-the-code.md). The same call in any other file is still flagged.
import {createHash} from 'node:crypto';

type Json = null | boolean | number | string | Json[] | {[k: string]: Json};

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

/** The AST with every `location` field removed and every A_Const replaced by `?`; the literals, in traversal order, are collected. */
export function shapeOf(ast: unknown): {shape: Json; constants: Json[]} {
  const constants: Json[] = [];
  const walk = (v: unknown): Json => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      const keys = Object.keys(o);
      if (keys.length === 1 && keys[0] === 'A_Const') {
        const c = {...(o.A_Const as Record<string, unknown>)};
        delete c.location;
        constants.push(c as Json);
        return '?';
      }
      const out: {[k: string]: Json} = {};
      for (const k of keys) if (k !== 'location') out[k] = walk(o[k]);
      return out;
    }
    return (v ?? null) as Json;
  };
  return {shape: walk(ast), constants};
}

export interface StatementFingerprint {
  fingerprint: string; // 16 hex: same for the same query with different literals
  literalsHash: string; // 12 hex: one-way hash of the literal values, in order
  literalCount: number;
}

export function fingerprintStatement(stmt: unknown): StatementFingerprint {
  const {shape, constants} = shapeOf(stmt);
  return {
    fingerprint: sha(JSON.stringify(shape)).slice(0, 16),
    literalsHash: sha(JSON.stringify(constants)).slice(0, 12),
    literalCount: constants.length,
  };
}

const canonical = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(canonical)
    : v !== null && typeof v === 'object'
      ? Object.fromEntries(Object.keys(v as Record<string, unknown>).sort().map((k) => [k, canonical((v as Record<string, unknown>)[k])]))
      : v;

/** Train 4: a one-way 12-hex hash of a tool's parameters for the chat_crm_call audit line. Key order does not matter; not reversible. */
export function paramsFingerprint(params: unknown): string {
  return sha(JSON.stringify(canonical(params ?? null))).slice(0, 12);
}
