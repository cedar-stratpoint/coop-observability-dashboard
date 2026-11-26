/**
 * PawSport holders (RET-18 P1, plan knowledge/tasks/2026-11-25-pawsport-data-in-coop.md, D1 to D3). Pure: the Shopify read is
 * injected (src/pawsport-data.ts wires the CRM's read-only /api/shopify/query door), so the rules below are unit-tested
 * (test/pawsport.test.ts).
 *
 * A PawSport lives on the Shopify customer: the metafield custom.pet_passport holds JSON {number: "ZMY26-XXXX-XXXX", issuedAt,
 * pet: {name, type, ...}}, and the tags say how they joined (pawsport-qr = the printed QR, join-now = the /pawsport form, neither
 * = My Account). D2: a holder is a customer whose metafield carries a number; the tag pet-passport-2026 is the fallback, so a
 * tagged customer whose metafield is missing or unreadable is still a holder, with number null. Unknown is never "none".
 */
import {emailKey, phoneKey} from './contacts-merge';
import {samePerson, type Person} from './person-identity';

export const PAWSPORT_TAG = 'pet-passport-2026';
export type PawsportRoute = 'qr' | 'form' | 'account';

export type PawsportHolder = {
  shopifyCustomerId: string;
  /** emailKey (lower case), null when Shopify has none. */
  email: string | null;
  /** phoneKey (last 10 digits, the RET-17 mobile key), null when Shopify has none. */
  phone: string | null;
  number: string | null;
  issuedAt: string | null;
  pet: {name: string | null; type: string | null};
  route: PawsportRoute;
};

/** What the browser gets per matched person: the passport, never the holder's email or phone. */
export type PawsportBadge = Pick<PawsportHolder, 'number' | 'issuedAt' | 'pet' | 'route'>;

export type PawsportRead = {
  status: 'ok' | 'unavailable';
  holders: PawsportHolder[];
  warnings: string[];
  /** True when the page cap was hit: the holders found are real, but someone without a match may still hold one (unknown, never "none"). */
  incomplete?: boolean;
};

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

/** One Shopify customer node → a holder, or null when they are not one. Never throws: an unreadable metafield is a warning. */
export function parsePawsportNode(node: unknown): {holder: PawsportHolder | null; warning?: string} {
  if (node === null || typeof node !== 'object') return {holder: null, warning: 'A Shopify customer row was not an object.'};
  const n = node as Record<string, unknown>;
  const id = str(n.id);
  if (!id) return {holder: null, warning: 'A Shopify customer row had no id.'};
  const tags = Array.isArray(n.tags) ? n.tags.filter((t): t is string => typeof t === 'string').map((t) => t.trim().toLowerCase()) : [];
  const raw = str((n.passport as {value?: unknown} | null | undefined)?.value);
  let passport: Record<string, unknown> | null = null;
  let warning: string | undefined;
  if (raw) {
    try {
      const p: unknown = JSON.parse(raw);
      if (p !== null && typeof p === 'object' && !Array.isArray(p)) passport = p as Record<string, unknown>;
      else warning = `PawSport metafield of ${id} is not a JSON object.`;
    } catch {
      warning = `PawSport metafield of ${id} is not valid JSON.`;
    }
  }
  const number = str(passport?.number);
  if (!number && !tags.includes(PAWSPORT_TAG)) return {holder: null, ...(warning ? {warning} : {})};
  const pet = (passport?.pet !== null && typeof passport?.pet === 'object' ? passport.pet : {}) as Record<string, unknown>;
  const issued = str(passport?.issuedAt);
  return {
    holder: {
      shopifyCustomerId: id,
      email: emailKey(str(n.email)),
      phone: phoneKey(str(n.phone)),
      number,
      issuedAt: issued && Number.isFinite(Date.parse(issued)) ? issued : null,
      pet: {name: str(pet.name), type: str(pet.type)},
      route: tags.includes('pawsport-qr') ? 'qr' : tags.includes('join-now') ? 'form' : 'account',
    },
    ...(warning ? {warning} : {}),
  };
}

/**
 * The one query: EVERY customer, 100 a page (the CRM door's cap), classified by parsePawsportNode. No tag search: D2 makes the
 * metafield the source and the tag only a fallback, so a holder whose tag is missing must still be found (~209 customers on PROD
 * = 3 pages).
 */
export const PAWSPORT_QUERY = `query PawsportHolders($after: String) {
  customers(first: 100, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes { id email phone tags passport: metafield(namespace: "custom", key: "pet_passport") { value } }
  }
}`;
export const PAWSPORT_MAX_PAGES = 10;

/** Posts one GraphQL page and returns the parsed JSON body ({data, errors}); throws on any transport failure. */
export type PostShopify = (body: {query: string; variables: Record<string, unknown>}) => Promise<unknown>;

/**
 * Walks all customers page by page. Throws when Shopify answers with errors or an unexpected shape (the seam turns that
 * into 'unavailable', never an empty "ok"). Hitting the page cap returns what was read with `incomplete`.
 */
