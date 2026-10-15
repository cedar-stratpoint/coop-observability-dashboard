import 'server-only';
import {createClient, type SupabaseClient} from '@supabase/supabase-js';
import {fetchAllRows} from './pos-fetch-paginate';
import type {CompanyRole, MembershipStatus} from './company';
import {currentEnv} from './coop-env-server';

// Coop Admin role-management data layer (server-only). Reads/writes company_users +
// companies with the service-role key and writes company_user_audit on every change.
// Authorization (coop_admin-only) is enforced by the callers in app/admin/actions.ts;
// this module assumes a vetted actor and focuses on correct, audited writes. Emails
// are expected already lowercased by the caller. A coop_admin membership has a NULL
// company_id (Postgres treats NULLs as distinct in the unique index, so those rows
// are matched with `.is('company_id', null)`, never upsert-on-conflict).

const url = process.env.SUPABASE_URL_ARCHIVE;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY_ARCHIVE;

function configured(): boolean {
  return Boolean(url && key);
}
function db(): SupabaseClient {
  if (!configured()) throw new Error('Admin storage is not configured (SUPABASE_URL_ARCHIVE).');
  return createClient(url as string, key as string, {auth: {persistSession: false}});
}

export type AdminMembership = {companyId: string | null; companyName: string; role: CompanyRole; status: MembershipStatus};
export type AdminUser = {email: string; memberships: AdminMembership[]};
export type AdminCompany = {id: string; name: string};

/** All companies, for the grant form's company picker. */
export async function listCompanies(): Promise<AdminCompany[]> {
  if (!configured()) return [];
  const supa = db();
  const rows = await fetchAllRows('companies', (from, to) =>
    supa.from('companies').select('id,name').order('id', {ascending: true}).range(from, to),
  );
  return rows as unknown as AdminCompany[];
}

/** Every user grouped by email with all their memberships (incl. suspended/invited). */
export async function listUsers(): Promise<AdminUser[]> {
  if (!configured()) return [];
  const supa = db();
  const rows = (await fetchAllRows('company_users', (from, to) =>
    supa.from('company_users').select('id,user_email,company_id,role,status').order('id', {ascending: true}).range(from, to),
  )) as unknown as Array<{user_email: string; company_id: string | null; role: CompanyRole; status: MembershipStatus | null}>;
  const companies = await listCompanies();
  const nameOf = new Map(companies.map((c) => [c.id, c.name]));

  const byEmail = new Map<string, AdminUser>();
  for (const r of rows) {
    const u = byEmail.get(r.user_email) ?? {email: r.user_email, memberships: []};
    u.memberships.push({
      companyId: r.company_id,
      companyName: r.company_id ? (nameOf.get(r.company_id) ?? r.company_id) : 'Coop Admin',
      role: r.role,
      status: r.status ?? 'active',
    });
    byEmail.set(r.user_email, u);
  }
  return [...byEmail.values()].sort((a, b) => a.email.localeCompare(b.email));
}

/** Active Coop Admins (status active, companyId null) — for the last-admin lockout guard. */
export async function countCoopAdmins(): Promise<number> {
  const supa = db();
  const res = await supa
    .from('company_users') // pagination-ok: count-only head request, returns no rows
    .select('id', {count: 'exact', head: true})
    .is('company_id', null)
    .eq('role', 'coop_admin')
    .eq('status', 'active');
  if (res.error) throw new Error(`countCoopAdmins failed: ${res.error.message}`);
  return res.count ?? 0;
}

async function findMembership(
  supa: SupabaseClient,
  email: string,
  companyId: string | null,
): Promise<{role: CompanyRole; status: MembershipStatus} | null> {
  const base = supa.from('company_users').select('role,status').eq('user_email', email); // pagination-ok: single membership via maybeSingle
  const res = await (companyId === null ? base.is('company_id', null) : base.eq('company_id', companyId)).maybeSingle();
  if (res.error) throw new Error(`membership read failed: ${res.error.message}`);
  return (res.data as {role: CompanyRole; status: MembershipStatus} | null) ?? null;
}

