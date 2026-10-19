import {describe, expect, it, vi} from 'vitest';
import {createExecutors} from '../src/chat/tool-executors';
import {chatTools, CHAT_TOOLS} from '../src/chat/tool-defs';
import {assertRequestShape} from '../src/chat/request-shape';
import type {LeadsSource} from '../src/chat/contacts/leads';
import type {ChatBlock} from '../src/chat/block-types';
import type {MetricData} from '../src/chat/result-types';
import {fakeCrmClient} from './support/crm-fixtures';

const SOURCE: LeadsSource = {
  events: [{event_id: 'e1', name: 'Modern Market Sept 2026', starts_on: '2026-09-26', ends_on: '2026-09-28'}],
  leads: [{email: 'ana@example.com', instagram: null, pet: 'Mimi / Puspin', picky: null, mobile: '0917 000 0001', prize: 'Free treat', campaign: null, collectedAt: '2026-09-26T02:00:00Z', consentAt: null}],
};
const data: MetricData = {source: 'live', orders: [], events: [], prices: [], priceChanges: [], bulkReads: []};
const NOW = new Date('2026-10-19T04:00:00Z');
const input = (event: string) => ({mode: 'list_leads', event, contact: 'all', limit: 200});

describe('contacts tool', () => {
  it('is registered only when the route supplies the leads seam', () => {
    expect(Object.keys(createExecutors({data: async () => data, now: NOW, user: 'a@x.com'}))).not.toContain('contacts');
    expect(Object.keys(createExecutors({data: async () => data, now: NOW, user: 'a@x.com', leads: async () => SOURCE}))).toContain('contacts');
  });
  it('draws the table itself, writes one audit line without any contact value, and tells the model the table is shown', async () => {
    const blocks: ChatBlock[] = [];
    const info = vi.fn();
    const ex = createExecutors({data: async () => data, now: NOW, user: 'boss@x.com', leads: async () => SOURCE, emitBlock: (b) => blocks.push(b), sink: {info, error: vi.fn()}});
    const out = (await ex.contacts?.(input('modern market'))) as {shown: boolean; counts: {listed: number}};
    expect(out.shown).toBe(true);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({kind: 'table', pii: true});
    const line = String(info.mock.calls[0][0]);
    expect(JSON.parse(line)).toMatchObject({event: 'chat_pii_read', event_id: 'e1', rows: 1, user: 'boss@x.com', consent_filter: 'none'});
    expect(line).not.toMatch(/example\.com|0917|Mimi|modern market/i);
  });
  it('draft mode draws a Drafts table with Copy all, tells the model only a few samples, and the audit line holds no message text', async () => {
    const blocks: ChatBlock[] = [];
    const info = vi.fn();
    const ex = createExecutors({data: async () => data, now: NOW, user: 'boss@x.com', leads: async () => SOURCE, emitBlock: (b) => blocks.push(b), sink: {info, error: vi.fn()}});
    const out = (await ex.contacts?.({mode: 'draft', event: 'modern market', contact: 'all', limit: 200, channel: 'email', template: 'Hi {{pet}}, secret-promo-text'})) as {shown: boolean; counts: {drafted: number}; samples: string[]};
    expect(out).toMatchObject({shown: true, counts: {drafted: 1}});
    expect(blocks[0]).toMatchObject({kind: 'table', pii: true, copyColumns: {messages: 'message'}});
    const line = String(info.mock.calls[0][0]);
    expect(JSON.parse(line)).toMatchObject({event: 'chat_pii_read', mode: 'draft', rows: 1});
    expect(line).not.toMatch(/secret-promo|Mimi|example\.com/);
  });
  it('a bad draft request is refused with the reason and draws nothing', async () => {
    const blocks: ChatBlock[] = [];
    const ex = createExecutors({data: async () => data, now: NOW, user: null, leads: async () => SOURCE, emitBlock: (b) => blocks.push(b), sink: {info: vi.fn(), error: vi.fn()}});
    const out = (await ex.contacts?.({mode: 'draft', event: 'modern market', contact: 'all', limit: 200, channel: 'email', template: 'Hi {{email}}'})) as {error: string};
    expect(out.error).toMatch(/Unknown placeholder/);
    expect(blocks).toHaveLength(0);
  });
  it('an unclear event returns a question and draws nothing', async () => {
    const blocks: ChatBlock[] = [];
    const ex = createExecutors({data: async () => data, now: NOW, user: null, leads: async () => SOURCE, emitBlock: (b) => blocks.push(b), sink: {info: vi.fn(), error: vi.fn()}});
    const out = (await ex.contacts?.(input('Comic Con'))) as {error?: string};
    expect(out.error).toMatch(/No event matches/);
    expect(blocks).toHaveLength(0);
  });
  it('is offered only with the contacts option, fits the request cap with everything else on, and passes the request-shape guard', () => {
    expect(chatTools({explore: true, crm: true}).some((t) => t.name === 'contacts')).toBe(false);
    expect(CHAT_TOOLS.some((t) => t.name === 'contacts')).toBe(false);
    const all = chatTools({explore: true, crm: true, contacts: true});
    expect(all.some((t) => t.name === 'contacts')).toBe(true);
    expect(all.length).toBeLessThanOrEqual(20);
    expect(() => assertRequestShape({model: 'm', max_tokens: 1, tools: all, messages: []})).not.toThrow();
  });

  it('find reads the website customers through the GET-only CRM client, merges with booth and Lazada, and audits without the query', async () => {
    const blocks: ChatBlock[] = [];
    const info = vi.fn();
    const {client, gets} = fakeCrmClient();
    const source: LeadsSource = {...SOURCE, lazada: [{phone: '09170000001', name: 'Ana Lz', city: null, lastOrderAt: '2026-08-01T00:00:00Z', firstOrderAt: '2026-05-01T00:00:00Z', lastProduct: null, payMethod: null, totalSpent: 100, avgOrder: 100, orderCount: 1, daysSince: 3}]};
    const ex = createExecutors({data: async () => data, now: NOW, user: 'boss@x.com', leads: async () => source, crm: client, emitBlock: (b) => blocks.push(b), sink: {info, error: vi.fn()}});
    const out = (await ex.contacts?.({mode: 'find', query: 'ana@example.com'})) as {shown: boolean; rows: {sources: string}[]};
    expect(out.shown).toBe(true);
    expect(out.rows[0].sources).toBe('website, booth, lazada');
    expect(gets.sort()).toEqual(['customers', 'membership', 'orders']);
    expect(blocks[0]).toMatchObject({kind: 'table', pii: true});
    const lines = info.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes('chat_pii_read'))).toBe(true);
    expect(lines.join('\n')).not.toMatch(/ana@example|0917/);
  });
  it('find without a CRM client still answers from booth and Lazada and says the website is missing', async () => {
    const ex = createExecutors({data: async () => data, now: NOW, user: null, leads: async () => SOURCE, emitBlock: () => undefined, sink: {info: vi.fn(), error: vi.fn()}});
    const out = (await ex.contacts?.({mode: 'find', query: 'ana@example.com'})) as {notes: string[]};
    expect(out.notes.join(' ')).toMatch(/website CRM is not included/);
  });
  it('overlap refuses to answer when the website CRM cannot be read', async () => {
    const {client} = fakeCrmClient({});
    const ex = createExecutors({data: async () => data, now: NOW, user: null, leads: async () => SOURCE, crm: client, emitBlock: () => undefined, sink: {info: vi.fn(), error: vi.fn()}});
    const out = (await ex.contacts?.({mode: 'overlap', a: 'website', b: 'booth'})) as {error: string};
    expect(out.error).toMatch(/website CRM/i);
  });
});
