// A FAKE CRM for crm_query tests: GET /api/catalog and GET /api/query?spec= as the zoomy-crm plan (4.1) specifies them. Synthetic data only
// (invented names, example.com addresses); no network. `rows` is a numbered synthetic list served with an offset cursor like the real CRM
// (page = min(limit, rowCap), paging stops at maxOffset), and `answer` can script any other response (aggregates, errors).
import type {CrmClient, CrmEndpointId, CrmRead} from '../../src/chat/crm/client';
import {CrmError} from '../../src/chat/crm/client';

const col = (name: string, type: string, cls: string, meaning: string, o: Record<string, unknown> = {}) => ({name, type, class: cls, meaning, select: false, group: false, filter: [] as string[], aggs: [] as string[], min_group_size_required: false, count_distinct_only: false, ...o});
const text = (name: string, meaning: string, o: Record<string, unknown> = {}) => col(name, 'text', 'safe', meaning, {select: true, group: true, filter: ['eq', 'in', 'is_null'], aggs: ['count', 'count_distinct'], ...o});
const num = (name: string, meaning: string, o: Record<string, unknown> = {}) => col(name, 'number', 'safe', meaning, {select: true, filter: ['eq', 'gte', 'lte', 'between'], aggs: ['sum', 'avg', 'min', 'max', 'count', 'count_distinct'], ...o});
const date = (name: string, meaning: string, o: Record<string, unknown> = {}) => col(name, 'date', 'safe', meaning, {select: true, group: true, filter: ['gte', 'lte', 'between', 'eq', 'is_null'], aggs: ['min', 'max', 'count'], ...o});
const email = col('email', 'text', 'aggregate_only', 'Distinct count only.', {aggs: ['count_distinct'], count_distinct_only: true});

export const CATALOG_BODY = {
  catalog_version: '2026-10-23.1',
  limits: {ROW_CAP_ROWS: 200, ROW_CAP_GROUPED: 500, IDENTITY_CAP: 50, BYTES_CAP: 65536, MAX_OFFSET: 5000},
  tables: [
    {name: 'orders', meaning: 'One row per website order.', row_level: true, window_required: 'created_at', max_window_days: 90, columns: [text('order_number', 'Order number', {group: false}), date('created_at', 'When the order was placed.'), text('financial_status', 'paid, refunded ...'), num('total_price', 'What the customer paid.'), col('customer_ref', 'text', 'safe', 'Opaque customer id.', {filter: ['eq', 'in', 'is_null'], aggs: ['count_distinct']}), email], not_available: ['raw']},
    {name: 'order_lines', meaning: 'One row per order line item.', row_level: true, window_required: 'created_at', max_window_days: 90, columns: [date('created_at', 'When the order was placed.'), text('sku', 'Line SKU.'), text('title', 'Product title.'), num('quantity', 'Units on the line.'), num('line_gross', 'unit_price x quantity.'), num('refunded_amount', 'Refunded line value.'), email], not_available: []},
    {name: 'order_discount_codes', meaning: 'One row per discount code on an order.', row_level: true, window_required: 'created_at', max_window_days: 90, columns: [date('created_at', 'When the order was placed.'), text('code', 'The code.'), num('amount', 'Amount taken off.'), email], not_available: []},
    {name: 'checkouts', meaning: 'One row per checkout; converted_at null = abandoned.', row_level: true, window_required: 'created_at', max_window_days: 90, columns: [date('created_at', 'When the checkout started.'), date('converted_at', 'When it became an order.'), num('total_price', 'Cart value.'), email], not_available: []},
    {name: 'customers', meaning: 'One row per customer. Aggregate-only.', row_level: false, window_required: null, max_window_days: null, columns: [col('membership_tier', 'text', 'aggregate_only', 'Tier.', {group: true, filter: ['eq', 'in'], aggs: ['count']}), col('orders_count', 'number', 'aggregate_only', 'Orders count.', {filter: ['gte', 'lte'], aggs: ['sum', 'avg', 'count']}), email], not_available: ['raw']},
  ],
  identity_detail: {table: 'customers', fields: ['customer_ref', 'full_name', 'email', 'phone', 'pet_name', 'pet_birthday', 'membership_tier', 'orders', 'total_spent', 'first_order_at', 'last_order_at', 'last_order_skus', 'discount_codes_used'], untrusted_text_fields: ['full_name', 'pet_name'], filters: {customer_ref: {ops: ['eq', 'in']}, email: {ops: ['eq', 'in']}, full_name: {ops: ['eq', 'in']}, membership_tier: {ops: ['eq', 'in', 'is_null']}, orders_count: {ops: ['eq', 'gte', 'lte', 'between']}, total_spent: {ops: ['gte', 'lte', 'between']}}, order_by: ['orders_count', 'total_spent', 'created_at'], cap: 50},
  special_aggregate: {name: 'customers_with_min_orders', takes: 'min (2..50)'},
};

