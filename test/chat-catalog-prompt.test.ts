import {readFileSync} from 'node:fs';
import {describe, expect, it, vi} from 'vitest';

vi.mock('server-only', () => ({}));

import {buildDataIndexText, notInDatabaseText, PROMPT_TABLES} from '../src/chat/catalog/prompt';
import {CATALOG_DATA} from '../src/chat/catalog';
import {GO_PATHS} from '../src/chat/go-links';
import {PAGES, resolvePage} from '../src/chat/pages';
import {buildStaticSystem} from '../src/chat/context';
import {estimateTokens} from '../src/chat/skills/load';
import {buildPreamble} from '../src/chat/preamble';
import type {MetricData} from '../src/chat/result-types';

const BUDGET = 14300; // measured 13,002 estimated tokens on 2026-10-07 (Train 3), plus 10%

describe('2b.2 data index in the cached prompt', () => {
  const text = buildDataIndexText();
  it('is deterministic and lists open domains and the most-used tables with columns', () => {
    expect(buildDataIndexText()).toBe(text);
    expect(text).toContain('pos_orders');
    expect(text).toContain('coop_explore_stock_event');
    for (const t of PROMPT_TABLES) expect(text).toContain(`- ${t}:`);
    expect(text).toContain('describe_table'); // the rule itself lives once, in EXP-09 (sql-explore.md)
    expect(text).toMatch(/stock: default Event \(sellable\) stock/);
    expect(text).toContain('list_tables');
  });
  it('never names a closed table or another company', () => {
    expect(text).not.toMatch(/marketplace_tokens|\bgl_|companies|company_users/);
  });
  it('carries no dev notes: no UNKNOWN, no dated PROD evidence, no empty blurb, no digest_archive.bundle', () => {
    expect(text).not.toMatch(/UNKNOWN|PROD \d{4}|\d{4}-\d{2}-\d{2}/);
    expect(text).not.toMatch(/^- [a-z_]+: ?$/m);
    expect(text).not.toMatch(/Test orders:/); // no marker exists, so nothing is said (Task 8: none invented)
    expect(text).not.toMatch(/verbatim customer quotes/);
    const digest = text.split('\n').find((l) => l.startsWith('  columns:') && l.includes('window_from')) ?? '';
    expect(digest).not.toMatch(/bundle \(/);
  });
  it('names pos_orders_completed first among the most-used tables, as the sales default', () => {
    expect(PROMPT_TABLES[0]).toBe('pos_orders_completed');
    expect(text).toMatch(/- sales: default completed orders \(pos_orders_completed\)/);
  });
  it('stays small (most-used tables only, never the whole catalog)', () => {
    expect(estimateTokens(text)).toBeLessThan(1600); // measured about 1,500 on 2026-10-07 (Train 3 Task 8)
    expect(estimateTokens(text)).toBeLessThan(estimateTokens(JSON.stringify(CATALOG_DATA)) / 3);
  });
  it('the Explore system prompt uses it instead of the coop_explore_ views list', () => {
    const s = buildStaticSystem({tools: true, explore: true});
    expect(s).toContain('## Data you can read (run_query)');
    expect(s).not.toContain('## Exploratory views (run_query)');
  });
});

describe('2b.1 the "not in the database" line comes from the catalog', () => {
  it('names each API- or file-only source and why', () => {
    const t = notInDatabaseText();
    expect(t).toMatch(/^Not in the database: /);
    expect(t).toContain('Website CRM Worker');
    expect(t).toContain('Shopee Seller-Center exports');
    expect(t).not.toMatch(/Resend|Anthropic/);
  });
  it('takes flags: with the CRM tools on, the CRM is no longer listed as a gap', () => {
    expect(notInDatabaseText({crm: true})).not.toContain('Website CRM Worker');
    expect(notInDatabaseText({crm: true})).toContain('Shopee Seller-Center exports');
  });
  it('three CRM states (final review finding 4): not wired, website totals only, CRM tools on', () => {
    expect(notInDatabaseText()).toMatch(/Website CRM Worker \([^)]*\) \(an API, not readable by Ask Coop yet\)/);
    const web = notInDatabaseText({website: true});
    expect(web).toContain('website order totals for any dates through get_channel_report');
    expect(web).toContain('customers, carts and order lists not readable by Ask Coop yet');
    expect(web).not.toContain('an API, not readable by Ask Coop yet');
    expect(notInDatabaseText({website: true, crm: true})).not.toContain('Website CRM Worker');
  });
  it('the per-turn preamble passes the flags through', () => {
    const data = {source: 'live', orders: [], events: [], prices: [], priceChanges: [], bulkReads: [], stock: null} as unknown as MetricData;
    const now = new Date('2026-09-28T04:00:00Z');
    expect(buildPreamble(data, now, '', null, {flags: {website: true}})).toContain('through get_channel_report');
    expect(buildPreamble(data, now, '', null, {})).toContain('an API, not readable by Ask Coop yet');
  });
  it('the cached customers term does not hard-code a CRM state', () => {
    expect(buildDataIndexText()).not.toMatch(/website CRM \(API, not readable yet\)/);
  });
});

describe('3.1 and 3.2 pages and go-links come from the catalog', () => {
  it('every catalog route resolves; a fenced page says it is not readable', () => {
    expect(PAGES).toHaveLength(CATALOG_DATA.pages.length);
    for (const p of PAGES) expect(resolvePage(p.route.replace(/\[[^\]]+\]/, 'X1'))?.route, p.route).toBe(p.route);
    expect(resolvePage('/overview')?.data).toMatch(/another company/);
    expect(resolvePage('/crm')?.shows).toBe('redirects to /customers/website-crm');
  });
  it('go-links are the catalog pages Ask Coop can read plus the channel links, and the client list is the same', () => {
    expect(GO_PATHS).toEqual(['/', '/traffic', '/health', '/repricer', '/offline-sales', '/offline-sales/orders', '/offline-sales/events', '/offline-sales/rankings', '/inventory', '/customers/all', '/customers/website-crm', '/customers/leads', '/customers/lazada', '/reports', '/?channel=all', '/?channel=shopee', '/?channel=lazada', '/?channel=website']);
    const client = readFileSync('components/analyst/coop-chat.tsx', 'utf8');
    const m = /const APP_PATHS = new Set\(\[([^\]]*)\]\)/.exec(client);
    expect(m && [...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1])).toEqual([...GO_PATHS]);
  });
});

describe('2b.5 the cached Explore prompt', () => {
  it('matches its snapshot (a reviewed diff when the catalog or skill changes) and stays within budget', () => {
    const s = buildStaticSystem({tools: true, explore: true});
    expect(s).toMatchSnapshot();
    expect(estimateTokens(s)).toBeLessThan(BUDGET);
  });
});
