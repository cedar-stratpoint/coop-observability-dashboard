// The ONE place for every number the `crm_query` tool and its "give me all of it" strategy use (plan 2026-10-23, 4.5).
// A decision change (a ceiling, the time budget) is a one-line edit here. The CRM enforces its own caps and stays the authority: the `crm*` values below
// MIRROR the final zoomy-crm contract (docs/api-query.md, src/lib/crm-catalog.ts: LIMITS and V2) and are only the fallback when the live catalog says otherwise.
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
  /** Rows asked of the CRM per page while paging (the CRM's own paged cap, 500 for rows and 50 for identity, lowers it). */
  pageRows: 500,
  /** The Vercel function allows 60 s; the page loop stops at about 40 s. */
  budgetMs: 40_000,
  /** The raw JSON spec the client will send: the CRM refuses a spec over 4,096 characters. */
  maxSpecChars: 4096,
  catalogTtlMs: 10 * 60_000,
  /** Spec shape caps (the CRM applies the same: LIMITS in crm-catalog.ts). */
  maxSelect: 12,
  maxFilters: 12,
  maxGroupBy: 3,
  maxOrderBy: 3,
  maxIn: 50,
  maxText: 100,
  /** The CRM allows one declared join per query. */
  maxJoins: 1,
  /** Date window the CRM requires on orders, order_lines, order_discount_codes, checkouts and checkout_lines: at most 90 days, or 800 when a group is bucketed by month. */
  crmWindowDays: 90,
  crmMonthWindowDays: 800,
  /** Page size of the CRM's keyset ("all") paging: 500 row-level rows (identity stays at its own cap of 50). There is no row ceiling on the CRM side; ours are screenRows and csvRows. */
  crmPagedRows: 500,
  /** Longest cursor the CRM accepts. A keyset cursor is about 100 characters, so it is NOT the 64 of a plain offset. */
  maxCursorChars: 200,
  /** v2 (crm-catalog.ts V2): computed items, HAVING, top-N. */
  maxHaving: 6,
  maxExprDepth: 4,
  maxExprNodes: 15,
  maxExprLiteral: 1e9,
  roundDigits: 6,
  maxTopN: 50,
  minOrdersMax: 50,
});
