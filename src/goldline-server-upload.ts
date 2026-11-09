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
