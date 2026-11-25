/** One spin-the-wheel booth lead, as the event card consumes it. */
export interface SpinLead {
  email: string | null; // null when the lead gave an Instagram handle instead
  instagram: string | null; // handle without the "@" (Sep 27 event onwards)
  name: string | null; // full name (late Oct 2026 events onwards)
  pet: string | null; // e.g. "Mimi / Puspin" (Sep 27 event onwards)
  picky: string | null; // "Yes" / "No": is the pet a picky eater (Oct 2026 events, until the full name replaced it)
  mobile: string | null;
  prize: string;
  campaign: string | null; // the storefront admin's event slug, e.g. "modern-market-sept2026"
  collectedAt: string; // ISO instant
  consentAt?: string | null; // when the FIRST sign-up of this contact gave consent (Shopify); never updated, so it says nothing about a later unsubscribe
}

/** Leads collected on any of an event's days (Manila). */
export function leadsInDays(leads: SpinLead[], days: string[], dayKey: (iso: string) => string): SpinLead[] {
  if (days.length === 0) return [];
  const set = new Set(days);
  return leads.filter((l) => set.has(dayKey(l.collectedAt)));
}

/** Prize tally, biggest first. */
export function prizeTally(leads: SpinLead[]): {prize: string; count: number}[] {
  const m = new Map<string, number>();
  for (const l of leads) m.set(l.prize, (m.get(l.prize) ?? 0) + 1);
  return [...m].map(([prize, count]) => ({prize, count})).sort((a, b) => b.count - a.count || a.prize.localeCompare(b.prize));
}

/**
 * Free-text lead search: name, email, Instagram handle, pet or mobile contain
 * the query (case-insensitive). A leading "@" is ignored so "@mimi" finds the
 * handle, and a number matches the mobile with spaces/dashes ignored.
 */
export function matchesLeadSearch(l: SpinLead, query: string): boolean {
  const q = query.trim().toLowerCase().replace(/^@/, '');
  if (!q) return true;
  if ([l.name, l.email, l.instagram, l.pet, l.mobile].some((v) => v?.toLowerCase().includes(q))) return true;
  const digits = q.replace(/\D/g, '');
  return digits.length >= 3 && digits.length === q.replace(/[\s()+-]/g, '').length && (l.mobile ?? '').replace(/\D/g, '').includes(digits);
}

/** A PH day key (YYYY-MM-DD) inside an inclusive From–To range; 'all' on either end leaves that side open. Keys compare as text. */
export function inDayRange(day: string, from: string, to: string): boolean {
  return (from === 'all' || day >= from) && (to === 'all' || day <= to);
}
