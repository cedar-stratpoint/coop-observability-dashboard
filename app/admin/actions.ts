'use server';

import {revalidatePath} from 'next/cache';
import {auth} from '@/auth';
import {COOP_VIEW_KEY, fetchMemberships, type CompanyRole} from '@/src/company';
import {countCoopAdmins, grantRoles, revoke, setStatus} from '@/src/admin-data';
import {guardEnv} from '@/src/coop-env-server';
import {PROD_CONFIRM_WORD, prodConfirmOk} from '@/src/coop-env';

// Role-management actions — the ONLY write surface for access. Every action
// re-derives the active view server-side and requires it to be the Coop Admin view
// (canManageRoles), never trusting the client. Lockout guards prevent removing the
// last Coop Admin or an admin suspending/revoking their own access.

export type AdminResult = {ok: true} | {ok: false; error: string};

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const GRANTABLE: CompanyRole[] = ['company_admin', 'coop_admin']; // v1 roles

async function requireCoopAdmin(): Promise<{actor: string} | {error: string}> {
  const session = await auth();
  const actor = session?.user?.email?.toLowerCase();
  if (!actor) return {error: 'Not authorized.'};
  // Authoritative: re-read the actor's roles from the DB, NOT the (possibly stale)
  // session token — so a just-revoked/suspended admin can't keep managing roles.
  // fetchMemberships drops suspended rows.
  const memberships = await fetchMemberships(actor);
  const stillCoopAdmin = memberships.some((m) => m.companyId === null && m.role === 'coop_admin');
  if (!stillCoopAdmin) return {error: 'Not authorized. You need an active Coop Admin role.'};
  return {actor};
}

/** 'coop_admin' sentinel → null company; otherwise a validated company slug. */
function parseCompany(companyKey: string): string | null | undefined {
  if (companyKey === COOP_VIEW_KEY) return null;
  return /^[a-z0-9_-]{1,64}$/.test(companyKey) ? companyKey : undefined; // undefined = invalid
}

export async function grantRoleAction(input: {email: string; companyKey: string; role: CompanyRole}): Promise<AdminResult> {
  const gate = await requireCoopAdmin();
  if ('error' in gate) return {ok: false, error: gate.error};

  const email = (input.email ?? '').trim().toLowerCase();
  if (!EMAIL.test(email)) return {ok: false, error: 'Enter a valid email address.'};
  if (!GRANTABLE.includes(input.role)) return {ok: false, error: 'Unknown role.'};

  const companyId = parseCompany(input.companyKey);
  if (companyId === undefined) return {ok: false, error: 'Unknown company.'};
  if (companyId === null && input.role !== 'coop_admin') return {ok: false, error: 'A company role needs a company.'};
  if (companyId !== null && input.role === 'coop_admin') return {ok: false, error: 'Coop Admin is cross-tenant, so leave the company blank.'};

  try {
    const {granted} = await grantRoles({actor: gate.actor, email, grants: [{companyId, role: input.role}]});
    // Existing access is never altered here (no silent role change or reactivation).
    if (!granted) return {ok: false, error: 'They already have this access.'};
    revalidatePath('/admin/users');
    return {ok: true};
  } catch (e) {
    console.error('grantRoleAction', e);
    return {ok: false, error: 'Could not grant the role. Please try again.'};
  }
}

/** Grant several roles to one email in one call (the console's "Invite person" with
 *  multiple roles ticked). Same gate and per-grant validation as grantRoleAction;
 *  every grant is validated before any is written, and the new rows go in one
 *  insert, so a bad entry or a failed write changes nothing. */
