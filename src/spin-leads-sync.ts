/**
 * Which spin-the-wheel leads in Shopify are not in spin_wheel_leads yet, as
 * rows ready to insert. Feeds the "Update" button on /customers/leads, which
 * replaces the CSV export + scripts/import-spin-leads.mjs round trip.
 *
 * A lead is new when its CONTACT (email, or Instagram handle) is not in the
 * table. Contact alone is enough: the storefront refuses a second spin from
 * the same email or handle. The table's own key, (contact, collected_at),
 * could not be used here: rows imported from CSV carry minute-rounded times,
 * Shopify carries seconds, so every existing lead would look new.
 *
 * Pure, so it can be tested without a network.
 */

/** One lead as the CRM worker's GET /api/spin-leads returns it. */
export interface RemoteSpinLead {
  contact: string; // email, or "@handle"
  phone: string | null;
  pet: string | null;
  picky: string | null;
  prize: string | null; // storefront prize id
  campaign: string | null;
  subscribedAt: string | null;
  consentAt: string | null;
}

/** A public.spin_wheel_leads insert. */
export interface SpinLeadInsert {
  email: string | null;
  instagram: string | null;
  pet: string | null;
  picky: string | null;
  mobile: string | null;
  prize: string;
  campaign: string | null;
  collected_at: string;
  consent_at: string | null;
}

/**
 * Storefront prize id → the label the table already uses (the CSV export wrote
 * labels). Ids are the storefront's (app/components/SpinWin.jsx, plus its
 * retired ones in app/routes/admin.spin-wheel.jsx).
 * ponytail: a copy of the storefront's list; a brand-new prize shows its raw id
 * until it is added here.
 */
export const PRIZE_LABEL: Record<string, string> = {
  peso300: '₱300 Off',
  'poop-bag': 'Poop Bag',
  bandana: 'Zoomy! Bandana',
  'toy-collar': 'Zoomy! Toy or Collar',
  'free-item': 'Free Zoomy! Item',
  voucher30: '30% Off',
  voucher35: '35% Off',
  'free-ship': 'Free Shipping',
};

/** "@KylRvr" → {instagram: "kylrvr"}; "A@x.com" → {email: "A@x.com"}; junk → null. Same rules as the CSV import. */
export function splitContact(contact: string): {email: string | null; instagram: string | null} | null {
  const c = contact.trim();
  if (c.startsWith('@')) return c.length > 1 ? {email: null, instagram: c.slice(1).toLowerCase()} : null;
  if (c.includes('@')) return {email: c, instagram: null};
  return null;
}

/**
 * @param remote every lead Shopify holds
 * @param existing the contacts already in the table
 */
export function newSpinLeadRows(
  remote: RemoteSpinLead[],
  existing: {email: string | null; instagram: string | null}[],
): SpinLeadInsert[] {
  const known = new Set<string>();
  for (const e of existing) {
    if (e.email) known.add(`e:${e.email.toLowerCase()}`);
    if (e.instagram) known.add(`i:${e.instagram.toLowerCase()}`);
  }
  const rows: SpinLeadInsert[] = [];
  for (const r of remote) {
    const who = splitContact(r.contact);
    // The spin itself is the consent; signup time is kept from a contact's
    // FIRST signup, so for a returning subscriber it predates the event.
    const collectedAt = r.consentAt ?? r.subscribedAt;
    if (!who || !collectedAt) continue;
    const key = who.email ? `e:${who.email.toLowerCase()}` : `i:${who.instagram}`;
    if (known.has(key)) continue;
    known.add(key); // a contact listed twice in Shopify is still one lead
    rows.push({
      ...who,
      pet: r.pet,
      picky: r.picky,
      mobile: r.phone,
      prize: (r.prize && PRIZE_LABEL[r.prize]) || r.prize || 'Unknown',
      campaign: r.campaign,
      collected_at: collectedAt,
      consent_at: r.consentAt,
    });
  }
  return rows;
}
