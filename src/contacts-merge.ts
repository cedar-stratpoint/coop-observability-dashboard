/**
 * One contact list out of three.
 *
 * The website CRM, the booth leads and the Lazada export describe overlapping
 * people in incompatible ways: the CRM knows an email (and sometimes a phone),
 * a booth lead knows an email and usually a mobile, and a Lazada buyer has
 * **no email at all** — the export never carries one, so a phone number is the
 * only identity it has. Merging on email alone would therefore keep every
 * marketplace buyer permanently separate from their website account.
 *
 * So a person is matched on EITHER key: normalised email or normalised mobile.
 * Two records that share either one are the same person, and a record that
 * bridges two groups (a booth lead carrying the website's email and the
 * marketplace's phone) joins them — which is why this is a union-find rather
 * than a single-pass group-by.
 *
 * Everything here is pure, so the merge can be tested without a network.
 */
import type {EnrichedCustomer} from './crm-compute';
import type {LazadaCustomer} from './lazada-types';
import type {SpinLead} from './spin-leads-types';

export type ContactSource = 'website' | 'booth' | 'lazada';

export type UnifiedContact = {
  /** Stable within a render — the first identity key the person was seen under. */
  id: string;
  name: string | null;
  email: string | null;
  mobile: string | null;
  city: string | null;
  /** Which lists this person appears in, in a stable order. */
  sources: ContactSource[];
  /** Orders across every source that counts them (website + Lazada). */
  orders: number;
  /** Spend across every source that carries money, in pesos. */
  spend: number;
  /** Membership tier, when the website knows one. */
  tier: string | null;
  /** The booth prize they won, when they came through the wheel. */
  prize: string | null;
  /** Which booth event they were met at. */
  campaign: string | null;
  /** Most recent evidence of them anywhere: an order, or a booth signup. */
  lastSeen: string | null;
  /** Every distinct pet text on record: the website's pet name, and each booth lead's "Name / Breed". */
  pets: string[];
  /** Every distinct booth campaign (event slug) they signed up at. */
  campaigns: string[];
  /** Every distinct name, email and mobile as written in the records (the fields above show one of each), so a person can be found by any. */
  names: string[];
  emails: string[];
  mobiles: string[];
};

/**
 * Compare-key for an email: lowercased and trimmed. Anything without an `@` is
 * not an identity, just noise, and returns null.
 */
export function emailKey(raw: string | null | undefined): string | null {
  const text = String(raw ?? '').trim().toLowerCase();
  return text.includes('@') ? text : null;
}

/**
 * Compare-key for a Philippine mobile: the last 10 digits.
 *
 * The same number reaches us as `09171234567`, `+639171234567`, `639171234567`
 * and `9171234567` depending on which system typed it. Taking the last 10
 * digits collapses all four onto `9171234567`. Shorter strings are landlines or
 * junk and are not treated as an identity.
 */
