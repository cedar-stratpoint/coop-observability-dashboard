// Shared contract for the Talk to Data metrics registry (F3). Types only: no logic, no imports.
// Design: knowledge/architecture/2026-10-01-talk-to-data-design.md §§ 4, 4b, 4c.
// Best practice: knowledge/best-practices/chat-metrics-registry.md

export type MetricId =
  | 'offline_revenue'
  | 'offline_orders'
  | 'offline_aov'
  | 'top_products'
  | 'payment_mix'
  | 'event_rollup'
  | 'pet_mix'
  | 'bundle_sales'
  | 'bundle_picks'
  | 'stock_on_hand'
  | 'stock_cover';

/** What a stored result may be: a registry metric, or one of the lookup tools' results (F10). Only registry metrics can be re-run or saved. */
export type ResultMetricId = MetricId | 'digest' | 'product_lookup' | 'explore' | 'channel_report' | 'crm_metrics' | 'crm_customers' | 'crm_orders' | 'crm_checkouts';

export type PetKey = 'dog' | 'cat' | 'both' | 'untagged';

/** The closed query shape. Every field is required; sentinels replace optionals. */
export interface MetricRequest {
  metric: MetricId;
  dimension: string; // a key from the metric's declared dimensions; 'none' allowed
  measure: string; // a key from the metric's declared measures; 'default' allowed
  range: 'last_week' | 'this_week' | 'last_month' | 'all_available' | 'custom';
  from: string; // YYYY-MM-DD, or '' unless range is 'custom'
  to: string; // YYYY-MM-DD, or '' unless range is 'custom'
  channel: 'offline' | 'all';
  event: string; // an event name or id, or 'all'
  pet: 'all' | PetKey;
  compare_to: 'none' | 'previous_period';
  sort: 'default' | 'value_desc' | 'value_asc';
  limit: 3 | 5 | 10 | 25;
}

export type ColumnUnit = 'PHP' | 'count' | 'percent' | 'units' | 'ratio' | 'text' | 'date';
export type ColumnRole = 'category' | 'time' | 'measure' | 'share' | 'delta';

export interface ResultColumn {
  key: string;
  label: string;
  unit: ColumnUnit;
  role: ColumnRole;
}

export type MetricRow = Record<string, string | number | null>;

export interface MeasureDecl {
  key: string;
  label: string;
  kind: 'measured' | 'allocated' | 'derived';
  unit: ColumnUnit;
  /** One line, plain words. Quoted to the owner as written for allocated and derived measures. */
  method: string;
}

export type CheckStatus = 'ok' | 'info' | 'warn' | 'fail';
export type CheckCode =
  | 'reconciles'
  | 'round_row_count'
  | 'zero_value_lines'
  | 'price_changed_in_period'
  | 'small_sample'
  | 'untagged_share'
  | 'partial_coverage'
  | 'sudden_change'
  | 'mock_source'
  | 'values_hidden';

export interface Check {
  code: CheckCode;
  status: CheckStatus;
  /** Pre-formatted plain-language text. */
  text: string;
  values?: Record<string, number | string | null>;
}

export type InsightCode =
  | 'top_contributor'
  | 'concentration'
  | 'single_item_exclusive'
  | 'biggest_change'
  | 'close_values'
  | 'untagged_share';

export interface Insight {
  code: InsightCode;
  /** Pre-formatted by code. The model quotes it, never rewrites the numbers. */
  text: string;
  values: Record<string, number | string | null>;
}

export type Coverage = 'full' | 'partial' | 'none';

export interface ResultMeta {
  source: 'live' | 'mock' | 'digest';
  range: {from: string; to: string; label: string}; // inclusive PHT dates
  dataFrom: string | null; // earliest PHT day with a (non-voided) order
  dataTo: string | null;
  rowCount: number;
  coverage: Coverage;
  coveredFrom: string | null;
  coveredTo: string | null;
  caveats: string[];
  share_basis: string | null; // e.g. "tagged bundle revenue"
  measure: string; // the measure actually used
  measures: MeasureDecl[]; // every measure this metric declares
  insights: Insight[];
  checks: Check[];
  reliable: boolean; // false when any check is 'fail'
  /** Set only on an Explore (run_query) result: the label the block shows, the SQL for the disclosure (never given to the model), a code-written coverage note and lint warnings. */
  exploratory?: {label: string; sql: string; coverage_note: string; warnings: string[]};
}

export interface MetricResult {
  id: string; // 'r1', 'r2', ... assigned by the loop's result store, '' until stored
  metric: ResultMetricId;
  dimension: string;
  columns: ResultColumn[];
  rows: MetricRow[];
  meta: ResultMeta;
}

export interface MetricError {
  error: string; // plain words; lists the allowed values where relevant
}

// ---- inputs the registry hands to the pure checks and insights modules -------------------------------------------

export interface ChecksInput {
  mockSource: boolean;
  /** Row counts of each bulk read behind the result (flags a suspicious round 1,000). */
  bulkReads: {relation: string; rows: number}[];
  /** Each parts-to-whole claim the result makes. Money in pesos, shares in percent. */
  /** format defaults to 'peso'. tolerance defaults to 0 (compared in whole centavos) for peso/count and 0.1 for percent. */
  reconcile: {label: string; parts: number[]; whole: number; format?: 'peso' | 'count' | 'percent'; tolerance?: number}[];
  /** Raw ₱0 lines in the source, and whether an allocated measure replaces them. */
  zeroValueLines: {count: number; allocatedMeasureUsed: boolean} | null;
  priceChanges: {count: number; spanDays: number} | null;
  /** Orders (or rows) behind this slice. null = not applicable. */
  sampleSize: number | null;
  untagged: {orders: number; totalOrders: number} | null;
  coverage: {from: string; to: string; dataFrom: string | null; dataTo: string | null};
  /** Change versus the previous period. null = no comparison asked. */
  change: {previous: number; current: number} | null;
}

export interface InsightsInput {
  basis: string; // e.g. "tagged bundle revenue"
  format: 'peso' | 'count' | 'percent' | 'units';
  /** One breakdown. The caller excludes untagged/other buckets. */
  items: {label: string; value: number}[];
  untagged?: {label: string; value: number; orders?: number; totalOrders?: number} | null;
  /** Optional cross-tab for "all of X is one Y" (rows = e.g. pets, cols = e.g. bundles). */
  matrix?: {rows: string[]; cols: string[]; values: number[][]} | null;
  /** The same breakdown for the previous period, for biggest_change. */
  previous?: {label: string; value: number}[] | null;
}

// ---- data the pure executor receives (loading is a separate module) -------------------------------------------------

export interface MetricData {
  source: 'live' | 'mock';
  orders: import('../pos-sales-types').PosOrder[];
  events: import('../pos-sales-types').PosEvent[];
  /** Product price lookups and change log (see src/pos-price-history.ts). */
  prices: {product_id: string; price: number}[];
  priceChanges: {product_id: string; old_price: number | null; new_price: number; changed_at: string}[];
  /** Row counts of the bulk reads, for the round-row-count check. */
  bulkReads: {relation: string; rows: number}[];
  stock?: StockData | null;
}

/** Stock for the registry stock metrics (Train 3). "As of now": stock has no date range. null = the stock read failed. */
export interface StockData {
  byLocation: {product_id: string; location: string; stock: number}[];
  names: Record<string, string>;
  /** Sale movements of the last FORECAST_WINDOW_DAYS days, as units and Manila day (the Inventory forecast's input). */
  sales: import('../pos-forecast-compute').SaleMovement[];
  config: import('../pos-forecast-compute').ForecastConfig;
  asOf: string;
}

