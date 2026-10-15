/**
 * Page through a PostgREST / supabase-js table read in fixed chunks.
 *
 * Why this exists: PostgREST caps every response at `db.max_rows` (default
 * 1000). A single unbounded `.select()` on a table past that size is *silently*
 * truncated — no error, just fewer rows. That is exactly how `getPosOrders`
 * once dropped the newest `pos_order_items` and rendered Units = 0 with every
 * sale mis-booked as a "Bundle deal · Itemized ₱0" (see CHANGELOG 2026-09-27).
 *
 * Callers pass a `makePage(from, to)` that applies `.range(from, to)` plus a
 * stable `.order` by a unique key (so pages neither overlap nor skip); this
 * loops until a page shorter than `pageSize` marks the end.
 *
 * `pageSize` must not exceed the server's `db.max_rows`, or a full page could
 * come back capped-short and be mistaken for the last page. The default (1000)
 * sits exactly at PostgREST's default cap.
 *
 * TODO(Option A): the durable fix is server-side aggregation (an RPC or SQL
 * view returning small aggregates) so whole tables are never shipped to JS and
 * row caps stop mattering. When that lands, the bulk reads that use this can
 * retire. See `src/pos-sales.ts` (`posOrdersCached`) and CHANGELOG.
 */
export const POS_PAGE_SIZE = 1000;

export type PagedResult = {data: unknown[] | null; error: {message: string} | null};
export type MakePage = (from: number, to: number) => PromiseLike<PagedResult>;

export async function fetchAllRows(
  label: string,
  makePage: MakePage,
  pageSize: number = POS_PAGE_SIZE,
  opts: {concurrency?: number} = {},
): Promise<Record<string, unknown>[]> {
  // Parallel mode: request `concurrency` pages at once (speculatively) and stop at the
  // first short page. Same result as the sequential loop (pages are kept in order and
  // anything past the first short page is discarded) but ~N× fewer round-trip waits on
  // big reads, at the cost of up to N−1 empty requests at the end.
  const concurrency = Math.max(1, Math.floor(opts.concurrency ?? 1));
  const rows: Record<string, unknown>[] = [];
  for (let from = 0; ; from += pageSize * concurrency) {
    const batch = await Promise.all(
      Array.from({length: concurrency}, (_, k) => {
        const start = from + k * pageSize;
        return makePage(start, start + pageSize - 1);
      }),
    );
    for (const {data, error} of batch) {
      if (error) throw new Error(`${label} read failed: ${error.message}`);
      const page = (data ?? []) as Record<string, unknown>[];
      rows.push(...page);
      if (page.length < pageSize) return rows;
    }
  }
}
