// The ONE secret-name rule for Ask Coop direct reads (spec 1.3; knowledge/best-practices/chat-direct-read-access.md section 3).
// Pure, no imports. The SQL copy lives in supabase/coop_chat_explore_direct.sql (schema coop_explore_admin); the test
// test/chat-explore-secret-names.test.ts fails when the two differ. A secret is a WHOLE word part (split on anything that is not
// a-z0-9), so shipping_fee and pinned stay readable while api_key and refresh_token do not. Glued names (apikey) escape it on
// purpose: the value scanner (scrub.ts) and the one-time column review cover them. JSON keys use isSecretJsonKey (below), which also
// splits camelCase, knows the glued forms and the credential header words (EXPLORE_JSON_SECRET_PARTS).
export const EXPLORE_SECRET_PARTS = ['password', 'token', 'secret', 'key', 'pin', 'hash', 'credential'] as const;
/** The tenant fence: Ask Coop is Zoomy-only (owner decision 2026-10-07). */
export const EXPLORE_TENANT_PREFIXES = ['gl_', 'company_'] as const;
export const EXPLORE_TENANT_TABLES = ['companies'] as const;
/** Reviewed `table.column` names that look secret but are not. Any addition is a reviewed diff (the test pins the list). */
export const EXPLORE_SECRET_COLUMN_EXCEPTIONS = ['pos_settings.key'] as const;

const FORMS: ReadonlySet<string> = new Set(EXPLORE_SECRET_PARTS.flatMap((p) => [p, `${p}s`, `${p}es`]));

export const nameParts = (name: string): string[] => name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

export const isSecretName = (name: string): boolean => nameParts(name).some((w) => FORMS.has(w));

/**
 * Secret names written as ONE glued word (no part boundary to find). Not secret as SQL columns (the column review covers those),
 * but secret as JSON keys and query-string names, where nothing else would catch a short value. A reviewed list, matched whole.
 */
export const EXPLORE_GLUED_SECRET_NAMES = [
  'apikey', 'accesstoken', 'authtoken', 'refreshtoken', 'idtoken', 'clientsecret', 'appsecret', 'secretkey', 'privatekey',
  'passwd', 'pwd', 'passcode', 'sig', 'sign', 'signature', 'proxyauthorization', 'setcookie',
] as const;
const GLUED: ReadonlySet<string> = new Set(EXPLORE_GLUED_SECRET_NAMES);

/**
 * Credential words that are secret as JSON keys and query-string names ONLY (Task 7 re-review round 2 N3: request headers stored as
 * jsonb, headers.Authorization / Cookie). Whole parts with plurals, like the seven; never part of the SQL column rule or its SQL copy.
 */
export const EXPLORE_JSON_SECRET_PARTS = ['authorization', 'cookie', 'bearer', 'passphrase', 'jwt', 'otp', 'cvv', 'cvc'] as const;
const JSON_FORMS: ReadonlySet<string> = new Set([...EXPLORE_SECRET_PARTS, ...EXPLORE_JSON_SECRET_PARTS].flatMap((p) => [p, `${p}s`, `${p}es`]));

/**
 * The JSON-key rule (Task 7 re-review R1). Unlike SQL identifiers, JSON keys keep their case, so a camelCase or PascalCase boundary is a
 * part boundary: accessToken -> access, token; APIKey -> api, key; so is a letter-digit one (token2 -> token, 2). Then the same whole-part rule as columns (monkey, isPinned and
 * keyword stay readable), plus the glued list. For JSON keys only: the SQL column rule above stays as it is (and equal to its SQL copy).
 */
export const jsonKeyParts = (key: string): string[] =>
  nameParts(key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/([A-Z])([A-Z][a-z])/g, '$1_$2').replace(/(?<=[A-Za-z])(?=\d)|(?<=\d)(?=[A-Za-z])/g, '_'));

export const isSecretJsonKey = (key: string): boolean =>
  isSecretName(key) || nameParts(key).some((w) => JSON_FORMS.has(w)) || jsonKeyParts(key).some((w) => JSON_FORMS.has(w)) || GLUED.has(key.toLowerCase().replace(/[^a-z0-9]/g, ''));

const isTenantTable = (name: string): boolean => {
  const n = name.toLowerCase();
  return (EXPLORE_TENANT_TABLES as readonly string[]).includes(n) || EXPLORE_TENANT_PREFIXES.some((p) => n.startsWith(p));
};

/** A table or view the login must never read: a secret name or another company's table. */
export const isClosedRelation = (name: string): boolean => isSecretName(name) || isTenantTable(name);

export const isSecretColumn = (table: string, column: string): boolean =>
  isSecretName(column) && !(EXPLORE_SECRET_COLUMN_EXCEPTIONS as readonly string[]).includes(`${table.toLowerCase()}.${column.toLowerCase()}`);
