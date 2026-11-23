/**
 * Saved customer cohorts (RET-10 Stage 9A, table customer_cohorts, DDL supabase/customer_cohorts.sql): a group + a name + a rule.
 * Customers get the label only by matching the rule (matchesCohort in src/crm-compute.ts); nobody tags a customer by hand and
 * members are never stored. Pure: the session and the database calls are injected, so the rules below are unit-tested
 * (test/customer-cohorts.test.ts) and the server actions (src/customer-cohorts-actions.ts) and the read seam
 * (src/customer-cohorts-data.ts) only wire them.
 *
 * The save path follows knowledge/best-practices/chat-proposed-writes.md: it is the ONE create path for the 9A builder and 9B's
 * Ask Coop "Save cohort" button. created_by comes from the session, never the payload; the label and rule are re-validated here;
 * a duplicate label (Postgres 23505) with the same rule and creator is "Already saved" (a double click or retry), anything else
 * is a clear error, never an overwrite. Only the creator edits or deletes.
 */
import {fetchAllRows, type MakePage} from './pos-fetch-paginate';
import {isMissingTable, type DbError} from './supabase-errors';
import {BIRTHDAY_COHORT, BUNDLE_COHORT, NO_CODE, codeCohorts, matchesCohort, readCohortRule, repeatRate, type CohortRow, type CohortRule, type EnrichedCustomer} from './crm-compute';

/** Characters; the table checks the same limits. */
export const COHORT_GROUP_MAX = 24;
export const COHORT_NAME_MAX = 48;

/** One saved cohort as the page reads it. */
export type CustomerCohort = {id: string; group: string; name: string; rule: CohortRule; createdBy: string; createdAt: string; updatedAt: string};
export type CohortLabel = {group: string; name: string};

/** `already`: the same cohort was saved before (same label, rule and creator), so nothing new was written. */
export type CohortResult = {ok: true; id: string; already?: true} | {ok: false; error: string};
export type CohortRowWrite = {group_name: string; name: string; rule: CohortRule; created_by: string};
export type CohortPatch = Omit<CohortRowWrite, 'created_by'>;

export interface CohortDeps {
  /** The signed-in user's lower-cased email, or null with no session. Never taken from the input. */
  actor: () => Promise<string | null>;
  insert: (row: CohortRowWrite) => Promise<{error: DbError | null; id: string | null}>;
  /** The saved cohort with this label (case-insensitive), to tell a retry from a clash after a 23505. */
  findByLabel: (label: CohortLabel) => Promise<{id: string; rule: CohortRule; createdBy: string} | null>;
  /** Updates the row with this id ONLY when created_by is `by`; returns how many rows changed. */
  updateOwn: (id: string, by: string, patch: CohortPatch) => Promise<{error: DbError | null; updated: number}>;
  /** Deletes the row with this id ONLY when created_by is `by`; returns how many rows went. */
  deleteOwn: (id: string, by: string) => Promise<{error: DbError | null; deleted: number}>;
}

/** How a cohort reads everywhere on the page: "Event · Circuit Makati". The key:value shape stays under the hood. */
export const cohortLabel = (c: CohortLabel): string => `${c.group} · ${c.name}`;

const NOT_SET_UP = "Cohorts aren't set up in this environment yet (supabase/customer_cohorts.sql has not been applied). Nothing was saved.";
const SIGN_IN = 'Please sign in again to save cohorts.';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
const fail = (error: string): CohortResult => ({ok: false, error});
const exists = (l: CohortLabel): string => `A cohort named ${cohortLabel(l)} already exists.`;
const isDuplicate = (e: DbError | null): boolean => e?.code === '23505';
const sameRule = (a: CohortRule, b: unknown): boolean => {
  const r = readCohortRule(b);
  return 'rule' in r && JSON.stringify(r.rule) === JSON.stringify(a);
};

function readPart(raw: unknown, what: 'group' | 'name', max: number): string | {error: string} {
  if (typeof raw !== 'string') return {error: `Give the cohort a ${what}.`};
  if (CONTROL.test(raw)) return {error: `The ${what} must be plain text.`};
  const v = raw.trim().replace(/\s+/g, ' ');
  if (!v) return {error: `Give the cohort a ${what}.`};
  if (v.length > max) return {error: `Keep the ${what} to ${max} characters.`};
  if (!/[\p{L}\p{N}]/u.test(v)) return {error: `The ${what} needs at least one letter or number.`};
  return v;
}

