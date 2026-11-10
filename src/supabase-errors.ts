/** A PostgREST / supabase-js error, as much of it as the callers read. */
export interface DbError {
  message: string;
  code?: string;
}

/**
 * True when the table does not exist yet (PostgREST schema cache miss PGRST205, or Postgres undefined_table 42P01): the
 * environment has not run its supabase/*.sql by hand. Callers then say "not set up" instead of crashing or reading 0.
 */
export function isMissingTable(error: DbError | null | undefined): boolean {
  if (!error) return false;
  return error.code === 'PGRST205' || error.code === '42P01' || /could not find the table|relation .* does not exist/i.test(error.message);
}

/**
 * A write's error, with one PostgREST quirk folded in: an insert/delete on a table that does not exist can come back as HTTP
 * 404 with an EMPTY error body (seen on PostgREST 12.2), which isMissingTable cannot recognise. That case is reported as
 * PGRST205 so callers say "not set up" instead of "saving failed".
 */
export function writeError(r: {error: {message?: string; code?: string} | null; status: number}): DbError | null {
  if (!r.error) return null;
  if (r.status === 404 && !r.error.code && !r.error.message) return {code: 'PGRST205', message: 'table not found (HTTP 404, empty body)'};
  return {message: r.error.message ?? '', ...(r.error.code ? {code: r.error.code} : {})};
}
