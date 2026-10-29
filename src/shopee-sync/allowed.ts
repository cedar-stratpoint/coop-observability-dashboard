/** ALLOWED_EMAILS (comma separated). Empty or unset means any signed-in account, as everywhere else in the app. */
export function emailAllowed(email: string, allowed: string | undefined): boolean {
  const list = (allowed ?? '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
  return list.length === 0 || list.includes(email.trim().toLowerCase());
}