export async function grantRolesAction(input: {
  email: string;
  grants: Array<{companyKey: string; role: CompanyRole}>;
}): Promise<AdminResult> {
  const gate = await requireCoopAdmin();
  if ('error' in gate) return {ok: false, error: gate.error};

  const email = (input.email ?? '').trim().toLowerCase();
  if (!EMAIL.test(email)) return {ok: false, error: 'Enter a valid email address.'};
  const grants = Array.isArray(input.grants) ? input.grants.slice(0, 50) : [];
  if (!grants.length) return {ok: false, error: 'Pick at least one role.'};

  const parsed: Array<{companyId: string | null; role: CompanyRole}> = [];
  for (const g of grants) {
    if (!g || typeof g !== 'object' || typeof g.companyKey !== 'string') return {ok: false, error: 'Unknown company.'};
    if (!GRANTABLE.includes(g.role)) return {ok: false, error: 'Unknown role.'};
    const companyId = parseCompany(g.companyKey);
    if (companyId === undefined) return {ok: false, error: 'Unknown company.'};
    if (companyId === null && g.role !== 'coop_admin') return {ok: false, error: 'A company role needs a company.'};
    if (companyId !== null && g.role === 'coop_admin') return {ok: false, error: 'Coop Admin is cross-tenant, so leave the company blank.'};
    parsed.push({companyId, role: g.role});
  }

  try {
    // One insert for all new rows (all-or-nothing); access they already hold is skipped.
    const {granted} = await grantRoles({actor: gate.actor, email, grants: parsed});
    if (!granted) return {ok: false, error: 'They already have every role you picked.'};
    revalidatePath('/admin/users');
    return {ok: true};
  } catch (e) {
    console.error('grantRolesAction', e);
    return {ok: false, error: 'Could not grant these roles, so nothing was changed. Please try again.'};
  }
}

export async function setStatusAction(input: {email: string; companyKey: string; status: 'active' | 'suspended'; confirm?: string}): Promise<AdminResult> {
  const gate = await requireCoopAdmin();
  if ('error' in gate) return {ok: false, error: gate.error};
  // Production guard: suspending access there must be confirmed by typing the word.
  if (input.status === 'suspended' && !prodConfirmOk(guardEnv(), input.confirm)) {
    return {ok: false, error: `Type ${PROD_CONFIRM_WORD} to confirm this change in Production.`};
  }
  const email = (input.email ?? '').trim().toLowerCase();
  const companyId = parseCompany(input.companyKey);
  if (companyId === undefined) return {ok: false, error: 'Unknown company.'};

  if (companyId === null && input.status === 'suspended') {
    if (email === gate.actor) return {ok: false, error: "You can't suspend your own Coop Admin access."};
    if ((await countCoopAdmins()) <= 1) return {ok: false, error: 'At least one active Coop Admin must remain.'};
  }
  try {
    await setStatus({actor: gate.actor, email, companyId, status: input.status});
    revalidatePath('/admin/users');
    return {ok: true};
  } catch (e) {
    console.error('setStatusAction', e);
    return {ok: false, error: 'Could not update access. Please try again.'};
  }
}

export async function revokeAction(input: {email: string; companyKey: string; confirm?: string}): Promise<AdminResult> {
  const gate = await requireCoopAdmin();
  if ('error' in gate) return {ok: false, error: gate.error};
  // Production guard: removing access there must be confirmed by typing the word.
  if (!prodConfirmOk(guardEnv(), input.confirm)) {
    return {ok: false, error: `Type ${PROD_CONFIRM_WORD} to confirm this change in Production.`};
  }
  const email = (input.email ?? '').trim().toLowerCase();
  const companyId = parseCompany(input.companyKey);
  if (companyId === undefined) return {ok: false, error: 'Unknown company.'};

  if (companyId === null) {
    if (email === gate.actor) return {ok: false, error: "You can't revoke your own Coop Admin access."};
    if ((await countCoopAdmins()) <= 1) return {ok: false, error: 'At least one active Coop Admin must remain.'};
  }
  try {
    await revoke({actor: gate.actor, email, companyId});
    revalidatePath('/admin/users');
    return {ok: true};
  } catch (e) {
    console.error('revokeAction', e);
    return {ok: false, error: 'Could not revoke access. Please try again.'};
  }
}
