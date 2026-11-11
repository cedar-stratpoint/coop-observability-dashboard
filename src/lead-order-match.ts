/**
 * Spin-the-wheel lead → the POS order they paid for, inferred from timestamps.
 *
 * The wheel (storefront admin) and the till (POS) never share an id, so the
 * only link is time: a booth visitor pays and spins within a couple of minutes
 * of each other, in either order. Checked against the orders where the cashier
 * typed the pet's name or a prize note (2026-09-28, Sep 18–27 events): 18 of
 * 19 "confident" matches were right; "unsure" ones were a coin flip.
 *
 * Read-only and computed on the fly — nothing here writes a link anywhere.
 * Pure, so it can be tested without a network.
 */
import type {PosOrder} from './pos-sales-types';
import type {SpinLead} from './spin-leads-types';
import {manilaDayKey} from './pos-sales-compute';

/** Minutes either side of the spin an order may sit and still be a candidate. */
const WINDOW = 5;
/** Minutes a contradiction (wrong species, wrong prize) costs a pairing. */
const PENALTY = 3;
/** How far (in cost-minutes) the pick must beat the runner-up to be confident. */
const MARGIN = 2;

export interface LeadMatch {
  orderId: string;
  orderAt: string; // ISO
  total: number;
  products: string[]; // what they bought, bundle headers dropped, "Freeze-Dried " trimmed
  minutes: number; // lead minus order: positive = spun after paying
  confidence: 'confident' | 'unsure';
}

/** Stable key for a lead (the table has no id the app reads). */
export const leadKey = (l: SpinLead) => `${l.email ?? `@${l.instagram}`}|${l.collectedAt}`;

// Breed text → species, for leads from Sep 24 on (they carry "Name / Breed").
const CAT = /\bcats?\b|persian|puspin|shorthair|siamese|ragdoll|bengal|maine coon|scottish|munchkin|himalayan|sphynx|exotic/i;
const species = (l: SpinLead) => (l.pet ? (CAT.test(l.pet) ? 'cat' : 'dog') : null);
/** The same guess, for display: it comes from the typed breed text, so it is an estimate and null when no pet was typed. */
export const estimatedSpecies = species;

/** What the till says this order won: the prize table, or a cashier note. */
function wonAtTill(o: PosOrder, prizeOrders: Set<string>): string | null {
  const note = `${o.customer_handle ?? ''} ${o.remarks ?? ''}`;
  if (/bandana/i.test(note)) return 'Zoomy! Bandana';
  if (/poop/i.test(note)) return 'Poop Bag';
  if (prizeOrders.has(o.client_uuid) || /free|spin|winner/i.test(note)) return 'Free Zoomy! Item';
  return null;
}

const minutesOf = (iso: string) => new Date(iso).getTime() / 60_000;

/**
 * Match every lead to at most one order, and every order to at most one lead.
 *
 * Each lead–order pair within the window gets a cost: the minutes between them,
 * plus a penalty per contradiction (the lead's cat vs a dog-tagged order; a
 * free-item order vs a lead who won a discount). Pairs are then taken cheapest
 * first. A match is confident only when no other order came close for that lead.
 *
 * @param prizeOrders client_uuids of orders carrying a won prize
 */
export function matchLeadsToOrders(leads: SpinLead[], orders: PosOrder[], prizeOrders: Set<string>): Record<string, LeadMatch> {
  const live = orders.filter((o) => o.status === 'completed');
  type Pair = {lead: SpinLead; order: PosOrder; minutes: number; cost: number};
  const pairs: Pair[] = [];
  for (const lead of leads) {
    const at = minutesOf(lead.collectedAt);
    const day = manilaDayKey(lead.collectedAt);
    const kind = species(lead);
    for (const order of live) {
      const minutes = at - minutesOf(order.created_at);
      if (Math.abs(minutes) > WINDOW || manilaDayKey(order.created_at) !== day) continue;
      const won = wonAtTill(order, prizeOrders);
      const clashes =
        Number(Boolean(kind && (order.pet_type === 'cat' || order.pet_type === 'dog') && order.pet_type !== kind)) +
        Number(Boolean(won && won !== lead.prize));
      pairs.push({lead, order, minutes, cost: Math.abs(minutes) + PENALTY * clashes});
    }
  }
  // ponytail: greedy cheapest-first, not an optimal assignment; fine at booth
  // volumes (a few hundred pairs), revisit if two tills run one event.
  pairs.sort((a, b) => a.cost - b.cost);

  const picked = new Map<SpinLead, Pair>();
  const taken = new Set<string>();
  for (const p of pairs) {
    if (picked.has(p.lead) || taken.has(p.order.id)) continue;
    picked.set(p.lead, p);
    taken.add(p.order.id);
  }

  const out: Record<string, LeadMatch> = {};
  for (const [lead, p] of picked) {
    const runnerUp = pairs.find((q) => q.lead === lead && q.order !== p.order);
    out[leadKey(lead)] = {
      orderId: p.order.id,
      orderAt: p.order.created_at,
      total: p.order.total,
      products: [...new Set(p.order.items.filter((i) => i.product_id).map((i) => i.name.replace(/^Freeze-Dried\s+/i, '')))],
      minutes: Math.round(p.minutes * 10) / 10,
      confidence: !runnerUp || runnerUp.cost - p.cost >= MARGIN ? 'confident' : 'unsure',
    };
  }
  return out;
}

/** "Mimi / Puspin" → "Mimi"; no pet on record → "your furbaby". */
export function petName(l: SpinLead): string {
  const name = (l.pet ?? '').split('/')[0].trim();
  return name ? name[0].toUpperCase() + name.slice(1) : 'your furbaby';
}

/** Every item, read as a list: "A", "A and B", "A, B and C". */
export function treatPhrase(products: string[]): string {
  if (products.length <= 1) return products[0] ?? 'treats';
  return `${products.slice(0, -1).join(', ')} and ${products[products.length - 1]}`;
}

/** Day after the spin: a thank-you. Day 5: they've likely run out — the website promo. */
export const FOLLOW_UP_DAYS = {thanks: 1, promo: 5} as const;
export type FollowUpStage = keyof typeof FOLLOW_UP_DAYS;

export function followUpMessage(stage: FollowUpStage, l: SpinLead, m: LeadMatch): string {
  const pet = petName(l);
  const treats = treatPhrase(m.products);
  return stage === 'thanks'
    ? `Hi! This is Syl and Andrei, hope ${pet} enjoyed the ${treats}!!`
    : `Hi! ${pet} might have finished the ${treats}. Actually, we have a 35% off promo on our website zoomyforpets.com — 35% off your first order. Maybe ${pet} would like some :)`;
}

/** "2026-09-24" + 5 → "2026-09-29" (calendar days, Manila keys). */
export function addDays(dayKey: string, n: number): string {
  const d = new Date(`${dayKey}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
