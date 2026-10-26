// The ONE place for every number the `crm_query` tool and its "give me all of it" strategy use (plan 2026-10-23, 4.5).
// A decision change (a ceiling, the time budget) is a one-line edit here. The CRM enforces its own, stricter-or-equal caps: it stays the authority.
export const QUERY_LIMITS = Object.freeze({
  /** To the model (decision 7): row-level, grouped, bytes. */
  modelRows: 200,
  modelGrouped: 500,
  modelBytes: 64 * 1024,
  /** Identity rows the model may see (decision 3 plus the cap in 4.1). */
  modelIdentity: 50,
  /** When the owner asked for all: the model gets a sample of this size, the owner gets the table. */
  modelSample: 50,
  /** To the owner: rows drawn on screen, and rows kept for Copy / CSV. */
  screenRows: 1000,
  csvRows: 10_000,
  /** Rows asked of the CRM per page while paging (the CRM's own row cap lowers it). */
  pageRows: 500,
  /** The Vercel function allows 60 s; the page loop stops at about 40 s. */
  budgetMs: 40_000,
  /** The raw JSON spec the client will send. */
  maxSpecChars: 2000,
  catalogTtlMs: 10 * 60_000,
  /** Spec shape caps (the CRM applies the same). */
  maxSelect: 12,
  maxFilters: 12,
  maxGroupBy: 3,
  maxOrderBy: 3,
  maxIn: 50,
  maxText: 100,
  maxComputed: 4,
  maxJoins: 3,
  maxExprChars: 120,
  maxTopN: 50,
});
