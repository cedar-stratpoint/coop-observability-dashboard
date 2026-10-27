// CONTRACT test (knowledge/lessons/build-against-the-final-contract-not-a-partial-one.md): shopify_query is pinned to the FINAL zoomy-crm Shopify door
// (branch feat/api-shopify-query, docs/api-shopify-query.md). The queries below are SYNTHETIC COPIES of the cases in the CRM's own guard suites
// (test/shopify-query-guard.test.ts and test/shopify-query-malicious.test.ts) with the CRM's verdicts; no cross-repo import. The CRM is the authority:
//  - everything the CRM ACCEPTS must pass our courtesy checks (we never refuse what the CRM would run, for an allowlisted user);
//  - what the CRM REFUSES is either caught by our courtesy checks (the "we catch" list, which must be refused here too) or left to the CRM (the "left to the CRM"
//    list, which we pass on without crashing, and whose 400 reason then reaches the model).
import {describe, expect, it} from 'vitest';
import {isIdentityDenied, readShopifyInput} from '../src/chat/crm/shopify-query';
import {createCrmExecutors} from '../src/chat/crm/executors';
import {CrmError} from '../src/chat/crm/client';
import {CRM_TOOLS} from '../src/chat/tool-defs';
import allowlist from './fixtures/crm-shopify-allowlist-2026-10-26.json';
import {fakeShopifyDoor} from './support/fake-shopify-door';

const ALLOWED = {allowIdentity: true};
const verdict = (query: unknown, variables?: unknown) => readShopifyInput({query, ...(variables === undefined ? {} : {variables})}, ALLOWED);

// ---- the CRM ACCEPTS these (guard suite "legitimate queries pass") ----
const CRM_ACCEPTS: [string, string, unknown?][] = [
  ['orders with line items (sku), refunds and discount codes', `query Orders($after: String) {
      orders(first: 25, after: $after, query: "created_at:>=2026-09-01", sortKey: CREATED_AT, reverse: true) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id name createdAt displayFinancialStatus discountCodes
          totalPriceSet { shopMoney { amount currencyCode } }
          lineItems(first: 20) { nodes { sku quantity title discountedTotalSet { shopMoney { amount } } } }
          refunds { id createdAt totalRefundedSet { shopMoney { amount } } refundLineItems(first: 10) { nodes { quantity lineItem { sku } } } }
          discountApplications(first: 5) { nodes { allocationMethod ... on DiscountCodeApplication { code } } }
        }
      }
    }`, {after: null}],
  ['products, variants, inventory, collections and product metafields', `{ products(first: 10) { nodes { title collections(first: 5) { nodes { title } } metafield(namespace: "custom", key: "flavour") { value }
      variants(first: 10) { nodes { sku inventoryQuantity inventoryItem { inventoryLevels(first: 5) { nodes { location { name } quantities(names: ["available"]) { name quantity } } } } } } } } }`],
  ['customers with identity fields', '{ customers(first: 10, query: "orders_count:>1") { nodes { firstName lastName email phone numberOfOrders amountSpent { amount } emailMarketingConsent { marketingState } } } }'],
  ['discounts via fragments on concrete types', '{ discountNodes(first: 20) { nodes { id discount { __typename ... on DiscountCodeBasic { title asyncUsageCount codes(first: 5) { nodes { code asyncUsageCount } } } } } } }'],
  ['shop metafields and counts', '{ shop { leads: metafield(namespace: "custom", key: "newsletter_subscribers") { value } cfg: metafield(namespace: "custom", key: "membership_config") { value } } ordersCount { count } }'],
  ['the scope check shape', 'query { currentAppInstallation { accessScopes { handle } } }'],
  ['named fragments that are used, and @include/@skip', 'query($f: Boolean!) { orders(first: 5) { nodes { ...O } } } fragment O on Order { name email @include(if: $f) createdAt @skip(if: false) }', {f: true}],
  ['the word mutation inside strings, comments and field aliases', `# mutation { x }
    query { orders(first: 5, query: "tag:mutation subscription } mutation {") { nodes { mutation: name # mutation here
      subscription: id } } }`],
  ['an allowed field under a scary alias', '{ orders(first: 1) { nodes { note: name } } }'],
  ['a variable that only carries data', 'query($q: String) { orders(first: 1, query: $q) { nodes { name } } }', {q: 'mutation { x }'}],
  ['a page size from a default', 'query($n: Int = 5) { orders(first: $n) { nodes { name } } }'],
  ['reads shaped like the printed tree', '# a comment\n query   { orders(first:1){nodes{name}} }'],
];

