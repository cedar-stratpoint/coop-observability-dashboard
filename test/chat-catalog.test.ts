import {describe, expect, it} from 'vitest';
import {CATALOG_DATA, catalogTable} from '../src/chat/catalog';

describe('runtime catalog (generated from knowledge/data-catalog by build.mjs)', () => {
  it('has domains with their tables, the 38 pages, the 7 sources and the 3 ambiguous terms', () => {
    expect(CATALOG_DATA.version).toBe(1);
    expect(catalogTable('pos_orders')?.domain).toBe('pos-sales');
    expect(catalogTable('pos_inventory_by_location')?.prefer).toMatch(/coop_explore_stock_event/);
    expect(CATALOG_DATA.domains.find((d) => d.id === 'stock')?.tables).toContain('pos_stock_movements');
    expect(CATALOG_DATA.pages).toHaveLength(38);
    expect(CATALOG_DATA.pages.every((p) => p.title.length > 0)).toBe(true);
    expect(CATALOG_DATA.pages.find((p) => p.route === '/overview')?.fenced).toBe(true);
    expect(CATALOG_DATA.pages.find((p) => p.route === '/crm')?.redirectTo).toBe('/customers/website-crm');
    expect(CATALOG_DATA.pages.find((p) => p.route === '/inventory')?.data).toContain('pos_inventory_by_location');
    expect(CATALOG_DATA.apis.map((a) => a.id)).toEqual(['crm-api', 'shopee-files', 'lazada-api', 'shopify-admin', 'pawpal-supabase', 'resend', 'anthropic']);
    expect(CATALOG_DATA.terms.map((t) => t.term)).toEqual(['stock', 'sales', 'customers']);
  });
  it('holds no secret-looking value', () => {
    expect(JSON.stringify(CATALOG_DATA)).not.toMatch(/eyJ[A-Za-z0-9_-]{8,}\.|sk-[A-Za-z0-9]{16,}|sb_secret_|-----BEGIN/);
  });
});