export const V2_CATALOG_BODY = {...CATALOG_BODY, catalog_version: '2026-11-02.1', v2: {joins: ['order_lines'], computed: true, having: true, top_n: true}};

export interface FakeCrmOptions {
  catalog?: unknown | null;
  /** Numbered synthetic rows served by an offset cursor; the columns are `n`, `label`. */
  rows?: number;
  rowCap?: number;
  maxOffset?: number;
  /** Scripted answer for a query spec (aggregates, identity, errors). Return undefined to fall through to the row list. */
  answer?: (spec: Record<string, unknown>) => unknown;
  /** Advance a fake clock per query GET (for the time-budget test). */
  onQuery?: () => void;
}

export interface FakeCrm {
  client: CrmClient;
  /** Every GET, in order: endpoint, parsed spec (query only), the paged flag. */
  calls: {endpoint: CrmEndpointId; spec: Record<string, unknown> | null; paged: boolean}[];
}

const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');
const unb64 = (s: string): {o: number} => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));

export function fakeQueryCrm(opts: FakeCrmOptions = {}): FakeCrm {
  const calls: FakeCrm['calls'] = [];
  const rowCap = opts.rowCap ?? 200;
  const maxOffset = opts.maxOffset ?? 5000;
  const client: CrmClient = {
    async get(endpoint, query, o): Promise<CrmRead> {
      const paged = o?.paged === true;
      if (endpoint === 'catalog') {
        calls.push({endpoint, spec: null, paged});
        if (opts.catalog === null) throw new CrmError('upstream_error', 404);
        return {endpoint, body: opts.catalog ?? CATALOG_BODY, bytes: 100, ms: 1, cached: false};
      }
      if (endpoint !== 'query') throw new CrmError('refused');
      const spec = JSON.parse(String((query ?? {}).spec)) as Record<string, unknown>;
      calls.push({endpoint, spec, paged});
      opts.onQuery?.();
      const scripted = opts.answer?.(spec);
      if (scripted instanceof CrmError) throw scripted;
      if (scripted !== undefined) return {endpoint, body: scripted, bytes: 100, ms: 1, cached: false};
      const total = opts.rows ?? 0;
      const offset = typeof spec.cursor === 'string' ? unb64(spec.cursor).o : 0;
      const limit = Math.min(typeof spec.limit === 'number' ? spec.limit : 50, rowCap);
      const slice = Array.from({length: Math.max(0, Math.min(limit, total - offset))}, (_, i) => ({n: offset + i + 1, label: `Item ${offset + i + 1}`}));
      const more = offset + slice.length < total;
      const stop = more && offset + slice.length > maxOffset;
      return {
        endpoint,
        bytes: 100,
        cached: false,
        ms: 1,
        body: {table: spec.table, mode: 'rows', columns: [{name: 'n', meaning: 'Row number', type: 'number'}, {name: 'label', meaning: 'Row label', type: 'text'}], rows: slice, row_count: slice.length, truncated: more, partial: false, next_cursor: more && !stop ? b64({o: offset + slice.length}) : null, window: {from: '2026-09-01', to: '2026-09-30', tz: 'Asia/Manila'}, notes: stop ? ['Paging stops at the CRM limit; narrow the filters.'] : [], untrusted_text_fields: [], catalog_version: CATALOG_BODY.catalog_version},
      };
    },
  };
  return {client, calls};
}

/** A page body the way the CRM answers an aggregate. */
export const aggBody = (columns: {name: string; agg?: string; meaning?: string; type?: string}[], rows: Record<string, unknown>[], o: Record<string, unknown> = {}) => ({
  table: 'orders', mode: 'aggregate', columns: columns.map((c) => ({meaning: '', type: c.agg ? 'number' : 'text', ...c})), rows, row_count: rows.length, truncated: false, partial: false, next_cursor: null, window: {from: '2026-09-01', to: '2026-09-30', tz: 'Asia/Manila'}, notes: [], untrusted_text_fields: [], catalog_version: CATALOG_BODY.catalog_version, ...o,
});
