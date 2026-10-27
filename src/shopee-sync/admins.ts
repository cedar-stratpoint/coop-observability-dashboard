// Who may sign in to Shopee on the cloud worker and is told when it needs them: SHOPEE_SYNC_ADMINS, a comma-separated email list (server-only env).
// Unset or empty means nobody, which is the safe default for a person who can reach the live Seller Centre session.
export const parseAdmins = (env: string | undefined): string[] => (env ?? '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
export const isSyncAdmin = (email: string, env: string | undefined): boolean => parseAdmins(env).includes(email.trim().toLowerCase());
