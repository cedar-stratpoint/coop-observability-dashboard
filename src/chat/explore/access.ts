// What Ask Coop may read, in TypeScript (spec 2.1; knowledge/best-practices/chat-direct-read-access.md section 3). Pure.
// The database is the lock (supabase/coop_chat_explore_direct.sql): tables open unless closed by name, views DEFAULT-DENY through
// coop_explore_admin.view_allowlist(). This file is the parser's copy of the same rule (layer 2), and test/chat-explore-denylist.test.ts
// fails when EXPLORE_VIEW_ALLOWLIST differs from the SQL list.
import {CATALOG_DATA} from '../catalog';
import {CHAT_RELATIONS, DIGEST_RELATIONS} from '../read/relations';
import {isClosedRelation, isSecretName} from './secret-names';
import {EXPLORE_VIEW_NAMES} from './views';

/** The views the login may read: the ten registry views, the Train 1 explore aliases, the two zoomy-pos read views and pos_orders_completed. = view_allowlist(). */
export const EXPLORE_VIEW_ALLOWLIST: readonly string[] = Object.freeze([
  ...Object.values(CHAT_RELATIONS.ro_role.tables), DIGEST_RELATIONS.ro_role, // coop_chat_* (supabase/coop_chat_readonly.sql + coop_chat_digest.sql)
  ...EXPLORE_VIEW_NAMES, // coop_explore_* (supabase/coop_chat_explore.sql)
  'pos_inventory', 'pos_inventory_by_location', // zoomy-pos read views
  'pos_orders_completed', // the Ask Coop default view (supabase/coop_chat_default_views.sql)
]);

/** Catalog domains with at least one open table: the list_tables enum (tool-defs.ts) and its runtime check (schema-tools.ts). */
export const EXPLORE_OPEN_DOMAINS: readonly string[] = Object.freeze(CATALOG_DATA.domains.filter((d) => d.tables.some((t) => !isClosedRelation(t))).map((d) => d.id));

/** Relations the app refuses although the database grants them. ONE line, easy to change. Empty: the drift log is readable (Task 4 review). */
export const EXPLORE_APP_CLOSED_RELATIONS: readonly string[] = [];

export type ClosedReason = 'tenant' | 'secret' | 'app';
export type RelationKind = 'table' | 'view';

/** Why a relation name is closed to Ask Coop, or null when it is not. */
export function closedReason(name: string): ClosedReason | null {
  if (EXPLORE_APP_CLOSED_RELATIONS.includes(name)) return 'app';
  if (!isClosedRelation(name)) return null;
  return isSecretName(name) ? 'secret' : 'tenant';
}

/**
 * The parser's relation rule. Without `kinds` (static): every name that is not closed (the database's view default-deny is the lock).
 * With `kinds` (the live list the login can see, from information_schema): a table must not be closed, a view must also be allowlisted,
 * and a name the login cannot see at all is refused before the database is asked.
 */
export function relationRule(kinds?: ReadonlyMap<string, RelationKind>): (name: string) => boolean {
  return (name) => {
    if (closedReason(name) !== null) return false;
    if (!kinds) return true;
    const kind = kinds.get(name);
    return kind === 'table' || (kind === 'view' && EXPLORE_VIEW_ALLOWLIST.includes(name));
  };
}

/** The describe_table refusal for a closed name: says it is closed and why, never anything about its contents. */
export function closedRelationMessage(name: string, reason: ClosedReason): string {
  if (reason === 'tenant') return `E_RELATION: ${name} is tenant-fenced (another company's data) and is not available to Ask Coop.`;
  if (reason === 'secret') return `E_RELATION: ${name} is not available to Ask Coop (its name marks it as secret: credentials or tokens).`;
  return `E_RELATION: ${name} is not available to Ask Coop.`;
}