// ---- the CRM REFUSES these, and our courtesy checks refuse them too ----
const WE_CATCH: [string, string][] = [
  ['a mutation', 'mutation { discountCodeBasicCreate(basicCodeDiscount: {}) { userErrors { message } } }'],
  ['a subscription', 'subscription { orders(first: 1) { nodes { name } } }'],
  ['a mutation that only selects allowed fields', 'mutation M { orders(first: 1) { nodes { name } } }'],
  ['batched operations', 'query A { shop { name } } mutation B { x }'],
  ['two queries', 'query A { shop { name } } query B { shop { name } }'],
  ['two anonymous operations', '{ shop { name } } { shop { id } }'],
  ['a type definition after the query', 'query { shop { name } } type Foo { a: Int }'],
  ['a schema extension', 'extend schema @foo'],
  ['a directive definition', 'query { shop { name } } directive @x on FIELD'],
  ['a mutation after a comment line', '{ shop { name } } # ok\nmutation { x }'],
  ['a mutation after the query', '{ shop { name } }\nmutation { discountCodeBasicCreate }'],
  ['a second operation after a query with a string', '{ orders(first: 1, query: "x") { nodes { name } } } mutation { y }'],
  ['introspection __schema', '{ __schema { types { name } } }'],
  ['introspection __type', '{ __type(name: "Order") { fields { name } } }'],
  ['aliased introspection', '{ s: __schema { queryType { name } } }'],
  ['nested introspection', '{ shop { __schema { x } } }'],
  ['a parse error', '{ shop { name '],
  ['an open query', 'query {'],
  ['crossed braces', '}{'],
  ['empty', ''],
  ['blank', '   '],
  ['only a comment', '# only a comment'],
  ['a Cyrillic letter in a name', '{ shop { nаme } }'],
  ['a zero-width space in a name', '{ sh​op { name } }'],
  ['a right-to-left override', '‮query { shop { name } }'],
  ['a Cyrillic o in "mutation"', 'mutatiоn { x }'],
  ['a NUL then a mutation', '{ shop { name } }\u0000mutation { x }'],
  ['a fullwidth letter in a field', '{ orders(first: 1) { nodes { nａme } } }'],
  ['a body over the size cap', '{ shop { name } }' + ' '.repeat(20_000)],
];

// ---- the CRM REFUSES these; our courtesy checks do not try (field allowlist, cost, depth, arguments, fragments): they go to the CRM, whose 400 reason comes back ----
const LEFT_TO_CRM: [string, string][] = [
  ['a mutation hidden in a fragment on Mutation', 'query { shop { name } } fragment F on Mutation { discountCodeBasicCreate }'],
  ['an unused fragment', 'query { shop { name } } fragment Unused on Order { name }'],
  ['a cyclic fragment', 'query { ...A } fragment A on Order { ...A }'],
  ['a custom directive', 'query { shop { name @custom } }'],
  ['a street address', '{ orders(first: 1) { nodes { shippingAddress { address1 } } } }'],
  ['an order note', '{ orders(first: 1) { nodes { note } } }'],
  ['a token field', '{ currentAppInstallation { accessToken } }'],
  ['a field on the wrong parent', '{ shop { sku } }'],
  ['a metafield outside the custom namespace', '{ shop { metafield(namespace: "app--123", key: "k") { value } } }'],
  ['a metafield with a secret-looking key', '{ shop { metafield(namespace: "custom", key: "api_token") { value } } }'],
  ['a page size over 100', '{ orders(first: 101) { nodes { name } } }'],
  ['no page size', '{ orders { nodes { name } } }'],
  ['a cost over the ceiling', '{ orders(first: 100) { nodes { lineItems(first: 100) { nodes { product { variants(first: 100) { nodes { sku } } } } } } } }'],
  ['an object argument', '{ orders(first: 1, query: {a: 1}) { nodes { name } } }'],
  ['an unknown argument', '{ orders(first: 1, savedSearchId: "1") { nodes { name } } }'],
  ['a leaf with a selection', '{ shop { name { x } } }'],
];

describe('the CRM accepts these: our courtesy checks never refuse them', () => {
  it.each(CRM_ACCEPTS)('%s', (_n, query, variables) => {
    const r = verdict(query, variables);
    expect('error' in r || isIdentityDenied(r), JSON.stringify(r)).toBe(false);
  });
  it('the alias case also passes for a user who may not see identity (no identity field is selected)', () => {
    for (const [name, query, variables] of CRM_ACCEPTS.filter(([n]) => /alias|scope check|mutation inside strings|variable that only|default|printed tree/.test(n))) {
      const r = readShopifyInput({query, ...(variables === undefined ? {} : {variables})}, {allowIdentity: false});
      expect('error' in r || isIdentityDenied(r), name).toBe(false);
    }
  });
});

