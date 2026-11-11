// A FAKE of the CRM's read-only Shopify door for shopify_query tests: POST /api/shopify/query answers with a scripted `{data, errors, cost}` body (the same envelope as
// zoomy-crm docs/api-shopify-query.md). Synthetic data only. It records every POST so a test can assert that NOTHING was sent (identity refusal, bad input).
import {CrmError, type CrmClient, type CrmRead, type ShopifyBody} from '../../src/chat/crm/client';

export interface FakeDoor {
  client: CrmClient;
  posts: ShopifyBody[];
  gets: string[];
}

export function fakeShopifyDoor(answer: (payload: ShopifyBody) => unknown = () => ({data: {shop: {name: 'Test Shop'}}})): FakeDoor {
  const posts: ShopifyBody[] = [];
  const gets: string[] = [];
  const client: CrmClient = {
    async postShopify(payload): Promise<CrmRead> {
      posts.push(payload);
      const out = answer(payload);
      if (out instanceof CrmError) throw out;
      return {endpoint: 'shopify', body: out, bytes: JSON.stringify(out).length, ms: 1, cached: false};
    },
    async get(endpoint): Promise<CrmRead> {
      gets.push(endpoint);
      throw new CrmError('unreachable');
    },
  };
  return {client, posts, gets};
}

/** Synthetic orders with line items, in the shape Shopify returns them (money as strings). */
export const ORDERS_BODY = {
  data: {
    orders: {
      pageInfo: {hasNextPage: false, endCursor: null},
      nodes: [
        {name: '#1001', createdAt: '2026-09-02T03:00:00Z', displayFinancialStatus: 'PAID', totalPriceSet: {shopMoney: {amount: '450.00', currencyCode: 'PHP'}}, lineItems: {nodes: [{sku: 'ZMYFDMEATBEFWHL01', quantity: 2, title: 'Beef Whole'}, {sku: 'ZMYFDCHKBRSKT02', quantity: 1, title: 'Chicken'}]}},
        {name: '#1002', createdAt: '2026-09-03T03:00:00Z', displayFinancialStatus: 'PAID', totalPriceSet: {shopMoney: {amount: '120.50', currencyCode: 'PHP'}}, lineItems: {nodes: [{sku: '0001234', quantity: 3, title: 'Treat'}]}},
      ],
    },
  },
  cost: {actualQueryCost: 12},
};