export function phoneKey(raw: string | null | undefined): string | null {
  const digits = String(raw ?? '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : null;
}

/** A record as it enters the merge, before people are joined up. */
type Incoming = {
  source: ContactSource;
  name?: string | null;
  email?: string | null;
  mobile?: string | null;
  city?: string | null;
  orders?: number;
  spend?: number;
  tier?: string | null;
  prize?: string | null;
  campaign?: string | null;
  pet?: string | null;
  lastSeen?: string | null;
};

const SOURCE_ORDER: ContactSource[] = ['website', 'booth', 'lazada'];

/** The non-empty values once each, in the order first seen. */
const distinct = (values: (string | null | undefined)[]): string[] => [...new Set(values.filter((v): v is string => !!v && v.trim() !== ''))];

/** Most recent of two ISO instants, either of which may be missing. */
function later(a: string | null, b: string | null | undefined): string | null {
  if (!b) return a;
  if (!a) return b;
  return b > a ? b : a;
}

/**
 * Collapse the three lists into one person per row.
 *
 * @param crm website customers, already enriched with their order stats
 * @param leads spin-the-wheel booth signups
 * @param lazada marketplace buyers, rolled up by phone
 */
export function mergeContacts(
  crm: EnrichedCustomer[] = [],
  leads: SpinLead[] = [],
  lazada: LazadaCustomer[] = [],
): UnifiedContact[] {
  const incoming: Incoming[] = [
    ...crm.map((c) => ({
      source: 'website' as const,
      name: [c.firstName, c.lastName].filter(Boolean).join(' ') || null,
      email: c.email,
      mobile: c.phone,
      orders: c.orderCount,
      spend: c.spent,
      tier: c.membershipTier,
      pet: c.petName,
      // An account with no orders still counts as a contact; its last activity
      // is when the record itself last changed.
      lastSeen: c.updatedAt ?? c.createdAt ?? null,
    })),
    ...leads.map((l) => ({
      source: 'booth' as const,
      // A handle-only lead has no email or phone to merge on, so it stands alone;
      // the handle is at least something to show as its headline.
      // ponytail: handle isn't an identity key; add one if the same handle spins at several events.
      name: l.instagram ? `@${l.instagram}` : null,
      email: l.email,
      mobile: l.mobile,
      prize: l.prize,
      campaign: l.campaign,
      pet: l.pet,
      lastSeen: l.collectedAt,
    })),
    ...lazada.map((c) => ({
      source: 'lazada' as const,
      name: c.name,
      mobile: c.phone,
      city: c.city,
      orders: c.orderCount,
      spend: c.totalSpent,
      lastSeen: c.lastOrderAt,
    })),
  ];

  // Union-find over the two identity keys.
  const parent = new Map<number, number>();
  const find = (i: number): number => {
    let root = i;
    while (parent.get(root) !== root) root = parent.get(root) ?? root;
    // Path compression, so a long chain of merges stays cheap to resolve.
    let walk = i;
    while (parent.get(walk) !== root) {
      const next = parent.get(walk) ?? root;
      parent.set(walk, root);
      walk = next;
    }
    return root;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(rb, ra);
  };

  const byEmail = new Map<string, number>();
  const byPhone = new Map<string, number>();
  incoming.forEach((rec, i) => {
    parent.set(i, i);
    const ek = emailKey(rec.email);
    const pk = phoneKey(rec.mobile);
    if (ek) {
      const seen = byEmail.get(ek);
      if (seen === undefined) byEmail.set(ek, i);
      else union(seen, i);
    }
    if (pk) {
      const seen = byPhone.get(pk);
      if (seen === undefined) byPhone.set(pk, i);
      else union(seen, i);
    }
  });

  const groups = new Map<number, Incoming[]>();
  incoming.forEach((rec, i) => {
    const root = find(i);
    const bucket = groups.get(root);
    if (bucket) bucket.push(rec);
    else groups.set(root, [rec]);
  });

  const out: UnifiedContact[] = [];
  for (const [root, records] of groups) {
    const sources = SOURCE_ORDER.filter((s) => records.some((r) => r.source === s));
    // Field precedence follows how trustworthy each list is for that field: the
    // website knows names and tiers, Lazada knows the shipping city, and any
    // list can supply the contact details.
    const pick = <K extends keyof Incoming>(key: K, order: ContactSource[]): Incoming[K] | null => {
      for (const src of order) {
        const hit = records.find((r) => r.source === src && r[key] != null && r[key] !== '');
        if (hit) return hit[key];
      }
      return null;
    };

    out.push({
      id: String(root),
      name: (pick('name', ['website', 'lazada', 'booth']) as string | null) ?? null,
      email: (pick('email', ['website', 'booth', 'lazada']) as string | null) ?? null,
      mobile: (pick('mobile', ['booth', 'lazada', 'website']) as string | null) ?? null,
      city: (pick('city', ['lazada', 'website', 'booth']) as string | null) ?? null,
      sources,
      orders: records.reduce((n, r) => n + (r.orders ?? 0), 0),
      spend: Math.round(records.reduce((n, r) => n + (r.spend ?? 0), 0) * 100) / 100,
      tier: (pick('tier', ['website']) as string | null) ?? null,
      prize: (pick('prize', ['booth']) as string | null) ?? null,
      campaign: (pick('campaign', ['booth']) as string | null) ?? null,
      lastSeen: records.reduce<string | null>((acc, r) => later(acc, r.lastSeen), null),
      pets: distinct(records.map((r) => r.pet)),
      campaigns: distinct(records.map((r) => r.campaign)),
      names: distinct(records.map((r) => r.name)),
      emails: distinct(records.map((r) => r.email)),
      mobiles: distinct(records.map((r) => r.mobile)),
    });
  }

  // Most recently seen first: the people worth contacting are at the top.
  out.sort((a, b) => String(b.lastSeen ?? '').localeCompare(String(a.lastSeen ?? '')));
  return out;
}

export type ContactTotals = {
  contacts: number;
  withEmail: number;
  withMobile: number;
  /** People who appear in more than one list — the cross-channel customers. */
  multiSource: number;
  bySource: Record<ContactSource, number>;
};

export function contactTotals(contacts: UnifiedContact[]): ContactTotals {
  return contacts.reduce<ContactTotals>(
    (acc, c) => {
      acc.contacts += 1;
      if (c.email) acc.withEmail += 1;
      if (c.mobile) acc.withMobile += 1;
      if (c.sources.length > 1) acc.multiSource += 1;
      for (const s of c.sources) acc.bySource[s] += 1;
      return acc;
    },
    {contacts: 0, withEmail: 0, withMobile: 0, multiSource: 0, bySource: {website: 0, booth: 0, lazada: 0}},
  );
}

export type ContactFilter = {source: string; reachable: string};
export const EMPTY_CONTACT_FILTER: ContactFilter = {source: 'all', reachable: 'all'};

export function filterContacts(
  contacts: UnifiedContact[],
  f: ContactFilter,
  needle: string,
): UnifiedContact[] {
  const q = needle.trim().toLowerCase();
  return contacts.filter((c) => {
    if (f.source === 'multi' ? c.sources.length < 2 : f.source !== 'all' && !c.sources.includes(f.source as ContactSource)) {
      return false;
    }
    if (f.reachable === 'email' && !c.email) return false;
    if (f.reachable === 'mobile' && !c.mobile) return false;
    if (f.reachable === 'both' && !(c.email && c.mobile)) return false;
    if (!q) return true;
    return [c.name, c.email, c.mobile, c.city, c.campaign].some((v) =>
      String(v ?? '').toLowerCase().includes(q),
    );
  });
}