export async function loadPawsportHolders(post: PostShopify, maxPages = PAWSPORT_MAX_PAGES): Promise<PawsportRead> {
  const holders: PawsportHolder[] = [];
  const warnings: string[] = [];
  let after: string | null = null;
  for (let page = 0; page < maxPages; page += 1) {
    const body = (await post({query: PAWSPORT_QUERY, variables: {after}})) as {data?: {customers?: {pageInfo?: {hasNextPage?: unknown; endCursor?: unknown}; nodes?: unknown}}; errors?: unknown} | null;
    if (Array.isArray(body?.errors) && body.errors.length > 0) throw new Error('Shopify answered with errors');
    const conn = body?.data?.customers;
    if (!conn || !Array.isArray(conn.nodes)) throw new Error('Shopify answer had no customers list');
    for (const node of conn.nodes) {
      const r = parsePawsportNode(node);
      if (r.holder) holders.push(r.holder);
      if (r.warning) warnings.push(r.warning);
    }
    if (conn.pageInfo?.hasNextPage !== true) return {status: 'ok', holders, warnings};
    const next = str(conn.pageInfo.endCursor);
    // More pages but no cursor to reach them: what was read is real, the rest is unknown (never a clean, complete "none").
    if (!next) return {status: 'ok', holders, warnings: [...warnings, 'Shopify said there are more customers but gave no cursor: the PawSport list may be incomplete.'], incomplete: true};
    after = next;
  }
  return {status: 'ok', holders, warnings: [...warnings, `Stopped after ${maxPages} pages: the PawSport list may be incomplete.`], incomplete: true};
}

const badgeOf = (h: PawsportHolder): PawsportBadge => ({number: h.number, issuedAt: h.issuedAt, pet: h.pet, route: h.route});
const holderPerson = (h: PawsportHolder): Person => ({email: h.email, instagram: null, mobile: h.phone});

/**
 * A matcher over the holders: the same Shopify customer id first, then the same email, then the same mobile (RET-17 samePerson,
 * so one household phone with two different emails is not joined). Indexed, so a few thousand people stay cheap.
 */
export function pawsportMatcher(holders: readonly PawsportHolder[]) {
  const byId = new Map<string, PawsportHolder>();
  const byEmail = new Map<string, PawsportHolder>();
  const byPhone = new Map<string, PawsportHolder[]>();
  for (const h of holders) {
    byId.set(h.shopifyCustomerId, h);
    if (h.email && !byEmail.has(h.email)) byEmail.set(h.email, h);
    if (h.phone) byPhone.set(h.phone, [...(byPhone.get(h.phone) ?? []), h]);
  }
  return (p: Person & {shopifyCustomerId?: string | null}): PawsportBadge | null => {
    const byShopify = p.shopifyCustomerId ? (byId.get(p.shopifyCustomerId) ?? byId.get(`gid://shopify/Customer/${p.shopifyCustomerId}`)) : undefined;
    if (byShopify) return badgeOf(byShopify);
    const email = emailKey(p.email);
    const e = email ? byEmail.get(email) : undefined;
    if (e) return badgeOf(e);
    const phone = phoneKey(p.mobile);
    const m = phone ? (byPhone.get(phone) ?? []).find((h) => samePerson(p, holderPerson(h), [])) : undefined;
    return m ? badgeOf(m) : null;
  };
}

/** The Website CRM "PawSport" filter: has one, has none, or (offered only on a cut-off list) the customers not checked. */
export type PawsportFilter = 'all' | 'has' | 'none' | 'unknown';
export type PawsportState = 'has' | 'none' | 'unknown';
export function pawsportState(badge: PawsportBadge | null | undefined, read: {status: PawsportRead['status']; incomplete?: boolean}): PawsportState {
  if (read.status !== 'ok') return 'unknown';
  if (badge) return 'has';
  return read.incomplete ? 'unknown' : 'none';
}
/** Unknown matches neither "has" nor "none" (unknown is never "never"); only the "unknown" choice lists it. */
export const matchesPawsportFilter = (f: PawsportFilter, s: PawsportState): boolean => f === 'all' || f === s;

export const ROUTE_LABEL: Readonly<Record<PawsportRoute, string>> = Object.freeze({qr: 'QR', form: 'Form', account: 'Account'});
export const petText = (pet: PawsportBadge['pet']): string | null => (pet.name ? (pet.type ? `${pet.name} (${pet.type})` : pet.name) : pet.type);
const shortDay = (iso: string): string => new Intl.DateTimeFormat('en-US', {month: 'short', day: 'numeric', timeZone: 'Asia/Manila'}).format(new Date(iso));

/** The profile line: "PawSport ZMY26-… · Mimi (cat) · joined via QR, Nov 12". */
export function pawsportLine(b: PawsportBadge): string {
  const joined = `joined via ${ROUTE_LABEL[b.route]}${b.issuedAt ? `, ${shortDay(b.issuedAt)}` : ''}`;
  return [`PawSport ${b.number ?? '(no number)'}`, petText(b.pet), joined].filter(Boolean).join(' · ');
}