// Best-effort: the mutation has already committed by the time we audit, so an audit
// hiccup must NOT make the caller report a failure (and retry an applied change). We
// log loudly instead — the gap is a missing audit row, not a wrong-status report.
async function audit(input: {
  actor: string;
  email: string;
  companyId: string | null;
  action: string;
  oldRole?: CompanyRole | null;
  newRole?: CompanyRole | null;
}): Promise<void> {
  try {
    const row = {
      actor_email: input.actor,
      target_email: input.email,
      company_id: input.companyId,
      action: input.action,
      old_role: input.oldRole ?? null,
      new_role: input.newRole ?? null,
    };
    // Which environment the change was made in. Where the `env` column isn't there yet
    // (prod before company_user_audit_env.sql), fall back to the old row — never lose
    // the audit entry over it.
    const env = await currentEnv().then((e) => e.key).catch(() => null);
    let res = await db().from('company_user_audit').insert({...row, env});
    if (res.error && /\benv\b/.test(res.error.message ?? '')) res = await db().from('company_user_audit').insert(row);
    if (res.error) console.error('company_user_audit write failed', input.action, input.email, res.error.message);
  } catch (e) {
    console.error('company_user_audit write threw', input.action, input.email, e);
  }
}

/**
 * Add one or more memberships for one email. Audited per grant.
 * - Access the person already holds is SKIPPED, never altered: a grant can't
 *   silently change a role or reactivate a suspended membership (Suspend/Reactivate
 *   are their own explicit actions).
 * - Every new row gets the same status, decided once up front: `active` if the
 *   person already has an active membership (they've signed in), else `invited`
 *   (flipped to active on their first Google sign-in).
 * - New rows go in one insert statement, so it's all-or-nothing.
 */
export async function grantRoles(input: {
  actor: string;
  email: string;
  grants: Array<{companyId: string | null; role: CompanyRole}>;
}): Promise<{granted: number; skipped: number}> {
  const supa = db();
  // pagination-ok: one person's memberships, bounded by the number of companies.
  const cur = await supa.from('company_users').select('company_id,status').eq('user_email', input.email);
  if (cur.error) throw new Error(`user lookup failed: ${cur.error.message}`);
  const rows = (cur.data ?? []) as Array<{company_id: string | null; status: MembershipStatus | null}>;
  const held = new Set(rows.map((r) => r.company_id ?? ''));
  const status: MembershipStatus = rows.some((r) => (r.status ?? 'active') === 'active') ? 'active' : 'invited';

  const fresh: Array<{companyId: string | null; role: CompanyRole}> = [];
  for (const g of input.grants) {
    const k = g.companyId ?? '';
    if (held.has(k)) continue;
    held.add(k); // also dedupes repeats within this call
    fresh.push(g);
  }
  if (fresh.length) {
    const ins = await supa
      .from('company_users')
      .insert(fresh.map((g) => ({company_id: g.companyId, user_email: input.email, role: g.role, status})));
    if (ins.error) throw new Error(`grant failed: ${ins.error.message}`);
    for (const g of fresh) {
      await audit({actor: input.actor, email: input.email, companyId: g.companyId, action: 'grant', oldRole: null, newRole: g.role});
    }
  }
  return {granted: fresh.length, skipped: input.grants.length - fresh.length};
}

/** Suspend or reactivate a membership. Audited. */
export async function setStatus(input: {actor: string; email: string; companyId: string | null; status: 'active' | 'suspended'}): Promise<void> {
  const supa = db();
  const up = supa.from('company_users').update({status: input.status}).eq('user_email', input.email);
  const res = await (input.companyId === null ? up.is('company_id', null) : up.eq('company_id', input.companyId));
  if (res.error) throw new Error(`status update failed: ${res.error.message}`);
  await audit({actor: input.actor, email: input.email, companyId: input.companyId, action: input.status === 'suspended' ? 'suspend' : 'reactivate'});
}

/** Remove a membership entirely. Audited. */
export async function revoke(input: {actor: string; email: string; companyId: string | null}): Promise<void> {
  const supa = db();
  const existing = await findMembership(supa, input.email, input.companyId);
  const del = supa.from('company_users').delete().eq('user_email', input.email);
  const res = await (input.companyId === null ? del.is('company_id', null) : del.eq('company_id', input.companyId));
  if (res.error) throw new Error(`revoke failed: ${res.error.message}`);
  await audit({actor: input.actor, email: input.email, companyId: input.companyId, action: 'revoke', oldRole: existing?.role ?? null, newRole: null});
}