/** The label, checked in code: a group (≤ 24) and a name (≤ 48) in plain words, trimmed, inner spaces collapsed. */
export function readCohortLabel(input: unknown): CohortLabel | {error: string} {
  const o = (input !== null && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const group = readPart(o.group, 'group', COHORT_GROUP_MAX);
  if (typeof group !== 'string') return group;
  const name = readPart(o.name, 'name', COHORT_NAME_MAX);
  if (typeof name !== 'string') return name;
  return {group, name};
}

/** Label + rule, the whole input of Save cohort. */
export function readCohortInput(input: unknown): (CohortLabel & {rule: CohortRule}) | {error: string} {
  const label = readCohortLabel(input);
  if ('error' in label) return label;
  const r = readCohortRule((input as Record<string, unknown>).rule);
  if ('error' in r) return r;
  return {...label, rule: r.rule};
}

/** Case-insensitive (group, name) clash, as the table's unique index checks it. `exceptId` = the cohort being edited. */
export function labelTaken(existing: readonly ({id: string} & CohortLabel)[], l: CohortLabel, exceptId?: string): boolean {
  const k = (x: CohortLabel) => `${x.group.toLowerCase()}\u0000${x.name.toLowerCase()}`;
  return existing.some((c) => c.id !== exceptId && k(c) === k(l));
}

/** The cohorts one customer is in, by group then name. Live from the rules: nothing is assigned by hand. */
export function cohortsOf<C extends CohortLabel & {rule: CohortRule}>(row: CohortRow, cohorts: readonly C[]): C[] {
  return cohorts.filter((c) => matchesCohort(row, c.rule)).sort(compareCohorts);
}
export const compareCohorts = (a: CohortLabel, b: CohortLabel): number =>
  a.group.localeCompare(b.group, undefined, {sensitivity: 'base'}) || a.name.localeCompare(b.name, undefined, {sensitivity: 'base'});

function dbFail(e: DbError, verb: 'Saving' | 'Deleting'): CohortResult {
  if (isMissingTable(e)) return fail(verb === 'Saving' ? NOT_SET_UP : NOT_SET_UP.replace('Nothing was saved.', 'Nothing was deleted.'));
  console.warn(`customer_cohorts write failed: ${e.code ?? ''} ${e.message}`);
  return fail(`${verb} the cohort failed. Nothing was changed; try again.`);
}

/** Create (builder, and 9B's Ask Coop Save). Session → re-validate → insert with created_by → 23505 handled idempotently. */
export async function createCohortWith(deps: CohortDeps, input: unknown, origin: 'builder' | 'ask_coop' = 'builder'): Promise<CohortResult> {
  const by = await deps.actor();
  if (!by) return fail(SIGN_IN);
  const v = readCohortInput(input);
  if ('error' in v) return fail(v.error);
  const {error, id} = await deps.insert({group_name: v.group, name: v.name, rule: v.rule, created_by: by});
  if (isDuplicate(error)) {
    const prior = await deps.findByLabel(v);
    if (prior && prior.createdBy === by && sameRule(v.rule, prior.rule)) return {ok: true, id: prior.id, already: true};
    return fail(exists(v));
  }
  if (error) return dbFail(error, 'Saving');
  if (!id) return fail('Saving the cohort failed. Nothing was changed; try again.');
  // Audit line (chat-proposed-writes.md § 6): who and from where, never the rule's values.
  console.info(JSON.stringify({event: 'cohort_saved', id, by, origin}));
  return {ok: true, id};
}

/** Edit: creator only (filtered by id AND created_by in one statement), re-validated like a create. */
export async function updateCohortWith(deps: CohortDeps, id: unknown, input: unknown): Promise<CohortResult> {
  if (typeof id !== 'string' || !UUID.test(id)) return fail('That cohort could not be found.');
  const by = await deps.actor();
  if (!by) return fail(SIGN_IN);
  const v = readCohortInput(input);
  if ('error' in v) return fail(v.error);
  const {error, updated} = await deps.updateOwn(id, by, {group_name: v.group, name: v.name, rule: v.rule});
  if (isDuplicate(error)) return fail(exists(v));
  if (error) return dbFail(error, 'Saving');
  return updated > 0 ? {ok: true, id} : fail('You can only edit a cohort you saved (or it was deleted).');
}

/** Delete-own: another person's cohort matches nothing and stays. */
export async function deleteCohortWith(deps: CohortDeps, id: unknown): Promise<CohortResult> {
  if (typeof id !== 'string' || !UUID.test(id)) return fail('That cohort could not be found.');
  const by = await deps.actor();
  if (!by) return fail(SIGN_IN);
  const {error, deleted} = await deps.deleteOwn(id, by);
  if (error) return dbFail(error, 'Deleting');
  return deleted > 0 ? {ok: true, id} : fail('You can only delete a cohort you saved (or it is already gone).');
}

/**
 * Every saved cohort, paged (PostgREST caps a response at 1000 rows). Each stored rule is re-checked with readCohortRule; one that
 * no longer validates is left out (and logged), never evaluated. Null when the table is not applied or the read failed: the page
 * then says cohorts are "unavailable", and the built-ins still work.
 */
export async function loadCohortRows(makePage: MakePage): Promise<CustomerCohort[] | null> {
  let lastError: DbError | null = null;
  try {
    const rows = await fetchAllRows('customer_cohorts', async (from, to) => {
      const r = await makePage(from, to);
      if (r.error) lastError = r.error;
      return r;
    });
    const out: CustomerCohort[] = [];
    for (const r of rows) {
      const rule = readCohortRule(r.rule);
      if ('error' in rule) {
        console.warn(`customer_cohorts ${String(r.id)}: stored rule skipped (${rule.error})`);
        continue;
      }
      out.push({
        id: String(r.id),
        group: String(r.group_name ?? ''),
        name: String(r.name ?? ''),
        rule: rule.rule,
        createdBy: String(r.created_by ?? ''),
        createdAt: String(r.created_at ?? ''),
        updatedAt: String(r.updated_at ?? ''),
      });
    }
    return out;
  } catch (e) {
    if (!isMissingTable(lastError)) console.warn(`customer_cohorts read failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/* ---------- RET-10 Stage 9B: what a draft shows, shared by the Website CRM page and Ask Coop (knowledge/best-practices/chat-proposed-writes.md) ---------- */

/** Code's preview of a draft: members now, buyers and repeat buyers (repeatRate), and a few FIRST names (never a last name or email). */
export type CohortPreview = {customers: number; buyers: number; repeat: number; ratePct: number | null; names: string[]};
export const PREVIEW_NAMES = 5;

/** The preview, with THE evaluator (matchesCohort) over the same rows the page lists, so the page and Ask Coop cannot disagree. */
export function cohortPreview(rows: readonly (CohortRow & {firstName?: string | null})[], rule: CohortRule): CohortPreview {
  const members = rows.filter((r) => matchesCohort(r, rule));
  const {buyers, repeat, ratePct} = repeatRate(members.map((r) => r.orderCount));
  const names: string[] = [];
  for (const m of members) {
    const n = (m.firstName ?? '').trim().replace(/\s+/g, ' ');
    if (n && names.length < PREVIEW_NAMES) names.push(n.slice(0, 40));
  }
  return {customers: members.length, buyers, repeat, ratePct, names};
}

/** True when the rule reads last contacted or times contacted: those need every contact source read, or they match nobody. */
export const ruleUsesContact = (rule: CohortRule): boolean => rule.all.some((c) => c.f === 'lcdays' || c.f === 'times');

export type CohortDraftInput = CohortLabel & {rule: CohortRule};
export type CohortSuggestion = {code: string; buyers: number; repeat: number; ratePct: number; small: boolean; draft: CohortDraftInput};

const SUGGEST_NAME: Readonly<Record<string, string>> = Object.freeze({[BIRTHDAY_COHORT]: 'Birthday voucher', [BUNDLE_COHORT]: 'Bundle code'});

/**
 * RET-06 → RET-10 suggestions: first-order codes with buyers (codeCohorts, biggest first) that no saved cohort covers yet ("code is X" in
 * its rule, any case). "no code" is never a suggestion. Each comes as a ready draft: group Promo, name = the code. Which code was which
 * event is the owner's to say, so the group stays Promo until they rename it.
 */
export function cohortSuggestions(rows: readonly Pick<EnrichedCustomer, 'orderCount' | 'firstOrderCode'>[], saved: readonly {rule: CohortRule}[]): CohortSuggestion[] {
  const covered = new Set(saved.flatMap((c) => c.rule.all.filter((k) => k.f === 'code' && k.op === 'is').map((k) => String(k.v).toUpperCase())));
  return codeCohorts(rows)
    .filter((c) => c.group !== NO_CODE && !covered.has(c.group.toUpperCase()))
    .map((c) => ({
      code: c.group,
      buyers: c.buyers,
      repeat: c.repeat,
      ratePct: c.ratePct,
      small: c.small,
      draft: {group: 'Promo', name: (SUGGEST_NAME[c.group] ?? c.group).slice(0, COHORT_NAME_MAX), rule: {all: [{f: 'code', op: 'is', v: c.group.toUpperCase()}]}},
    }));
}

const fold = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * A saved cohort by what the owner (or the model) typed: "Event · Circuit Makati", "event: circuit makati", even the under-the-hood
 * "event:circuit-makati" (punctuation and case ignored). The name alone works when exactly one cohort has it. Null when unknown.
 */
export function findCohort<C extends CohortLabel>(saved: readonly C[], text: string): C | null {
  const q = fold(text);
  if (!q) return null;
  const full = saved.find((c) => fold(`${c.group} ${c.name}`) === q);
  if (full) return full;
  const byName = saved.filter((c) => fold(c.name) === q);
  return byName.length === 1 ? byName[0] : null;
}
