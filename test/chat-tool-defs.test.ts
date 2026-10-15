import {describe, it, expect} from 'vitest';
import {CHAT_TOOLS, exploreTools} from '../src/chat/tool-defs';
import {METRIC_IDS, METRICS} from '../src/chat/metrics-registry';
import {assertRequestShape} from '../src/chat/request-shape';

type Prop = {type?: unknown; enum?: unknown[]; description?: string; [k: string]: unknown};
const [describe_data, query_metric, get_digest, get_channel_report, lookup_product, render_kpi, render_chart, render_table, set_report_filters, remove_block, set_report_title] = CHAT_TOOLS;
const props = (t: (typeof CHAT_TOOLS)[number]) => t.input_schema.properties as Record<string, Prop>;
const sortedUnion = (pick: (id: (typeof METRIC_IDS)[number]) => string[]) => [...new Set(METRIC_IDS.flatMap(pick))].sort();

const SINK = {info: () => undefined, error: () => undefined};

describe('CHAT_TOOLS', () => {
  it('has exactly the eleven tools in order', () => {
    expect(CHAT_TOOLS.map((t) => t.name)).toEqual(['describe_data', 'query_metric', 'get_digest', 'get_channel_report', 'lookup_product', 'render_kpi', 'render_chart', 'render_table', 'set_report_filters', 'remove_block', 'set_report_title']);
  });

  it('meets the strict-mode limits', () => {
    expect(CHAT_TOOLS.length).toBeLessThanOrEqual(20);
    let total = 0;
    for (const t of CHAT_TOOLS) {
      expect(t.strict).toBe(true);
      expect(t.input_schema.type).toBe('object');
      expect(t.input_schema.additionalProperties).toBe(false);
      const keys = Object.keys(t.input_schema.properties);
      expect([...t.input_schema.required].sort()).toEqual([...keys].sort()); // zero optional parameters
      total += keys.length - t.input_schema.required.length;
      for (const p of Object.values(props(t))) {
        expect(typeof p.type).toBe('string'); // no type arrays (unions)
        for (const banned of ['anyOf', 'oneOf', 'allOf', 'minimum', 'maximum', 'pattern', 'format', 'minLength', 'maxLength', 'minItems', 'maxItems'])
          expect(p).not.toHaveProperty(banned);
        for (const v of p.enum ?? []) expect(['string', 'number']).toContain(typeof v);
        for (const v of p.enum ?? []) if (typeof v === 'number') expect(Number.isInteger(v)).toBe(true);
      }
    }
    expect(total).toBeLessThanOrEqual(24);
  });

  it('builds enums from the registry', () => {
    expect(props(describe_data).metric.enum).toEqual(['all', ...METRIC_IDS]);
    const q = props(query_metric);
    expect(q.metric.enum).toEqual([...METRIC_IDS]);
    expect(q.dimension.enum).toEqual(sortedUnion((id) => METRICS[id].dimensions.map((d) => d.key)));
    expect(q.dimension.enum).toContain('none');
    expect(q.measure.enum).toEqual(['default', ...sortedUnion((id) => METRICS[id].measures.map((m) => m.key))]);
    expect(q.measure.enum).toContain('aov');
  });

  it('has the fixed enums and free-text fields', () => {
    const q = props(query_metric);
    expect(q.range.enum).toEqual(['last_week', 'this_week', 'last_month', 'all_available', 'custom']);
    expect(q.channel.enum).toEqual(['offline', 'all']);
    expect(q.pet.enum).toEqual(['all', 'dog', 'cat', 'both', 'untagged']);
    expect(q.compare_to.enum).toEqual(['none', 'previous_period']);
    expect(q.sort.enum).toEqual(['default', 'value_desc', 'value_asc']);
    expect(q.limit).toMatchObject({type: 'integer', enum: [3, 5, 10, 25]});
    expect(q.from.description).toBe('YYYY-MM-DD or "" unless range is custom');
    expect(q.to.description).toBe('YYYY-MM-DD or "" unless range is custom');
    expect(q.event.type).toBe('string');
    expect(q.event.enum).toBeUndefined();
  });

  it('puts the cache breakpoint on the last tool only', () => {
    for (const t of [describe_data, query_metric, get_digest, get_channel_report, lookup_product, render_kpi, render_chart, render_table, set_report_filters, remove_block]) expect(t.cache_control).toBeUndefined();
    expect(set_report_title.cache_control).toEqual({type: 'ephemeral'});
  });

  it('render_kpi, render_chart and render_table: every field required, enums where possible, ids and names only', () => {
    expect(Object.keys(props(render_kpi)).sort()).toEqual(['block', 'format', 'label', 'source', 'value']);
    expect(props(render_kpi).format.enum).toEqual(['peso', 'count', 'percent']);
    expect(Object.keys(props(render_chart)).sort()).toEqual(['block', 'kind', 'orientation', 'source', 'title', 'x', 'y']);
    expect(props(render_chart).kind.enum).toEqual(['auto', 'line', 'area', 'bar', 'grouped_bar', 'stacked_bar', 'stacked_bar_100', 'pie', 'diverging_bar', 'small_multiples']);
    expect(props(render_chart).orientation.enum).toEqual(['auto', 'vertical', 'horizontal']);
    expect(props(render_chart).y).toMatchObject({type: 'array', items: {type: 'string'}});
    expect(Object.keys(props(render_table)).sort()).toEqual(['block', 'columns', 'source', 'title']);
    for (const t of [render_kpi, render_chart, render_table]) {
      expect(props(t).block.description).toMatch(/"new"/);
      expect(props(t).source.description).toMatch(/never values/);
      expect(t.description).toMatch(/never (the number|values)/);
    }
    expect(render_chart.description).toMatch(/"auto"/);
    expect(render_kpi.description).toMatch(/one-row/);
  });

  it('F8 criterion 11 and F10: eleven strict tools, 0 optionals, 0 unions, and the report tools take enums, a block id and a title only', () => {
    expect(CHAT_TOOLS).toHaveLength(11);
    expect(CHAT_TOOLS.every((t) => t.strict === true)).toBe(true);
    for (const t of CHAT_TOOLS) {
      expect(t.input_schema.required.length).toBe(Object.keys(t.input_schema.properties).length); // 0 optional
      for (const p of Object.values(props(t))) {
        expect(typeof p.type).toBe('string'); // 0 unions
        for (const banned of ['anyOf', 'oneOf', 'allOf']) expect(p).not.toHaveProperty(banned);
      }
    }
    expect(Object.keys(props(set_report_filters))).toEqual(['range', 'from', 'to', 'pet', 'event', 'channel']);
    expect(props(set_report_filters).range.enum).toEqual(['keep', 'last_week', 'this_week', 'last_month', 'all_available', 'custom']);
    expect(props(set_report_filters).pet.enum).toEqual(['keep', 'all', 'dog', 'cat', 'both', 'untagged']);
    expect(props(set_report_filters).channel.enum).toEqual(['keep', 'offline', 'all']);
    expect(Object.keys(props(remove_block))).toEqual(['block']);
    expect(Object.keys(props(set_report_title))).toEqual(['title']);
    for (const t of [set_report_filters, remove_block, set_report_title]) expect(t.description).toMatch(/Call it/);
  });

  it('has no axis, color or free-text data option in any chart schema', () => {
    const all = [render_kpi, render_chart, render_table].flatMap((t) => Object.keys(props(t)));
    for (const banned of ['axis', 'secondary_axis', 'color', 'colors', 'palette', 'data', 'values', 'rows']) expect(all).not.toContain(banned);
  });

  it('is deep-frozen', () => {
    expect(Object.isFrozen(CHAT_TOOLS)).toBe(true);
    expect(Object.isFrozen(query_metric)).toBe(true);
    expect(Object.isFrozen(render_chart.input_schema.properties)).toBe(true);
    expect(Object.isFrozen(query_metric.input_schema)).toBe(true);
    expect(Object.isFrozen(query_metric.input_schema.properties)).toBe(true);
    expect(Object.isFrozen(props(query_metric).range.enum)).toBe(true);
    expect(() => {
      (query_metric as {name: string}).name = 'x';
    }).toThrow();
  });

  it('tells the model when to call each tool', () => {
    expect(describe_data.description).toMatch(/unclear|what you can answer/);
    expect(query_metric.description).toMatch(/ANY figure/);
  });

  it('F.6: get_channel_report takes the owner\'s dates, channels and a granularity, all required, and says what it is not', () => {
    const p = get_channel_report.input_schema.properties as Record<string, Prop & {items?: {enum?: string[]}}>;
    expect(Object.keys(p)).toEqual(['from', 'to', 'channels', 'granularity']);
    expect(p.channels.items?.enum).toEqual(['all', 'shopee', 'lazada', 'website', 'offline']);
    expect(p.granularity.enum).toEqual(['total', 'week', 'month']);
    expect(get_channel_report.description).toMatch(/newest digest wins per day/);
    expect(get_channel_report.description).toMatch(/not combinable/);
    expect(get_channel_report.description).toMatch(/Ad spend, ROAS and top products are not in it/);
    expect(JSON.stringify(get_channel_report.input_schema)).not.toMatch(/bundle|select|sql/i);
  });

  it('F10: get_digest and lookup_product take only enums and a name, all required, and say when to call them', () => {
    expect(Object.keys(props(get_digest))).toEqual(['window', 'from', 'to', 'section']);
    expect(props(get_digest).window.enum).toEqual(['latest', 'previous', 'covering']);
    expect(get_digest.description).toMatch(/weekly or about a month/);
    expect(get_digest.description).not.toMatch(/WEEKLY DIGEST|published once a week/);
    expect(props(get_digest).section.enum).toEqual(['comparison', 'figures', 'sales', 'customers', 'shopee', 'lazada', 'products']);
    expect(Object.keys(props(lookup_product))).toEqual(['query', 'show']);
    expect(props(lookup_product).show.enum).toEqual(['details', 'price_history']);
    expect(props(lookup_product).query.enum).toBeUndefined();
    expect(get_digest.description).toMatch(/Shopee and Lazada figures, and the website's figures as published/);
    expect(get_digest.description).toMatch(/query_metric/);
    expect(lookup_product.description).toMatch(/names a specific product or SKU/);
    expect(lookup_product.description).toMatch(/top_products/);
    // The digest tool cannot name a column, a table or a bundle: its whole input is two enums.
    expect(JSON.stringify(get_digest.input_schema)).not.toMatch(/bundle|select|column|sql/i);
  });

  it('passes the request-shape check, and a wrong tool list fails it', () => {
    const base = {model: 'm', max_tokens: 10, system: 's', messages: [], tools: CHAT_TOOLS, tool_choice: {type: 'auto'}};
    expect(() => assertRequestShape(base, SINK)).not.toThrow();
    const extra = {...CHAT_TOOLS[0], name: 'run_sql'};
    expect(() => assertRequestShape({...base, tools: [...CHAT_TOOLS, extra]}, SINK)).toThrow(/allowlist/);
  });
});

describe('exploreTools (spec 3.1)', () => {
  it('Train 3: the Explore tool list adds list_tables and describe_table after run_query, stays within the strict-tool limit', () => {
    const names = exploreTools().map((t) => t.name);
    expect(names.slice(names.indexOf('run_query'), names.indexOf('run_query') + 3)).toEqual(['run_query', 'list_tables', 'describe_table']);
    expect(names[names.length - 1]).toBe('set_report_title'); // the cache breakpoint stays last
    expect(names.length).toBeLessThanOrEqual(20); // Anthropic strict tool use limit; re-check with the claude-api skill if it fails
  });
  it('Train 3: list_tables offers only domains with an open table (no tenancy, no marketplace-tokens, no empty domain); both are strict', () => {
    const lt = exploreTools().find((x) => x.name === 'list_tables')!;
    const dt = exploreTools().find((x) => x.name === 'describe_table')!;
    const domains = (lt.input_schema.properties as Record<string, {enum: string[]}>).domain.enum;
    expect(domains[0]).toBe('all');
    expect(domains).toContain('pos-sales');
    for (const d of ['tenancy', 'marketplace-tokens', 'goldline', 'pawpal']) expect(domains).not.toContain(d);
    for (const t of [lt, dt]) {
      expect(t.strict).toBe(true);
      expect(t.input_schema.additionalProperties).toBe(false);
      expect(t.input_schema.required.length).toBe(Object.keys(t.input_schema.properties).length);
    }
    expect(exploreTools().find((x) => x.name === 'run_query')!.description).not.toMatch(/coop_explore_\* views listed/);
  });
  it('is CHAT_TOOLS with run_query (then list_tables, describe_table) after query_metric: 14 tools, set_report_title still last with the cache breakpoint', () => {
    const t = exploreTools();
    expect(t).toHaveLength(14);
    expect(t.map((x) => x.name).filter((n) => !['run_query', 'list_tables', 'describe_table'].includes(n))).toEqual(CHAT_TOOLS.map((x) => x.name));
    expect(t.map((x) => x.name).indexOf('run_query')).toBe(t.map((x) => x.name).indexOf('query_metric') + 1);
    expect(t[t.length - 1].name).toBe('set_report_title');
    expect(t[t.length - 1].cache_control).toEqual({type: 'ephemeral'});
    expect(CHAT_TOOLS).toHaveLength(11);
  });
  it('run_query is strict with three required params, step enum and no banned keywords; the strict limits hold', () => {
    const q = exploreTools().find((x) => x.name === 'run_query')!;
    expect(q.strict).toBe(true);
    expect(q.input_schema.required).toEqual(['purpose', 'sql', 'step']);
    expect(q.input_schema.additionalProperties).toBe(false);
    const p = q.input_schema.properties as Record<string, Record<string, unknown>>;
    expect(p.step.enum).toEqual(['probe', 'final']);
    for (const v of Object.values(p)) for (const b of ['maxLength', 'pattern', 'minLength']) expect(v).not.toHaveProperty(b);
    expect(exploreTools().length).toBeLessThanOrEqual(20);
    assertRequestShape({tools: exploreTools(), system: [], messages: []} as never, SINK);
  });
});
