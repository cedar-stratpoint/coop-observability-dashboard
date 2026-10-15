'use client';

import {useEffect, useMemo, useRef, useState, useTransition} from 'react';
import {useRouter} from 'next/navigation';
import {Menu} from '@base-ui/react/menu';
import {Check, ChevronDown, Loader2, Plus, Search, ShieldCheck, UserPlus, X} from 'lucide-react';
import type {AdminCompany, AdminMembership, AdminUser} from '@/src/admin-data';
import type {CompanyRole} from '@/src/company';
import {grantRoleAction, grantRolesAction, revokeAction, setStatusAction} from '@/app/admin/actions';
import {PROD_CONFIRM_WORD} from '@/src/coop-env';
import {Card, CardContent} from '@/components/ui/card';
import {Button} from '@/components/ui/button';
import {NativeSelect} from '@/components/ui/native-select';
import {cn} from '@/lib/utils';
import {companyHue} from '@/src/view-switcher';

// Coop Admin "Users & Roles" console — the only write surface for access. People
// first: one row per person, their access as chips. Adding a role happens on the
// person's own row ("+ Add access" lists only what they don't have), so no email is
// ever re-typed. Each chip's menu suspends / reactivates / removes that one access,
// and removal asks for an inline confirmation. Every action re-checks Coop Admin
// and the self / last-admin guards on the server; the hints here are UI only.
// Data-blind: shows who has what, never business data.

const COOP_KEY = 'coop_admin';

const ROLE_LABEL: Record<string, string> = {
  coop_admin: 'Coop Admin',
  company_admin: 'Company User',
  analyst: 'Analyst',
  store_manager: 'Store Manager',
};

type Status = AdminMembership['status'];
type AccessOption = {companyKey: string; role: CompanyRole; company: string | null; label: string};

const keyOf = (m: AdminMembership) => m.companyId ?? COOP_KEY;
const roleText = (m: AdminMembership) => ROLE_LABEL[m.role] ?? m.role;
const accessLabel = (m: AdminMembership) => (m.companyId ? `${m.companyName} · ${roleText(m)}` : 'Coop Admin');

function initials(email: string): string {
  const parts = email.split('@')[0].split(/[._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? parts[0]?.[1] ?? '')).toUpperCase() || '?';
}

const MENU_POPUP =
  'z-50 min-w-56 origin-[var(--transform-origin)] rounded-lg border bg-popover p-1 text-popover-foreground shadow-md outline-none transition-[opacity,transform] duration-150 ease-out data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0';
const MENU_ITEM =
  'flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none select-none data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50 data-[highlighted]:bg-muted';

// Each company's chips carry the same hue as its badge in the header view switcher
// (src/view-switcher.ts companyHue), so a company reads the same everywhere. Coop
// Admin is a neutral tint with a shield. Status is shown only when it's the exception
// (invited / suspended); "active" is the unmarked default so it doesn't fight the hue.
const hueVars = (companyId: string) => ({['--hue' as string]: companyHue(companyId)});
const COMPANY_TONE =
  'border-[oklch(0.62_0.12_var(--hue)/0.4)] bg-[oklch(0.62_0.12_var(--hue)/0.12)] text-[oklch(0.42_0.11_var(--hue))] ' +
  'hover:border-[oklch(0.62_0.12_var(--hue)/0.7)] hover:bg-[oklch(0.62_0.12_var(--hue)/0.2)] ' +
  'data-[popup-open]:border-[oklch(0.62_0.12_var(--hue)/0.7)] data-[popup-open]:bg-[oklch(0.62_0.12_var(--hue)/0.2)] ' +
  'dark:border-[oklch(0.75_0.12_var(--hue)/0.38)] dark:bg-[oklch(0.75_0.12_var(--hue)/0.13)] dark:text-[oklch(0.86_0.09_var(--hue))] ' +
  'dark:hover:border-[oklch(0.75_0.12_var(--hue)/0.65)] dark:hover:bg-[oklch(0.75_0.12_var(--hue)/0.2)] ' +
  'dark:data-[popup-open]:border-[oklch(0.75_0.12_var(--hue)/0.65)] dark:data-[popup-open]:bg-[oklch(0.75_0.12_var(--hue)/0.2)]';
