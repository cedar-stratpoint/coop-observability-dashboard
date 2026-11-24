// Server-driven scan upload (plan: knowledge/tasks/2026-11-09-server-driven-upload.md). Rolled
// out per company so we can pilot one tenant (Nichido) before widening: a company id listed in
// GOLDLINE_SERVER_UPLOAD_COMPANIES (comma-separated) gets the server-driven path; everyone else
// stays on the current client-driven upload. CSV / single-file uploads are unaffected either way.

/** The allow-listed company ids, parsed from the env (or an explicit value, for tests). */
export function serverUploadCompanies(env: string | undefined = process.env.GOLDLINE_SERVER_UPLOAD_COMPANIES): Set<string> {
  return new Set(
    (env ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/** Whether a company is on the server-driven upload path. Fail-closed: an unset env = no one. */
export function serverUploadEnabled(companyId: string, env?: string): boolean {
  if (!companyId) return false;
  return serverUploadCompanies(env).has(companyId);
}

/**
 * The P1 pump (pg_cron + pg_net) is the only caller of /api/goldline/read-page, so that route
 * is guarded by a shared secret (`GOLDLINE_PUMP_SECRET`) instead of a user session. Compare in
 * constant time to avoid leaking the secret through timing, and fail closed: a missing or
 * empty expected secret, or any length mismatch, never matches.
 */
export function pumpSecretOk(provided: string | null | undefined, expected: string | null | undefined): boolean {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false; // timingSafeEqual requires equal length
  // XOR-accumulate so the comparison time doesn't depend on where the first difference is.
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
