import {beforeEach, describe, expect, it} from 'vitest';
import type {ChatBlock} from '../src/chat/block-types';
import {resetCatalogCache} from '../src/chat/crm/query-catalog';
import {assertRequestShape} from '../src/chat/request-shape';
import type {MetricData} from '../src/chat/result-types';
import {UNTRUSTED_TEXT_TOOLS} from '../src/chat/loop';
import {chatTools} from '../src/chat/tool-defs';
import {createExecutors, statusFor} from '../src/chat/tool-executors';
import {aggBody, fakeQueryCrm} from './support/fake-crm-query';

const NOW = new Date('2026-10-07T04:00:00Z');
const data = (): MetricData => ({source: 'live', orders: [], events: [], prices: [], priceChanges: [], bulkReads: []});
const WIN = [{column: 'created_at', op: 'gte', value: '2026-09-01'}, {column: 'created_at', op: 'lte', value: '2026-09-30'}];
beforeEach(() => resetCatalogCache());

describe('crm_query in the chat wiring', () => {
  it('is registered with a CRM client, stored as a result (r1), status line is a constant, and its text is untrusted', async () => {
    const ex = createExecutors({data: async () => data(), now: NOW, user: null, crm: fakeQueryCrm({rows: 3}).client});
    const out = (await ex.crm_query?.({table: 'orders', filters: WIN, select: ['order_number']})) as {id: string; metric: string};
    expect(out).toMatchObject({id: 'r1', metric: 'crm_query'});
    expect(statusFor('crm_query', {table: 'customers', detail: 'identity'})).toBe('Querying the website CRM');
    expect(UNTRUSTED_TEXT_TOOLS.has('crm_query')).toBe(true);
    expect(Object.keys(createExecutors({data: async () => data(), now: NOW, user: null})).includes('crm_query')).toBe(false);
  });
  it('identity follows the same decision as `contacts`: only with ctx.identity', async () => {
    const people = {...aggBody([{name: 'full_name'}], [{full_name: 'Ana Persona'}]), mode: 'identity'};
    const input = {table: 'customers', detail: 'identity', limit: 5};
    const denied = createExecutors({data: async () => data(), now: NOW, user: 'o@example.test', crm: fakeQueryCrm({answer: () => people}).client});
    expect(await denied.crm_query?.(input)).toMatchObject({error: expect.stringMatching(/not available to this user/)});
    const allowed = createExecutors({data: async () => data(), now: NOW, user: 'o@example.test', crm: fakeQueryCrm({answer: () => people}).client, identity: true});
    expect(await allowed.crm_query?.(input)).toMatchObject({rows: [{full_name: 'Ana Persona'}]});
  });
  it('the model payload keeps the rows crm_query already capped (up to 500 grouped), not the 100 of the older tools', async () => {
    const rows = Array.from({length: 300}, (_, i) => ({sku: `S${i}`, units: i}));
    const ex = createExecutors({data: async () => data(), now: NOW, user: null, crm: fakeQueryCrm({answer: () => aggBody([{name: 'sku'}, {name: 'units', agg: 'sum'}], rows)}).client});
    const out = (await ex.crm_query?.({table: 'order_lines', filters: WIN, select: [{agg: 'sum', column: 'quantity', as: 'units'}], group_by: ['sku'], limit: 500})) as {rows: unknown[]};
    expect(out.rows).toHaveLength(300);
  });
  it('deliver all draws the owner table through emitBlock and tells the model it was shown', async () => {
    const blocks: ChatBlock[] = [];
    const ex = createExecutors({data: async () => data(), now: NOW, user: null, crm: fakeQueryCrm({rows: 260}).client, emitBlock: (b) => blocks.push(b)});
    const out = (await ex.crm_query?.({table: 'orders', filters: WIN, select: ['order_number'], deliver: 'all'})) as {shown: boolean; rows: unknown[]};
    expect(out.shown).toBe(true);
    expect(out.rows).toHaveLength(50);
    expect(blocks[0].kind === 'table' && blocks[0].rows.length).toBe(260);
  });
  it('the request-shape guard accepts crm_query as a non-strict tool and still refuses it as anything else', () => {
    const tools = chatTools({explore: true, crm: true, contacts: true});
    expect(() => assertRequestShape({model: 'm', max_tokens: 1, messages: [], tools})).not.toThrow();
    const q = tools.find((t) => t.name === 'crm_query')!;
    expect(() => assertRequestShape({model: 'm', max_tokens: 1, messages: [], tools: [{...q, strict: undefined}]})).toThrow(/strict/);
    expect(() => assertRequestShape({model: 'm', max_tokens: 1, messages: [], tools: [{...q, name: 'crm_sql'}]})).toThrow(/allowlist/);
  });
  it('the tool description says when to use which tool, carries no secret and no URL parameter', () => {
    const q = chatTools({explore: false, crm: true}).find((t) => t.name === 'crm_query')!;
    expect(q.description).toMatch(/WHEN TO USE: list_crm_orders, list_crm_customers, list_crm_checkouts and get_crm_metrics keep their fixed views/);
    expect(q.description).toMatch(/get_channel_report stays the choice for comparing channels/);
    expect(q.description).not.toMatch(/https?:|token|bearer/i);
    expect(Object.keys(q.input_schema.properties)).not.toEqual(expect.arrayContaining(['url', 'path', 'method', 'sql']));
    expect(JSON.stringify(q)).not.toMatch(/[–—]/); // no en or em dashes in copy
  });
});

describe('crm_query results feed the existing chart and table pipeline', () => {
  it('render_chart and render_table bind to a stored crm_query result by id (a per-week series, auto form)', async () => {
    const blocks: ChatBlock[] = [];
    const rows = ['2026-09-07', '2026-09-14', '2026-09-21'].map((w, i) => ({created_at_week: w, units: 10 + i * 5}));
    const ex = createExecutors({data: async () => data(), now: NOW, user: null, emitBlock: (b) => blocks.push(b), crm: fakeQueryCrm({answer: () => aggBody([{name: 'created_at_week'}, {name: 'units', agg: 'sum'}], rows)}).client});
    const out = (await ex.crm_query?.({table: 'order_lines', filters: WIN, select: [{agg: 'sum', column: 'quantity', as: 'units'}], group_by: [{column: 'created_at', bucket: 'week'}]})) as {id: string};
    expect(out.id).toBe('r1');
    const chart = await ex.render_chart?.({block: 'new', source: out.id, kind: 'auto', orientation: 'auto', x: 'auto', y: ['auto'], title: 'Weekly units'});
    expect(chart).toMatchObject({ok: true});
    const table = await ex.render_table?.({block: 'new', source: out.id, columns: ['auto'], title: 'Weekly units'});
    expect(table).toMatchObject({ok: true});
    expect(blocks.map((b) => b.kind)).toEqual(['chart', 'table']);
  });
});