const COOP_TONE =
  'border-foreground/25 bg-foreground/[0.06] text-foreground hover:border-foreground/45 hover:bg-foreground/10 data-[popup-open]:border-foreground/45 data-[popup-open]:bg-foreground/10';

/** A small company color dot (menus, invite tiles); a shield for Coop Admin. */
function ToneDot({companyId}: {companyId: string | null}) {
  if (!companyId) return <ShieldCheck aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />;
  return (
    <span
      aria-hidden
      style={hueVars(companyId)}
      className="inline-block size-2.5 shrink-0 rounded-full bg-[oklch(0.62_0.12_var(--hue))] dark:bg-[oklch(0.75_0.12_var(--hue))]"
    />
  );
}

function StatusDot({status, className}: {status: Status; className?: string}) {
  const color = status === 'active' ? 'var(--status-good)' : status === 'invited' ? 'var(--status-warn)' : undefined;
  return (
    <span
      aria-hidden
      className={cn('inline-block size-2 shrink-0 rounded-full', status === 'suspended' && 'border border-muted-foreground', className)}
      style={color ? {background: color} : undefined}
    />
  );
}

export function AdminUsersView({users, companies, me, env = 'staging'}: {users: AdminUser[]; companies: AdminCompany[]; me: string | null; env?: 'staging' | 'production'}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busyEmail, setBusyEmail] = useState<string | null>(null);
  const [notice, setNotice] = useState<{kind: 'ok' | 'err'; text: string} | null>(null);

  const [query, setQuery] = useState('');
  const [accessFilter, setAccessFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState<'all' | Status>('all');

  const [inviteOpen, setInviteOpen] = useState(false);
  // A pending risky change awaiting confirmation: removal always, and in Production also
  // suspension — both then need the word typed (see PROD_CONFIRM_WORD).
  const [confirm, setConfirm] = useState<{email: string; m: AdminMembership; action: 'remove' | 'suspend'} | null>(null);
  const prod = env === 'production';

  // Clear a success message after a few seconds; errors stay until the next action.
  useEffect(() => {
    if (notice?.kind !== 'ok') return;
    const t = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(t);
  }, [notice]);

  // After a refresh, drop a pending "Remove…?" whose access no longer exists
  // (e.g. another admin removed it in the meantime).
  useEffect(() => {
    if (!confirm) return;
    const still = users.find((u) => u.email === confirm.email)?.memberships.some((m) => keyOf(m) === keyOf(confirm.m));
    if (!still) setConfirm(null);
  }, [users, confirm]);

  const options: AccessOption[] = useMemo(
    () => [
      ...companies.map((c) => ({companyKey: c.id, role: 'company_admin' as CompanyRole, company: c.name, label: `${c.name} · Company User`})),
      {companyKey: COOP_KEY, role: 'coop_admin' as CompanyRole, company: null, label: 'Coop Admin'},
    ],
    [companies],
  );

  function run(email: string, fn: () => Promise<{ok: boolean; error?: string}>, okText: string, after?: () => void) {
    if (pending) return; // one write at a time; triggers stay focusable so keyboard focus isn't dropped
    setNotice(null);
    setBusyEmail(email);
    startTransition(async () => {
      const res = await fn();
      setBusyEmail(null);
      if (res.ok) {
        setNotice({kind: 'ok', text: okText});
        after?.();
        router.refresh();
      } else {
        setNotice({kind: 'err', text: res.error ?? 'Something went wrong.'});
      }
    });
  }

  const people = useMemo(() => {
    const q = query.trim().toLowerCase();
    return users
      .filter((u) => !q || u.email.toLowerCase().includes(q))
      .filter((u) =>
        u.memberships.some(
          (m) => (accessFilter === 'all' || keyOf(m) === accessFilter) && (statusFilter === 'all' || m.status === statusFilter),
        ),
      )
      .sort((a, b) => Number(b.email === me) - Number(a.email === me) || a.email.localeCompare(b.email));
  }, [users, query, accessFilter, statusFilter, me]);

  const filtered = query.trim() !== '' || accessFilter !== 'all' || statusFilter !== 'all';

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6 px-4 py-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="font-heading text-xl font-semibold tracking-tight">Users &amp; Roles</h1>
          <p className="text-sm text-muted-foreground">
            Give people access to a company or to Coop Admin. You won&apos;t see any company&apos;s business data here.
          </p>
        </div>
        {!inviteOpen && (
          <Button onClick={() => setInviteOpen(true)}>
            <UserPlus className="size-4" />
            Invite person
          </Button>
        )}
      </header>

      <div aria-live="polite" className="min-h-0 empty:hidden">
        {notice && (
          <p
            className={cn(
              'flex items-center gap-2 rounded-lg border px-3 py-2 text-sm',
              notice.kind === 'err' && 'border-destructive/40 text-destructive',
            )}
            style={notice.kind === 'ok' ? {color: 'var(--status-good)'} : undefined}
          >
            {notice.kind === 'ok' ? <Check className="size-4" /> : <X className="size-4" />}
            {notice.text}
          </p>
        )}
      </div>

      {inviteOpen && (
        <InvitePanel
          options={options}
          users={users}
          busy={pending}
          onCancel={() => setInviteOpen(false)}
          onSubmit={(email, picked) =>
            run(
              email,
              () => grantRolesAction({email, grants: picked.map((o) => ({companyKey: o.companyKey, role: o.role}))}),
              picked.length === 1 ? `Invited ${email} as ${picked[0].label}.` : `Gave ${email} ${picked.length} roles.`,
              () => setInviteOpen(false),
            )
          }
        />
      )}

      <section aria-label="People" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[12rem] flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by email…"
              aria-label="Search people by email"
              className="h-8 w-full rounded-md border border-border bg-background pr-2.5 pl-8 text-sm outline-none transition-colors hover:border-foreground/25 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40"
            />
          </div>
          <NativeSelect aria-label="Filter by access" value={accessFilter} onChange={(e) => setAccessFilter(e.target.value)}>
            <option value="all">All access</option>
            {options.map((o) => (
              <option key={o.companyKey} value={o.companyKey}>
                {o.company ?? 'Coop Admin'}
              </option>
            ))}
          </NativeSelect>
          <NativeSelect
            aria-label="Filter by status"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as 'all' | Status)}
          >
            <option value="all">All statuses</option>
            <option value="active">Active</option>
            <option value="invited">Invited</option>
            <option value="suspended">Suspended</option>
          </NativeSelect>
          <span className="ml-auto text-xs text-muted-foreground tabular-nums">
            {people.length === users.length ? `${users.length} ${users.length === 1 ? 'person' : 'people'}` : `${people.length} of ${users.length}`}
          </span>
        </div>

        <Card className="py-0">
          <CardContent className="px-0">
            {users.length === 0 ? (
              <EmptyState
                title="No one has access yet"
                body="Invite the first person. They get access the first time they sign in with Google using that email."
                action={!inviteOpen ? <Button onClick={() => setInviteOpen(true)}>Invite person</Button> : null}
              />
            ) : people.length === 0 ? (
              <EmptyState
                title="No one matches"
                body="Try a different email or clear the filters."
                action={
                  filtered ? (
                    <Button
                      variant="outline"
                      onClick={() => {
                        setQuery('');
                        setAccessFilter('all');
                        setStatusFilter('all');
                      }}
                    >
                      Clear filters
                    </Button>
                  ) : null
                }
              />
            ) : (
              <ul className="divide-y divide-border">
                {people.map((u) => (
                  <PersonRow
                    key={u.email}
                    user={u}
                    isMe={u.email === me}
                    options={options}
                    busy={pending && busyEmail === u.email}
                    disabled={pending}
                    confirming={confirm?.email === u.email ? {m: confirm.m, action: confirm.action} : null}
                    prod={prod}
                    onAdd={(o) =>
                      run(u.email, () => grantRoleAction({email: u.email, companyKey: o.companyKey, role: o.role}), `Gave ${u.email} ${o.label}.`)
                    }
                    onStatus={(m, status) =>
                      status === 'suspended' && prod
                        ? setConfirm({email: u.email, m, action: 'suspend'})
                        : run(
                            u.email,
                            () => setStatusAction({email: u.email, companyKey: keyOf(m), status}),
                            status === 'suspended' ? `Suspended ${accessLabel(m)} for ${u.email}.` : `Reactivated ${accessLabel(m)} for ${u.email}.`,
                          )
                    }
                    onAskRemove={(m) => setConfirm({email: u.email, m, action: 'remove'})}
                    onCancelRemove={() => setConfirm(null)}
                    onConfirm={(m, action, typed) =>
                      action === 'suspend'
                        ? run(
                            u.email,
                            () => setStatusAction({email: u.email, companyKey: keyOf(m), status: 'suspended', confirm: typed}),
                            `Suspended ${accessLabel(m)} for ${u.email}.`,
                            () => setConfirm(null),
                          )
                        : run(
                            u.email,
                            () => revokeAction({email: u.email, companyKey: keyOf(m), confirm: typed}),
                            `Removed ${accessLabel(m)} from ${u.email}.`,
                            () => setConfirm(null),
                          )
                    }
                  />
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span>Chip color = company</span>
          <span className="inline-flex items-center gap-1.5">
            <ShieldCheck className="size-3.5" aria-hidden /> Coop Admin
          </span>
          <span className="inline-flex items-center gap-1.5">
            <StatusDot status="invited" /> Invited (gets access on first Google sign-in)
          </span>
          <span className="inline-flex items-center gap-1.5">
            <StatusDot status="suspended" /> Suspended
          </span>
        </p>
      </section>
    </div>
  );
}

function PersonRow({
  user,
  isMe,
  options,
  busy,
  disabled,
  confirming,
  prod,
  onAdd,
  onStatus,
  onAskRemove,
  onCancelRemove,
  onConfirm,
}: {
  user: AdminUser;
  isMe: boolean;
  options: AccessOption[];
  busy: boolean;
  disabled: boolean;
  confirming: {m: AdminMembership; action: 'remove' | 'suspend'} | null;
  prod: boolean;
  onAdd: (o: AccessOption) => void;
  onStatus: (m: AdminMembership, status: 'active' | 'suspended') => void;
  onAskRemove: (m: AdminMembership) => void;
  onCancelRemove: () => void;
  onConfirm: (m: AdminMembership, action: 'remove' | 'suspend', typed: string) => void;
}) {
  const [typed, setTyped] = useState('');
  // A fresh confirmation never inherits a previously typed word.
  const confirmKey = confirming ? `${confirming.action}:${keyOf(confirming.m)}` : '';
  useEffect(() => setTyped(''), [confirmKey]);
  const word = prod ? PROD_CONFIRM_WORD : '';
  const confirmed = !prod || typed.trim() === PROD_CONFIRM_WORD;
  const held = new Set(user.memberships.map(keyOf));
  const addable = options.filter((o) => !held.has(o.companyKey));

  return (
    <li className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-start sm:gap-4">
      <div className="flex min-w-0 items-center gap-3 sm:w-64 sm:shrink-0">
        <span
          aria-hidden
          className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold text-muted-foreground"
        >
          {initials(user.email)}
        </span>
        <div className="flex min-w-0 flex-col">
          <span className="flex items-center gap-2">
            <span className="truncate text-sm font-medium" title={user.email}>
              {user.email}
            </span>
            {isMe && <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">You</span>}
          </span>
          <span className="text-xs text-muted-foreground">
            {user.memberships.length} {user.memberships.length === 1 ? 'role' : 'roles'}
          </span>
        </div>
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-2.5">
        <div className="flex flex-wrap items-center gap-2">
          {user.memberships.map((m) => (
            <AccessChip
              key={keyOf(m)}
              m={m}
              selfAdmin={isMe && m.companyId === null}
              onStatus={(s) => onStatus(m, s)}
              onAskRemove={() => onAskRemove(m)}
            />
          ))}

          <Menu.Root>
            <Menu.Trigger
              disabled={addable.length === 0}
              title={addable.length === 0 ? 'Already has every role' : undefined}
              className="inline-flex h-7 items-center gap-1 rounded-full border border-dashed border-border px-2.5 text-xs font-medium text-muted-foreground outline-none transition-[color,border-color,transform] duration-150 ease-out hover:border-foreground/30 hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/40 active:scale-[0.97] disabled:pointer-events-none disabled:opacity-40"
            >
              <Plus className="size-3.5" />
              Add access
            </Menu.Trigger>
            <Menu.Portal>
              <Menu.Positioner side="bottom" align="start" sideOffset={6}>
                <Menu.Popup className={MENU_POPUP}>
                  <div className="px-2 pt-1 pb-1.5 text-[11px] font-medium text-muted-foreground">Give {user.email.split('@')[0]}</div>
                  {addable.map((o) => (
                    <Menu.Item key={o.companyKey} className={MENU_ITEM} onClick={() => onAdd(o)}>
                      <ToneDot companyId={o.company ? o.companyKey : null} />
                      {o.label}
                    </Menu.Item>
                  ))}
                </Menu.Popup>
              </Menu.Positioner>
            </Menu.Portal>
          </Menu.Root>

          {busy && (
            <span role="status" className="inline-flex items-center">
              <Loader2 aria-hidden className="size-4 animate-spin text-muted-foreground" />
              <span className="sr-only">Saving…</span>
            </span>
          )}
        </div>

        {confirming && (
          <form
            role="group"
            aria-label={confirming.action === 'remove' ? 'Confirm removing access' : 'Confirm suspending access'}
            className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm"
            onSubmit={(e) => {
              e.preventDefault();
              if (confirmed) onConfirm(confirming.m, confirming.action, word ? typed : '');
            }}
          >
            <span className="min-w-0 flex-1">
              {confirming.action === 'remove' ? 'Remove' : 'Suspend'} <span className="font-medium">{accessLabel(confirming.m)}</span>?{' '}
              {confirming.action === 'remove' ? 'They lose this access right away.' : 'They lose access until it’s reactivated.'}
              {prod && (
                <span className="mt-1.5 flex flex-wrap items-center gap-2 text-xs">
                  <span>
                    This is <span className="font-semibold">Production</span>. Type <span className="font-mono font-semibold">{PROD_CONFIRM_WORD}</span> to confirm:
                  </span>
                  <input
                    value={typed}
                    onChange={(e) => setTyped(e.target.value)}
                    aria-label={`Type ${PROD_CONFIRM_WORD} to confirm`}
                    autoComplete="off"
                    spellCheck={false}
                    autoFocus
                    className="h-7 w-36 rounded-md border border-border bg-background px-2 font-mono text-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40"
                  />
                </span>
              )}
            </span>
            <span className="flex gap-1.5">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => {
                  setTyped('');
                  onCancelRemove();
                }}
                disabled={disabled}
              >
                Cancel
              </Button>
              <Button type="submit" size="sm" variant="destructive" disabled={disabled || !confirmed}>
                {confirming.action === 'remove' ? 'Remove access' : 'Suspend access'}
              </Button>
            </span>
          </form>
        )}
      </div>
    </li>
  );
}

function AccessChip({
  m,
  selfAdmin,
  onStatus,
  onAskRemove,
}: {
  m: AdminMembership;
  selfAdmin: boolean;
  onStatus: (s: 'active' | 'suspended') => void;
  onAskRemove: () => void;
}) {
  const suspended = m.status === 'suspended';
  return (
    <Menu.Root>
      <Menu.Trigger
        aria-label={`${accessLabel(m)}, ${m.status}. Manage`}
        style={m.companyId ? hueVars(m.companyId) : undefined}
        className={cn(
          'inline-flex h-7 max-w-full items-center gap-1.5 rounded-full border pr-2 pl-2.5 text-xs outline-none transition-[background-color,border-color,transform,opacity] duration-150 ease-out focus-visible:ring-3 focus-visible:ring-ring/40 active:scale-[0.97] disabled:opacity-60',
          m.companyId ? COMPANY_TONE : COOP_TONE,
          suspended && 'border-dashed opacity-75',
        )}
      >
        {!m.companyId && <ShieldCheck aria-hidden className="size-3.5 shrink-0" />}
        {m.status !== 'active' && <StatusDot status={m.status} />}
        <span className={cn('truncate', !suspended && 'font-medium')}>{m.companyId ? m.companyName : 'Coop Admin'}</span>
        {m.companyId && <span className="truncate opacity-75">· {roleText(m)}</span>}
        {m.status !== 'active' && <span className="opacity-75">({m.status})</span>}
        <ChevronDown className="size-3 shrink-0 opacity-70" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="bottom" align="start" sideOffset={6}>
          <Menu.Popup className={MENU_POPUP}>
            <div className="px-2 pt-1 pb-1.5 text-[11px] font-medium text-muted-foreground">{accessLabel(m)}</div>
            {selfAdmin ? (
              <div className="px-2 pb-1.5 text-xs text-muted-foreground">You can&apos;t suspend or remove your own Coop Admin access.</div>
            ) : (
              <>
                {suspended ? (
                  <Menu.Item className={MENU_ITEM} onClick={() => onStatus('active')}>
                    Reactivate access
                  </Menu.Item>
                ) : (
                  <Menu.Item className={MENU_ITEM} onClick={() => onStatus('suspended')}>
                    Suspend access
                  </Menu.Item>
                )}
                <div role="separator" className="my-1 h-px bg-border" />
                <Menu.Item className={cn(MENU_ITEM, 'text-destructive data-[highlighted]:bg-destructive/10')} onClick={onAskRemove}>
                  Remove access…
                </Menu.Item>
              </>
            )}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

function InvitePanel({
  options,
  users,
  busy,
  onCancel,
  onSubmit,
}: {
  options: AccessOption[];
  users: AdminUser[];
  busy: boolean;
  onCancel: () => void;
  onSubmit: (email: string, picked: AccessOption[]) => void;
}) {
  const [email, setEmail] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => inputRef.current?.focus(), []);

  const normalized = email.trim().toLowerCase();
  const existing = users.find((u) => u.email === normalized);
  const held = new Set(existing?.memberships.map(keyOf) ?? []);
  const valid = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalized);
  const choices = options.filter((o) => picked.has(o.companyKey) && !held.has(o.companyKey));
  const canSend = valid && choices.length > 0 && !busy;

  function toggle(key: string) {
    setPicked((p) => {
      const n = new Set(p);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });
  }

  return (
    <Card>
      <CardContent>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (canSend) onSubmit(normalized, choices);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onCancel();
          }}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="flex flex-col gap-0.5">
              <h2 className="font-heading text-base font-semibold">Invite a person</h2>
              <p className="text-xs text-muted-foreground">They get access the first time they sign in with Google using this email.</p>
            </div>
            <Button type="button" variant="ghost" size="icon-sm" aria-label="Close" onClick={onCancel}>
              <X className="size-4" />
            </Button>
          </div>

          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium">Email</span>
            <input
              ref={inputRef}
              type="email"
              autoComplete="off"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="name@company.com"
              className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm outline-none transition-colors hover:border-foreground/25 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40"
            />
            {existing && (
              <span className="text-xs text-muted-foreground">
                {existing.email} already has access. The roles you pick are added to what they have.
              </span>
            )}
          </label>

          <fieldset className="flex flex-col gap-1.5">
            <legend className="mb-1.5 text-xs font-medium">Access</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {options.map((o) => {
                const has = held.has(o.companyKey);
                const on = picked.has(o.companyKey) || has;
                return (
                  <label
                    key={o.companyKey}
                    className={cn(
                      'flex cursor-pointer items-center gap-2.5 rounded-lg border border-border px-3 py-2.5 text-sm transition-colors hover:border-foreground/25 has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/40',
                      on && 'border-primary/50 bg-primary/5',
                      has && 'cursor-not-allowed opacity-60',
                    )}
                  >
                    <input
                      type="checkbox"
                      className="size-4 accent-[var(--primary)]"
                      checked={on}
                      disabled={has}
                      onChange={() => toggle(o.companyKey)}
                    />
                    <span className="flex min-w-0 flex-col">
                      <span className="flex items-center gap-1.5 truncate font-medium">
                        <ToneDot companyId={o.company ? o.companyKey : null} />
                        {o.company ?? 'Coop Admin'}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {has ? 'Already has this' : o.company ? 'Company User: sees and uploads this company’s data' : 'Manages people and roles; sees no business data'}
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>

          <div className="flex items-center justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSend}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : <UserPlus className="size-4" />}
              {existing ? 'Add access' : 'Send invite'}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function EmptyState({title, body, action}: {title: string; body: string; action: React.ReactNode}) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
      <h2 className="font-heading text-base font-semibold">{title}</h2>
      <p className="max-w-sm text-sm text-muted-foreground">{body}</p>
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
