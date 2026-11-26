// RET-18 P1: PawSport holders from the Shopify customer metafield + tags, matched to CRM customers and event leads.
import {describe, expect, it} from 'vitest';
import {PAWSPORT_QUERY, PAWSPORT_SEARCH, loadPawsportHolders, matchesPawsportFilter, parsePawsportNode, pawsportLine, pawsportMatcher, pawsportState, type PawsportHolder} from '../src/pawsport';

const passport = (o: object) => ({value: JSON.stringify(o)});
const node = (o: Record<string, unknown>) => ({id: 'gid://shopify/Customer/1', email: 'Mia@Example.com ', phone: '+63 917 123 4567', tags: ['pet-passport-2026', 'pawsport-qr'], passport: passport({number: 'ZMY26-AB12-CD34', issuedAt: '2026-11-12T03:00:00Z', pet: {name: 'Mimi', type: 'cat', furparent: 'Mia'}}), ...o});

describe('parsePawsportNode', () => {
  it('reads the metafield, normalizes email and mobile, and takes the route from tags', () => {
    expect(parsePawsportNode(node({})).holder).toEqual({
      shopifyCustomerId: 'gid://shopify/Customer/1',
      email: 'mia@example.com',
      phone: '9171234567',
      number: 'ZMY26-AB12-CD34',
      issuedAt: '2026-11-12T03:00:00Z',
      pet: {name: 'Mimi', type: 'cat'},
      route: 'qr',
    });
  });
  it('join-now = form, neither tag = account', () => {
    expect(parsePawsportNode(node({tags: ['pet-passport-2026', 'join-now']})).holder?.route).toBe('form');
    expect(parsePawsportNode(node({tags: ['pet-passport-2026']})).holder?.route).toBe('account');
  });
  it('bad JSON with the tag: a holder with nulls and a warning, never a throw', () => {
    const r = parsePawsportNode(node({passport: {value: '{not json'}}));
    expect(r.holder).toMatchObject({number: null, issuedAt: null, pet: {name: null, type: null}, route: 'qr'});
    expect(r.warning).toMatch(/not valid JSON/);
  });
  it('no metafield but tagged: a holder without a number (D2 fallback)', () => {
    expect(parsePawsportNode(node({passport: null})).holder).toMatchObject({number: null});
  });
  it('a number without the tag is still a holder; neither = not a holder', () => {
    expect(parsePawsportNode(node({tags: []})).holder?.number).toBe('ZMY26-AB12-CD34');
    expect(parsePawsportNode(node({tags: [], passport: passport({pet: {name: 'x'}})})).holder).toBeNull();
  });
  it('junk rows never throw', () => {
    expect(parsePawsportNode(null).holder).toBeNull();
    expect(parsePawsportNode({tags: 'x'}).holder).toBeNull();
    expect(parsePawsportNode(node({passport: {value: '[1]'}, issuedAt: 'x'})).warning).toMatch(/not a JSON object/);
    expect(parsePawsportNode(node({passport: passport({number: 'N', issuedAt: 'yesterday', pet: 'cat'})})).holder).toMatchObject({number: 'N', issuedAt: null, pet: {name: null, type: null}});
  });
});

describe('loadPawsportHolders', () => {
  const page = (nodes: unknown[], next: string | null) => ({data: {customers: {pageInfo: {hasNextPage: next !== null, endCursor: next}, nodes}}});
  it('walks pages with the cursor and the tag search in variables', async () => {
    const calls: unknown[] = [];
    const pages = [page([node({})], 'c1'), page([node({id: 'gid://shopify/Customer/2', email: 'leo@example.com', phone: null})], null)];
    const r = await loadPawsportHolders(async (b) => (calls.push(b), pages.shift()));
    expect(r).toMatchObject({status: 'ok', warnings: []});
    expect(r.holders.map((h) => h.shopifyCustomerId)).toEqual(['gid://shopify/Customer/1', 'gid://shopify/Customer/2']);
    expect(calls).toEqual([
      {query: PAWSPORT_QUERY, variables: {after: null, q: PAWSPORT_SEARCH}},
      {query: PAWSPORT_QUERY, variables: {after: 'c1', q: PAWSPORT_SEARCH}},
    ]);
    expect(PAWSPORT_QUERY).not.toContain('\\'); // the CRM guard refuses backslashes in a search
  });
  it('GraphQL errors or a missing list throw (the seam reports unavailable, never an empty ok)', async () => {
    await expect(loadPawsportHolders(async () => ({errors: [{message: 'denied'}], data: null}))).rejects.toThrow();
    await expect(loadPawsportHolders(async () => ({data: {}}))).rejects.toThrow();
  });
  it('the page cap marks the result incomplete', async () => {
    const r = await loadPawsportHolders(async () => page([node({})], 'more'), 2);
    expect(r.incomplete).toBe(true);
    expect(r.holders).toHaveLength(2);
  });
});

describe('pawsportMatcher', () => {
  const h = (o: Partial<PawsportHolder>): PawsportHolder => ({shopifyCustomerId: 'gid://shopify/Customer/1', email: 'mia@example.com', phone: '9171234567', number: 'N1', issuedAt: null, pet: {name: null, type: null}, route: 'qr', ...o});
  const match = pawsportMatcher([h({}), h({shopifyCustomerId: 'gid://shopify/Customer/2', email: 'leo@example.com', phone: '9181112222', number: 'N2'})]);
  it('by Shopify id (numeric or gid), then email, then mobile', () => {
    expect(match({shopifyCustomerId: '2', email: null, instagram: null, mobile: null})?.number).toBe('N2');
    expect(match({email: 'MIA@example.com', instagram: null, mobile: null})?.number).toBe('N1');
    expect(match({email: null, instagram: null, mobile: '0918 111 2222'})?.number).toBe('N2');
  });
  it('one phone, two different emails = two people (RET-17 samePerson)', () => {
    expect(match({email: 'someone@else.com', instagram: null, mobile: '09171234567'})).toBeNull();
  });
  it('the badge never carries the holder email or phone', () => {
    expect(Object.keys(match({email: 'mia@example.com', instagram: null, mobile: null})!).sort()).toEqual(['issuedAt', 'number', 'pet', 'route']);
  });
});

describe('pawsportState / filter / line', () => {
  const b = {number: 'ZMY26-AB12-CD34', issuedAt: '2026-11-12T03:00:00Z', pet: {name: 'Mimi', type: 'cat'}, route: 'qr' as const};
  it('unavailable or incomplete is unknown, never none', () => {
    expect(pawsportState(null, {status: 'unavailable'})).toBe('unknown');
    expect(pawsportState(null, {status: 'ok', incomplete: true})).toBe('unknown');
    expect(pawsportState(b, {status: 'ok', incomplete: true})).toBe('has');
    expect(pawsportState(undefined, {status: 'ok'})).toBe('none');
    expect(matchesPawsportFilter('none', 'unknown')).toBe(false);
    expect(matchesPawsportFilter('all', 'unknown')).toBe(true);
  });
  it('profile line', () => {
    expect(pawsportLine(b)).toBe('PawSport ZMY26-AB12-CD34 · Mimi (cat) · joined via QR, Nov 12');
    expect(pawsportLine({...b, number: null, issuedAt: null, pet: {name: null, type: null}, route: 'account'})).toBe('PawSport (no number) · joined via Account');
  });
});
