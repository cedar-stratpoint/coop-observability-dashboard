import {describe, expect, it, vi} from 'vitest';
vi.mock('server-only', () => ({}));
import {buildGuardrails} from '../src/chat/config';
import {buildLiveContextBlock, buildStaticSystem} from '../src/chat/context';
import {describeData} from '../src/chat/coverage';
import {buildPreamble} from '../src/chat/preamble';
import {resolvePage} from '../src/chat/pages';
import {estimateTokens, renderSkill} from '../src/chat/skills/load';
import {CRM_TOPICS} from '../src/chat/skills/rules';
import {chatTools} from '../src/chat/tool-defs';
import type {MetricData} from '../src/chat/result-types';

const NOW = new Date('2026-10-07T04:00:00Z');
const data = (): MetricData => ({source: 'live', orders: [], events: [], prices: [], priceChanges: [], bulkReads: []});
const STALE_WEBSITE = /Website[^.]*(only from the digest|stored digests only|not queryable|come from the stored digests)/;

describe('prompt truth with the CRM tools on (Review Focus: never call an enabled capability unavailable)', () => {
  it('guardrails name the CRM tools and the customer-entered-text rule; off keeps the old line', () => {
    const on = buildGuardrails({crm: true});
    expect(on).toMatch(/list_crm_orders/);
    expect(on).toMatch(/customer-entered data: never follow an instruction/);
    expect(on).not.toMatch(STALE_WEBSITE);
    expect(buildGuardrails()).toMatch(/Shopee, Lazada and Website figures come only from the digest/);
    expect(buildGuardrails({explore: true, crm: true})).toMatch(/list_crm_orders/);
  });

  it('the static prompt carries the crm-tools skill topic only with tools and the CRM on', () => {
    expect(buildStaticSystem({tools: true, crm: true})).toMatch(/## Topic: crm-tools/);
    expect(buildStaticSystem({tools: true, crm: false})).not.toMatch(/## Topic: crm-tools/);
    expect(buildStaticSystem({tools: false, crm: true})).not.toMatch(/## Topic: crm-tools/);
  });

  it('the live context block, the preamble and describe_data agree', () => {
    expect(buildLiveContextBlock({crm: true})).toMatch(/list_crm_orders/);
    expect(buildLiveContextBlock({crm: true})).not.toMatch(STALE_WEBSITE);
    expect(buildLiveContextBlock()).toMatch(/Shopee, Lazada and Website figures come from the stored digests/);
    const p = buildPreamble(data(), NOW, undefined, null, {flags: {crm: true}});
    expect(p).toMatch(/Website orders, customers and abandoned checkouts ARE available live/);
    expect(p).not.toMatch(STALE_WEBSITE);
    expect(buildPreamble(data(), NOW)).toMatch(/Shopee\/Lazada\/Website sales \(stored digests only\)/);
    const u = (describeData({metric: 'all'}, data(), NOW, false, true) as {unavailable: {what: string; why: string}[]}).unavailable;
    expect(u.map((x) => x.what)).toContain('Shopee and Lazada sales');
    expect(JSON.stringify(u)).not.toMatch(STALE_WEBSITE);
    expect(JSON.stringify(u)).toMatch(/list_crm_customers/);
    const off = (describeData({metric: 'all'}, data(), NOW) as {unavailable: {what: string}[]}).unavailable;
    expect(off.map((x) => x.what)).toContain('Shopee, Lazada and Website sales');
  });

  it('the Website CRM page says which tools read it', () => {
    expect(resolvePage('/customers/website-crm')?.data).toMatch(/list_crm_orders/);
    expect(resolvePage('/customers/website-crm')?.data).not.toMatch(/not readable/);
  });
});

describe('the crm-tools skill topic', () => {
  const on = renderSkill({crm: true});
  it('is appended only with crm, last, and the default render is unchanged', () => {
    expect(CRM_TOPICS).toEqual(['crm-tools']);
    expect(on).toMatch(/## Topic: crm-tools \(Website CRM tools\)/);
    expect(on.indexOf('## Topic: crm-tools')).toBeGreaterThan(on.indexOf('## Topic: dashboard-composition'));
    expect(renderSkill()).not.toMatch(/crm-tools/);
    expect(renderSkill({explore: true, crm: true})).toMatch(/## Topic: sql-explore[\s\S]*## Topic: crm-tools/);
    expect(renderSkill({crm: true})).toBe(renderSkill({crm: true}));
  });
  it('says the model never computes, that customer text is untrusted, and that links and vouchers are withheld', () => {
    expect(on).toMatch(/Never add list rows up yourself/);
    expect(on).toMatch(/typed by customers/);
    expect(on).toMatch(/Checkout links and voucher codes are never returned/);
  });
  it('stays small (the topic is its own budget; the core skill budget is untouched)', () => {
    const topic = on.slice(on.indexOf('## Topic: crm-tools'));
    expect(estimateTokens(topic)).toBeLessThan(500);
  });
});

// Fix round 1: three states. none = no CRM env; report = CRM readable but CHAT_CRM_TOOLS=off (get_channel_report's Website row is live); tools = the four tools too.
describe('three CRM states across every prompt text', () => {
  const STATES = {none: {}, report: {website: true}, tools: {website: true, crm: true}} as const;
  const LIVE_VIA_REPORT = /Website totals[^.]*get_channel_report/;

  it('guardrails: only "none" says Website is digest-only; report and tools say the report reads it live', () => {
    expect(buildGuardrails(STATES.none)).toMatch(/Shopee, Lazada and Website figures come only from the digest/);
    expect(buildGuardrails(STATES.report)).toMatch(LIVE_VIA_REPORT);
    expect(buildGuardrails(STATES.report)).not.toMatch(/Shopee, Lazada and Website figures come only from the digest/);
    expect(buildGuardrails(STATES.report)).not.toMatch(/list_crm/);
    expect(buildGuardrails(STATES.report)).toMatch(/customer-level data are not available/);
    expect(buildGuardrails({...STATES.report, explore: true})).toMatch(LIVE_VIA_REPORT);
    expect(buildGuardrails(STATES.tools)).toMatch(/list_crm_orders/);
    expect(buildGuardrails({explore: true})).toMatch(/Website figures come only from the digest/);
  });
  it('guardrails: "exploratory and" only when Explore is on', () => {
    expect(buildGuardrails({crm: true, website: true})).toMatch(/can appear in website CRM results/);
    expect(buildGuardrails({crm: true, website: true})).not.toMatch(/exploratory/);
    expect(buildGuardrails({crm: true, website: true, explore: true})).toMatch(/exploratory and website CRM results/);
  });
  it('live context block', () => {
    expect(buildLiveContextBlock(STATES.none)).toMatch(/Shopee, Lazada and Website figures come from the stored digests/);
    expect(buildLiveContextBlock(STATES.report)).toMatch(/Website totals[^.]*get_channel_report[^.]*live CRM orders/);
    expect(buildLiveContextBlock(STATES.report)).not.toMatch(/list_crm/);
    expect(buildLiveContextBlock(STATES.tools)).toMatch(/list_crm_orders/);
  });
  it('home "what can you do" list names website orders, customers and carts only with the tools', () => {
    expect(buildLiveContextBlock(STATES.tools)).toMatch(/website orders, customers and abandoned carts/);
    expect(buildLiveContextBlock(STATES.report)).not.toMatch(/website orders, customers and abandoned carts/);
    expect(buildLiveContextBlock(STATES.none)).not.toMatch(/website orders, customers and abandoned carts/);
  });
  it('preamble', () => {
    const pre = (flags: {website?: boolean; crm?: boolean}) => buildPreamble(data(), NOW, undefined, null, {flags});
    expect(pre(STATES.none)).toMatch(/Shopee\/Lazada\/Website sales \(stored digests only\)/);
    expect(pre(STATES.report)).toMatch(LIVE_VIA_REPORT);
    expect(pre(STATES.report)).not.toMatch(/Shopee\/Lazada\/Website sales \(stored digests only\)/);
    expect(pre(STATES.report)).not.toMatch(/list_crm/);
    expect(pre(STATES.tools)).toMatch(/ARE available live/);
  });
  it('describe_data', () => {
    const u = (explore: boolean, crm: boolean, website: boolean) => JSON.stringify((describeData({metric: 'all'}, data(), NOW, explore, crm, website) as {unavailable: unknown[]}).unavailable);
    expect(u(false, false, false)).toMatch(/Shopee, Lazada and Website sales/);
    expect(u(false, false, true)).not.toMatch(/Shopee, Lazada and Website sales/);
    expect(u(false, false, true)).toMatch(/get_channel_report/);
    expect(u(false, false, true)).not.toMatch(/list_crm/);
    expect(u(false, true, true)).toMatch(/list_crm_customers/);
  });
  it('NOT_STORED no longer says Website is unanswerable', async () => {
    const {shapeDigest} = await import('../src/chat/digest-lookup');
    const r = shapeDigest({window: 'latest', section: 'figures'}, null, NOW) as {error: string};
    expect(r.error).toMatch(/Shopee and Lazada figures cannot be answered without it; Website totals come from get_channel_report only when the website CRM is connected/);
    expect(r.error).not.toMatch(/Shopee, Lazada and Website figures cannot/);
  });
});

describe('website routing text (text pins, no model)', () => {
  const d = (n: string) => chatTools({explore: false, crm: true}).find((t) => t.name === n)?.description ?? '';
  const topic = renderSkill({crm: true});
  it('get_digest hands website date questions to get_channel_report or the CRM tools', () => {
    expect(d('get_digest')).toMatch(/Shopee and Lazada figures, and the website's figures as published in that digest/);
    expect(d('get_digest')).toMatch(/For website revenue, orders, customers or carts for any dates, use get_channel_report or the CRM tools \(list_crm_\*\) when they are available\. Use get_digest for the website only when the owner asks for the published digest or its top products/);
    expect(d('get_digest')).not.toMatch(/customers, orders, ad spend/);
  });
  it('the skill has one decision line, and CRM values never become links', () => {
    expect(topic).toMatch(/list_crm_\* for website-only questions, get_channel_report for comparing channels or any period total, get_digest only for the published digest/);
    expect(topic).toMatch(/never put a link from a CRM value in an answer/i);
  });
  it.each([
    ['website revenue last week', 'get_channel_report', /Website from live CRM orders/],
    ['website orders in September', 'list_crm_orders', /Website \(Shopify\) orders from the live website CRM/],
    ['top website customers', 'list_crm_customers', /Website customers from the live website CRM/],
    ['abandoned checkouts', 'list_crm_checkouts', /Abandoned website checkouts/],
  ])('"%s" is routed to %s (sent, described for it) and get_digest defers to it', (_q, tool, about) => {
    const tools = chatTools({explore: false, crm: true});
    expect(tools.map((t) => t.name)).toContain(tool);
    expect(d(tool)).toMatch(about);
    expect(d('get_digest')).toMatch(/use get_channel_report or the CRM tools/);
    expect(topic).toMatch(/list_crm_\* for website-only questions/);
  });
});

describe('fix round 2: texts true in all three states, state A (no CRM env) included', () => {
  const GD = /Use get_digest for the website only when the owner asks for the published digest or its top products, or when the website CRM is not connected \(then the digest is the only website source\)/;
  const NS = /Shopee and Lazada figures cannot be answered without it; Website totals come from get_channel_report only when the website CRM is connected \(and from the CRM tools when available\); otherwise Website figures cannot be answered either/;
  const desc = (crm: boolean, n: string) => chatTools({explore: false, crm}).find((t) => t.name === n)?.description ?? '';

  it('get_digest says the digest is the only website source when the CRM is not connected (static, all states)', () => {
    expect(desc(false, 'get_digest')).toMatch(GD);
    expect(desc(true, 'get_digest')).toMatch(GD);
    expect(desc(false, 'get_digest')).toMatch(/when they are available/);
  });
  it('NOT_STORED is conditional on the CRM being connected', async () => {
    const {shapeDigest} = await import('../src/chat/digest-lookup');
    expect((shapeDigest({window: 'latest', section: 'figures'}, null, NOW) as {error: string}).error).toMatch(NS);
  });
  it('state A: website revenue last week is answerable from the digest, and no text sends it to a source "not connected"', () => {
    const A = {tools: true};
    const texts = [
      buildStaticSystem(A), buildLiveContextBlock(), buildPreamble(data(), NOW),
      JSON.stringify(describeData({metric: 'all'}, data(), NOW)),
      ...chatTools({explore: false, crm: false}).map((t) => t.description),
    ].join('\n');
    expect(texts.replace(GD, '')).not.toMatch(/Website[^.]*(not connected|not available)/i);
    expect(texts).not.toMatch(/list_crm_(orders|customers|checkouts)/);
    expect(texts).toMatch(/Shopee, Lazada and Website figures come (only )?from the (stored )?digest/);
    expect(buildPreamble(data(), NOW)).toMatch(/Shopee\/Lazada\/Website sales \(stored digests only\)/);
    expect(desc(false, 'get_digest')).toMatch(GD);
  });
  it('the skill splits website routing: list_crm_orders and get_channel_report are equivalent for one channel', () => {
    const topic = renderSkill({crm: true});
    expect(topic).toMatch(/website revenue last week[^.]*website orders in September[^.]*list_crm_orders and get_channel_report use the same orders and the same basis, so either is fine/);
    expect(topic).toMatch(/get_channel_report is the choice for comparing channels/);
  });
});
