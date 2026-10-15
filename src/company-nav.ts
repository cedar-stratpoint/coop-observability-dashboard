// Pure nav/guard helper — free of React and I/O so the critical "a non-Zoomy viewer
// never sees Zoomy data / chrome" invariant is unit-testable and can't silently
// drift. Shared by the server guard (requireZoomyData) and the client shell.

/**
 * Whether a resolved context should be bounced OFF a Zoomy-only page (the legacy
 * Overview/Health/Inventory/… pages read Zoomy data with no company dimension, so a
 * non-Zoomy viewer would see Zoomy's data). Signed-out / no-membership (null ctx) is
 * left to the normal auth flow; Zoomy passes; everyone else — a Goldline user, or the
 * data-blind Coop Admin whose companyId is null — is redirected to their own home.
 */
export function shouldRedirectFromZoomy(ctx: {companyId: string | null} | null): boolean {
  return ctx !== null && ctx.companyId !== 'zoomy';
}

/** A view's home page: the data-blind Coop Admin → the role console; Zoomy → its own
 *  Overview ("/"); any other company → the company Overview. Used when bouncing off a
 *  page the view can't use, and when switching views (so you never stay on the
 *  previous view's page). */
export function homeFor(ctx: {isCoopAdmin: boolean; companyId?: string | null} | null): string {
  if (ctx?.isCoopAdmin) return '/admin/users';
  if (ctx?.companyId === 'zoomy') return '/';
  return '/overview';
}