describe('the CRM refuses these: we catch them before any request', () => {
  it.each(WE_CATCH)('%s', (_n, query) => {
    expect('error' in verdict(query)).toBe(true);
  });
});

describe('the CRM refuses these and our checks leave it to the CRM, whose reason reaches the model', () => {
  it.each(LEFT_TO_CRM)('%s', async (_n, query) => {
    expect('error' in verdict(query)).toBe(false); // passed on, not crashed
    const door = fakeShopifyDoor(() => new CrmError('upstream_error', 400, 'refused by the CRM guard (synthetic reason)'));
    const ex = createCrmExecutors({client: door.client, now: new Date('2026-10-07T04:00:00Z'), user: null, sink: {info: () => undefined, error: () => undefined}, keep: (r) => r, allowIdentity: true});
    expect(await ex.shopify_query({query})).toEqual({error: expect.stringContaining('refused by the CRM guard (synthetic reason)')});
    expect(door.posts).toHaveLength(1);
  });
});

describe('the field names in the tool description are the CRM allowlist', () => {
  const schema = allowlist.schema as Record<string, Record<string, string | null>>;
  const description = CRM_TOOLS.find((t) => t.name === 'shopify_query')!.description;
  const fieldsOf = (type: string): string[] => {
    const start = description.indexOf(`${type}: `);
    expect(start, `${type} is described`).toBeGreaterThanOrEqual(0);
    const rest = description.slice(start + type.length + 2);
    const end = rest.search(/\. [A-Z]/);
    let seg = rest.slice(0, end < 0 ? undefined : end);
    for (let i = 0; i < 4; i += 1) seg = seg.replace(/\([^()]*\)|\{[^{}]*\}/g, ' ');
    return seg.split(/[\s,]+/).filter((w) => /^[a-z][A-Za-z]+$/.test(w));
  };
  it.each([['QueryRoot', 'QueryRoot'], ['Order', 'Order'], ['LineItem', 'LineItem'], ['Refund', 'Refund'], ['Product', 'Product'], ['ProductVariant', 'ProductVariant'], ['InventoryItem', 'InventoryItem'], ['Collection', 'Collection'], ['DiscountNode', 'DiscountNode']])('every %s field named in the description exists on %s in the CRM allowlist', (type, node) => {
    const fields = fieldsOf(type);
    expect(fields.length).toBeGreaterThan(type === 'DiscountNode' ? 0 : 2);
    for (const f of fields) if (f !== 'discount' || type !== 'DiscountNode') expect(Object.keys(schema[node]), `${type}.${f}`).toContain(f);
  });
  it('no street address, note, token or payment field is named, and the allowlist itself has none either', () => {
    const forbidden = new RegExp(allowlist.forbiddenField, allowlist.forbiddenFlags);
    for (const [type, fields] of Object.entries(schema)) for (const f of Object.keys(fields)) expect(forbidden.test(f), `${type}.${f}`).toBe(false);
    expect(description).not.toMatch(/shippingAddress|billingAddress|noteAttributes|accessToken|paymentGatewayNames/);
  });
  it('the limits we repeat are the CRM limits: pages 1 to 100, body 20,000 bytes, query 10,000 characters, metafield namespace custom', async () => {
    const {SHOPIFY_LIMITS} = await import('../src/chat/crm/client');
    expect(allowlist.maxPage).toBe(100);
    expect(allowlist.metafieldNamespace).toBe('custom');
    expect(SHOPIFY_LIMITS.bodyBytes).toBe(allowlist.limits.bodyBytes);
    expect(SHOPIFY_LIMITS.queryChars).toBe(allowlist.limits.queryChars);
    expect(SHOPIFY_LIMITS.variablesBytes).toBe(allowlist.limits.variablesBytes);
    expect(description).toMatch(/1 to 100/);
    expect(description).toContain('namespace "custom"');
  });
});

describe('the door answers like the CRM route does', () => {
  it('a 200 envelope {data, errors, cost} is shaped; a 400 {error} carries the reason; both are what docs/api-shopify-query.md says', async () => {
    const okDoor = fakeShopifyDoor(() => ({data: {shop: {name: 'Zoomy'}}, errors: undefined, cost: {actualQueryCost: 2}}));
    const ex = createCrmExecutors({client: okDoor.client, now: new Date('2026-10-07T04:00:00Z'), user: null, sink: {info: () => undefined, error: () => undefined}, keep: (r) => r});
    expect(await ex.shopify_query({query: '{ shop { name } }'})).toMatchObject({rows: [{name: 'Zoomy'}]});
  });
});
