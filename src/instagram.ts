/**
 * The Instagram profile page for a handle someone typed ("@karla.sy" or "karla.sy"), or null when it is not a valid handle
 * (Instagram allows letters, digits, "." and "_", up to 30). Opening it is how the team contacts them: nothing is sent from Coop.
 */
export function instagramUrl(handle: string | null | undefined): string | null {
  const h = (handle ?? '').trim().replace(/^@/, '');
  return /^[A-Za-z0-9._]{1,30}$/.test(h) ? `https://www.instagram.com/${h.toLowerCase()}/` : null;
}
