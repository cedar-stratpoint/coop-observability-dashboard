'use client';

// RET-08 (8B + 8C): one website customer's profile, a right-side drawer over the Website CRM page (full screen on phones). Built
// client-side from the lists the page already read: no new fetch. The header, stat strip and tabs reuse the Customers tab's row
// (customerRows) and the same compute as Ask Coop, so the profile can never disagree with the table:
//  - audience chips: inAudience (the presets' and the chat's rule); stat strip: the row's counts, "unknown" when a source is unread;
//  - Timeline: customerTimeline (8C), whose contact events are 7A's ContactKind, so its newest contact IS Last contacted.
// Read-only: Log contact records a contact made by hand (the existing dialog) and Copy email copies. Nothing sends. The recovery
// link is shown on this page only (never in Ask Coop or a CSV) and only for a checkout still open.
import {useEffect, useId, useMemo, useRef, useState} from 'react';
import {createPortal} from 'react-dom';
import {
  Check,
  ChevronRight,
  Copy,
  Mail,
  MessageSquare,
  MessageSquarePlus,
  PawPrint,
  Receipt,
  ShoppingCart,
  UserPlus,
  X,
} from 'lucide-react';
import {Badge} from '@/components/ui/badge';
import {cn} from '@/lib/utils';
import {metricValueClass} from './metric';
import {
  CONTACT_KIND_LABEL,
  TIMELINE_GROUP_LABEL,
  cartStatus,
  customerOrders,
  customerTimeline,
  daysToPetBirthday,
  fmtPh,
  fmtPhDate,
  inAudience,
  lastContactLabel,
  money,
  peso,
  petBirthdayStatus,
  toPlatinum,
  turnaround,
  type CartStatus,
  type ContactKind,
  type CustomerRow,
  type PetBirthdayStatus,
  type TimelineEvent,
  type TimelineGroup,
} from '@/src/crm-compute';
import {parseLineItems, phDay} from '@/src/custom-range';
import {MEMBERSHIP_EVENTS_NOT_LIVE, type CrmBirthdayVoucherSafe, type MembershipEventsRead} from '@/src/crm-project';
import {remindersOf} from '@/src/crm-table';
import type {CheckoutStage, CrmCheckout, CrmMembershipConfig, CrmOrder} from '@/src/crm-types';
import type {CustomerContact} from '@/src/customer-contacts';

export const STATUS_TONE: Record<CartStatus, string> = {
  Active: 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300',
  Recovered: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300',
  Converted: 'bg-muted text-muted-foreground',
};

export type ProfileTab = 'timeline' | 'orders' | 'checkouts' | 'pets';
type Filter = 'all' | Exclude<TimelineGroup, 'account'>;

export const PET_TONE: Record<PetBirthdayStatus, string> = {
  Sent: STATUS_TONE.Recovered,
  Upcoming: 'bg-muted text-muted-foreground',
  Passed: STATUS_TONE.Active,
};
const GROUP_ICON: Record<TimelineGroup, React.ComponentType<{className?: string}>> = {
  orders: Receipt,
  checkouts: ShoppingCart,
  emails: Mail,
  manual: MessageSquare,
  account: UserPlus,
};
const label = 'text-[11px] font-medium uppercase tracking-wide text-muted-foreground';
const btn =
  'inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium text-muted-foreground transition-[color,border-color,transform] duration-150 hover:border-primary hover:text-foreground active:scale-[0.97] disabled:opacity-50';
const pill = 'rounded-full px-2 py-0.5 text-xs font-medium';

/** Copy text, then say "Copied" for a moment. Nothing else happens: no link is opened, nothing is sent. */
export function CopyButton({text, children, className}: {text: string; children: React.ReactNode; className?: string}) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(false), 1500);
    return () => clearTimeout(t);
  }, [done]);
  return (
    <button
      type="button"
      onClick={() => navigator.clipboard?.writeText(text).then(() => setDone(true), () => undefined)}
      className={cn(btn, className)}
    >
      {done ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      <span aria-live="polite">{done ? 'Copied' : children}</span>
    </button>
  );
}

/** The 3-dot progress stepper: Email → Shipping → Payment, filled as far as the shopper got. */
export function Stepper({stage}: {stage: CheckoutStage}) {
  const n = {Started: 0, Email: 1, Shipping: 2, Payment: 3}[stage] ?? 0;
  return (
    <span className="inline-flex items-center gap-2 text-xs text-muted-foreground" title={`Got as far as ${stage}`}>
      <span className="inline-flex items-center" aria-hidden>
        {[1, 2, 3].map((i) => (
          <span key={i} className="inline-flex items-center">
            {i > 1 && <span className={cn('h-px w-2.5', i <= n ? 'bg-primary' : 'bg-border')} />}
            <span className={cn('size-2 rounded-full border', i <= n ? 'border-primary bg-primary' : 'border-border bg-background')} />
          </span>
        ))}
      </span>
      {stage}
    </span>
  );
}

function Stat({title, value, sub, unknown, children}: {title: string; value: string; sub?: React.ReactNode; unknown?: boolean; children?: React.ReactNode}) {
  return (
    <div className="rounded-lg border bg-card px-3 py-2.5">
      <div className={label}>{title}</div>
      <div className={cn(metricValueClass, 'mt-1 text-xl', unknown && 'text-base text-muted-foreground')}>{value}</div>
      {children}
      {sub && <div className="mt-0.5 text-xs text-muted-foreground">{sub}</div>}
    </div>
  );
}

function eventText(e: TimelineEvent, viewer: string | null): {title: string; detail: string | null} {
  const no = e.orderNumber ?? e.orderId ?? '';
  switch (e.kind) {
    case 'account_created':
      return {title: 'Account created', detail: 'Shopify customer record'};
    case 'order_placed':
      return {
        title: `Placed order ${no} · ${money(e.total ?? null, e.currency)}`,
        detail: [e.items?.map((i) => `${i.quantity}× ${i.title}`).join(', '), e.codes?.length ? `code ${e.codes.join(', ')}` : ''].filter(Boolean).join(' · ') || null,
      };
    case 'order_fulfilled':
      return {title: `Order ${no} fulfilled`, detail: `Turnaround ${e.turnaround}`};
    case 'review_submitted':
      return {title: 'Left a review', detail: `Order ${no}`};
    case 'review_request':
      return {title: 'Review request email', detail: `For order ${no}${e.test ? ' · test order, not counted' : ''}`};
    case 'checkout_abandoned':
      return {title: `Abandoned checkout · ${money(e.total ?? null, e.currency)}`, detail: null};
    case 'reminder':
      return {
        title: `Cart reminder ×${e.count}`,
        detail: `${e.at ? `Last sent ${fmtPh(e.at)}. ` : ''}The CRM keeps only the last reminder's date.`,
      };
    case 'winback':
      return {title: 'Win-back email (RETURN30)', detail: 'One-off win-back for an abandoned checkout'};
    case 'birthday_voucher':
      return {title: 'Birthday voucher email', detail: e.year ? `${e.year} voucher` : null};
    case 'membership':
      return {title: 'Membership email', detail: [e.tier, e.membershipEvent?.replace(/_/g, ' ')].filter(Boolean).join(' · ') || null};
    default:
      return {title: CONTACT_KIND_LABEL[e.kind as ContactKind], detail: `Logged by ${viewer !== null && e.by === viewer ? 'you' : (e.by ?? 'the team')}`};
  }
}

const tabId = (base: string, t: ProfileTab) => `${base}-tab-${t}`;

export function CustomerProfile({
  row,
  orders,
  checkouts,
  birthdayVouchers,
  membershipEvents,
  contacts,
  membership,
  now,
  viewer,
  initialTab,
  openOrderId,
  paused,
  onClose,
  onLogContact,
  reminderTotal,
}: {
  /** The Customers tab row (null: the id in the URL matches no customer, or the CRM did not answer). */
  row: CustomerRow | null;
  orders: CrmOrder[] | null;
  checkouts: CrmCheckout[] | null;
  birthdayVouchers: CrmBirthdayVoucherSafe[] | null;
  /** RET-07 7C: null = unread; live false = the CRM route is not deployed yet (not counted, with a note). */
  membershipEvents: MembershipEventsRead | null;
  contacts: CustomerContact[] | null;
  membership: CrmMembershipConfig;
  now: Date;
  viewer: string | null;
  initialTab: ProfileTab;
  /** An order to show expanded (opened from the Orders table). */
  openOrderId: string | null;
  /** True while the Log contact dialog is open over the drawer: Escape and the focus trap are the dialog's then. */
  paused: boolean;
  onClose: () => void;
  onLogContact: (row: CustomerRow) => void;
  /** RET-09: how many reminders one cart gets (the CRM's reminderStepCount), for "n of N"; absent when the CRM did not say. */
  reminderTotal?: number;
}) {
  const titleId = useId();
  const base = useId();
  const panel = useRef<HTMLElement>(null);
  const closeBtn = useRef<HTMLButtonElement>(null);
  const [mounted, setMounted] = useState(false);
  const [tab, setTab] = useState<ProfileTab>(initialTab);
  const [filter, setFilter] = useState<Filter>('all');
  const [expanded, setExpanded] = useState<string | null>(openOrderId);

  // A portal (not inline): <main> animates in, and an animated ancestor would trap a fixed panel under the nav. Mounted first so the
  // server render (a deep link renders the drawer) and the first client render agree.
  useEffect(() => setMounted(true), []);
  // Focus moves into the drawer on open and back to what opened it on close.
  useEffect(() => {
    if (!mounted) return;
    const before = document.activeElement as HTMLElement | null;
    closeBtn.current?.focus();
    return () => before?.focus?.();
  }, [mounted]);
  // Opening another customer (or another order) while open starts on the tab it asked for.
  useEffect(() => {
    setTab(initialTab);
    setExpanded(openOrderId);
    setFilter('all');
  }, [row?.shopifyCustomerId, initialTab, openOrderId]);
  useEffect(() => {
    if (paused) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key !== 'Tab' || !panel.current) return;
      // Keep Tab inside the drawer (aria-modal).
      const f = panel.current.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
      if (!f.length) return;
      const [first, last] = [f[0], f[f.length - 1]];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, paused]);
  useEffect(() => {
    if (!expanded) return;
    document.getElementById(`${base}-order-${expanded}`)?.scrollIntoView({block: 'nearest'});
  }, [expanded, base, mounted, tab]);

  const data = useMemo(() => {
    if (!row) return null;
    const mine = customerOrders(row, orders ?? []);
    const key = (row.email ?? '').trim().toLowerCase();
    const carts = key ? (checkouts ?? []).filter((k) => (k.email ?? '').trim().toLowerCase() === key) : [];
    const events = customerTimeline(row, {orders: orders ?? [], checkouts: checkouts ?? [], birthdayVouchers: birthdayVouchers ?? [], membershipEvents: membershipEvents?.events ?? [], manualContacts: contacts ?? []});
    const paid = mine.filter((o) => o.test !== true && o.financialStatus === 'paid').length;
    return {mine, carts, events, paid};
  }, [row, orders, checkouts, birthdayVouchers, membershipEvents, contacts]);

  if (!mounted) return null;

  const name = row ? [row.firstName, row.lastName].filter(Boolean).join(' ') : '';
  const unread = [checkouts === null && 'abandoned checkouts and cart emails', birthdayVouchers === null && 'birthday vouchers', membershipEvents === null && 'membership emails', contacts === null && 'manual contacts (the log is not set up here)'].filter(Boolean);
  const tabs: Array<[ProfileTab, string]> = data
    ? [
        ['timeline', 'Timeline'],
        ['orders', `Orders (${data.mine.length})`],
        ['checkouts', `Abandoned checkouts (${checkouts === null ? '—' : data.carts.length})`],
        ['pets', 'Pets'],
      ]
    : [];

  return createPortal(
    <div className="fixed inset-0 z-50">
      <button type="button" aria-label="Close profile" tabIndex={-1} onClick={onClose} className="absolute inset-0 cursor-default bg-foreground/20 animate-in fade-in-0 duration-200 motion-reduce:animate-none" />
      <aside
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="absolute inset-y-0 right-0 flex w-full flex-col border-l border-border bg-background shadow-2xl animate-in slide-in-from-right duration-250 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:animate-none sm:max-w-2xl"
      >
        <header className="border-b px-5 pb-4 pt-5 max-sm:px-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 id={titleId} className="flex flex-wrap items-center gap-2 font-serif text-2xl font-normal tracking-tight">
                <span className="min-w-0 truncate">{row ? name || row.email || 'Customer' : 'Customer profile'}</span>
                {row && (
                  <Badge variant={row.membershipTier === 'platinum' ? 'default' : 'secondary'} className="capitalize">
                    {row.membershipTier ?? 'guest'}
                  </Badge>
                )}
              </h2>
              {row && (
                <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">{row.email ?? 'no email address'}</span>
                  {row.phone && <span>{row.phone}</span>}
                  <span>Member since {fmtPhDate(row.createdAt)}</span>
                  <span>Email consent: {row.consent.replace(/_/g, ' ')}</span>
                </div>
              )}
            </div>
            <button
              ref={closeBtn}
              type="button"
              onClick={onClose}
              aria-label="Close profile"
              className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-[color,background-color] duration-150 hover:bg-muted hover:text-foreground"
            >
              <X className="size-4" />
            </button>
          </div>
          {row && data && (
            <>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {data.carts.some((k) => cartStatus(k) === 'Active') && <span className={cn(pill, STATUS_TONE.Active)}>Open abandoned checkout</span>}
                {row.orderCount >= 2 && <span className={cn(pill, STATUS_TONE.Recovered)}>Repeat buyer</span>}
                {inAudience(row, 'repeat_promo', now) && <span className={cn(pill, 'bg-secondary text-secondary-foreground')}>Repeat promo list</span>}
                {inAudience(row, 'win_back', now) && <span className={cn(pill, 'bg-destructive/10 text-destructive')}>Win-back list</span>}
                {row.orderCount === 0 && <span className={cn(pill, 'bg-muted text-muted-foreground')}>Never ordered</span>}
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => onLogContact(row)}
                  className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-semibold text-primary-foreground transition-[background-color,transform] duration-150 hover:bg-primary/90 active:scale-[0.97]"
                >
                  <MessageSquarePlus className="size-3.5" /> Log contact
                </button>
                {row.email && <CopyButton text={row.email}>Copy email</CopyButton>}
                <span className="text-xs text-muted-foreground">Nothing is sent from Coop.</span>
              </div>
            </>
          )}
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-4 max-sm:px-4">
          {!row || !data ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              {orders === null ? 'Unavailable: the CRM did not answer. Refresh to try again.' : 'No customer with this id in the CRM.'}
            </p>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Stat title="Orders" value={row.orderCount.toLocaleString()} sub={row.firstOrderAt ? `first ${fmtPhDate(row.firstOrderAt)}` : 'no orders yet'} />
                <Stat title="Lifetime spend" value={peso(row.spent)} sub="paid orders" />
                <div className="col-span-2">
                  <Stat title="Spend this membership year" value={peso(row.spendYtd)}>
                    {row.membershipTier === 'platinum' ? (
                      <PlatinumBar pct={100} text="Qualified" />
                    ) : row.membershipTier === 'gold' ? (
                      <PlatinumBar
                        pct={toPlatinum(row.spendYtd, membership.platinumThreshold).pct}
                        text={`${peso(toPlatinum(row.spendYtd, membership.platinumThreshold).left)} to Platinum`}
                      />
                    ) : (
                      <div className="mt-1 text-xs text-muted-foreground">Guest checkout: no membership</div>
                    )}
                  </Stat>
                </div>
                <Stat title="Average order" value={data.paid ? peso(row.spent / data.paid) : '—'} sub={data.paid ? `${data.paid} paid` : undefined} />
                <Stat title="Days since last order" value={row.daysSinceLastOrder === null ? '—' : String(row.daysSinceLastOrder)} sub={row.lastOrderAt ? fmtPhDate(row.lastOrderAt) : undefined} />
                <Stat
                  title="Times contacted"
                  value={row.timesContacted === null ? 'unknown' : String(row.timesContacted)}
                  unknown={row.timesContacted === null}
                  sub={`${row.emailsSent ?? 'unknown'} ${row.emailsSent === 1 ? 'email' : 'emails'} · ${row.manualContacts ?? 'unknown'} by hand`}
                />
                <Stat
                  title="Last contacted"
                  value={lastContactLabel(row)}
                  unknown={!row.lastContactKnown}
                  sub={row.lastContactKind ? CONTACT_KIND_LABEL[row.lastContactKind] : !row.lastContactKnown ? 'a source did not answer' : undefined}
                />
              </div>

              <div className="mt-5 flex flex-wrap gap-1.5 border-b pb-3" role="tablist" aria-label="Profile sections">
                {tabs.map(([t, l]) => (
                  <button
                    key={t}
                    id={tabId(base, t)}
                    type="button"
                    role="tab"
                    aria-selected={tab === t}
                    aria-controls={`${base}-panel`}
                    onClick={() => setTab(t)}
                    className={cn(
                      'rounded-full border px-3 py-1.5 text-xs font-medium transition-[color,border-color,background-color,transform] duration-150 active:scale-[0.97]',
                      tab === t ? 'border-primary bg-primary text-primary-foreground' : 'border-border text-muted-foreground hover:border-primary hover:text-primary',
                    )}
                  >
                    {l}
                  </button>
                ))}
              </div>

              <div id={`${base}-panel`} role="tabpanel" aria-labelledby={tabId(base, tab)} className="pt-4">
                {tab === 'timeline' && (
                  <Timeline
                    events={data.events}
                    filter={filter}
                    onFilter={setFilter}
                    unread={unread as string[]}
                    pending={membershipEvents?.live === false ? MEMBERSHIP_EVENTS_NOT_LIVE : null}
                    viewer={viewer}
                    onOrder={(id) => {
                      setExpanded(id);
                      setTab('orders');
                    }}
                  />
                )}
                {tab === 'orders' && <Orders orders={data.mine} expanded={expanded} onToggle={(id) => setExpanded((v) => (v === id ? null : id))} base={base} />}
                {tab === 'checkouts' &&
                  (checkouts === null ? (
                    <p className="py-8 text-center text-sm text-muted-foreground">Unavailable: the CRM did not answer.</p>
                  ) : (
                    <Checkouts carts={data.carts} reminderTotal={reminderTotal} />
                  ))}
                {tab === 'pets' && <Pets row={row} vouchers={birthdayVouchers} now={now} />}
              </div>
            </>
          )}
        </div>
      </aside>
    </div>,
    document.body,
  );
}

export function PlatinumBar({pct, text}: {pct: number; text: string}) {
  return (
    <div className="mt-1.5 flex items-center gap-2">
      <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Progress to Platinum">
        <span className="block h-full rounded-full bg-primary" style={{width: `${pct}%`}} />
      </span>
      <span className="shrink-0 text-xs text-muted-foreground">{text}</span>
    </div>
  );
}

function Timeline({
  events,
  filter,
  onFilter,
  unread,
  pending,
  viewer,
  onOrder,
}: {
  events: TimelineEvent[];
  filter: Filter;
  onFilter: (f: Filter) => void;
  unread: string[];
  /** A source that is not live yet (7C membership emails): left out on purpose, said in a muted line, not a warning. */
  pending: string | null;
  viewer: string | null;
  onOrder: (orderId: string) => void;
}) {
  const shown = filter === 'all' ? events : events.filter((e) => e.group === filter);
  const chips: Array<[Filter, string]> = [['all', 'All'], ...(Object.entries(TIMELINE_GROUP_LABEL) as Array<[Filter, string]>)];
  return (
    <>
      <div className="mb-3 flex flex-wrap gap-1.5" role="group" aria-label="Filter the timeline">
        {chips.map(([f, l]) => (
          <button
            key={f}
            type="button"
            aria-pressed={filter === f}
            onClick={() => onFilter(f)}
            className={cn(
              'h-7 rounded-md px-2.5 text-xs font-medium transition-[color,background-color,transform] duration-150 active:scale-[0.97]',
              filter === f ? 'bg-primary text-primary-foreground' : 'border text-muted-foreground hover:text-primary',
            )}
          >
            {l}
          </button>
        ))}
      </div>
      {unread.length > 0 && (
        <p className="mb-3 rounded-lg border border-dashed border-amber-400/60 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          Not shown, the source did not answer: {unread.join('; ')}.
        </p>
      )}
      {pending && <p className="mb-3 text-xs text-muted-foreground">{pending}</p>}
      {shown.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">Nothing of this kind yet.</p>
      ) : (
        <ol className="relative space-y-4 before:absolute before:inset-y-1 before:left-[13px] before:w-px before:bg-border">
          {shown.map((e) => {
            const Icon = GROUP_ICON[e.group];
            const {title, detail} = eventText(e, viewer);
            return (
              <li key={e.id} className="relative flex gap-3">
                <span className="relative z-10 flex size-7 shrink-0 items-center justify-center rounded-full border bg-background text-muted-foreground">
                  <Icon className="size-3.5" />
                </span>
                <div className={cn('min-w-0 flex-1 pt-0.5', e.test && 'opacity-70')}>
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                    <span className="text-sm font-medium">
                      {e.kind === 'order_placed' && e.orderId ? (
                        <button type="button" onClick={() => onOrder(e.orderId as string)} className="text-left underline-offset-2 hover:text-primary hover:underline">
                          {title}
                        </button>
                      ) : (
                        title
                      )}
                      {e.test && <span className={cn(pill, 'ml-2 bg-muted text-muted-foreground')}>test · not counted</span>}
                    </span>
                    <span className="text-xs tabular-nums text-muted-foreground">{e.at ? fmtPh(e.at) : 'date unknown'}</span>
                  </div>
                  {detail && <p className="mt-0.5 text-xs text-muted-foreground">{detail}</p>}
                  {e.kind === 'checkout_abandoned' && e.stage && e.status && (
                    <div className="mt-1.5 flex flex-wrap items-center gap-2.5">
                      <Stepper stage={e.stage} />
                      <span className={cn(pill, STATUS_TONE[e.status])}>{e.status}</span>
                      {e.recoveryUrl && <CopyButton text={e.recoveryUrl} className="h-7">Copy recovery link</CopyButton>}
                    </div>
                  )}
                  {e.note && <p className="mt-1 whitespace-pre-wrap break-words rounded-md bg-muted/50 px-2.5 py-1.5 text-xs">{e.note}</p>}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </>
  );
}

function Orders({orders, expanded, onToggle, base}: {orders: CrmOrder[]; expanded: string | null; onToggle: (id: string) => void; base: string}) {
  if (!orders.length) return <p className="py-8 text-center text-sm text-muted-foreground">No orders yet. See Abandoned checkouts for checkouts they started.</p>;
  return (
    <ul className="divide-y divide-border rounded-lg border">
      {orders.map((o) => {
        const open = expanded === o.shopifyOrderId;
        const items = parseLineItems(o.lineItems);
        const units = items.reduce((s, i) => s + i.quantity, 0);
        return (
          <li key={o.shopifyOrderId} id={`${base}-order-${o.shopifyOrderId}`}>
            <button
              type="button"
              aria-expanded={open}
              onClick={() => onToggle(o.shopifyOrderId)}
              className="flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm transition-colors hover:bg-muted/40"
            >
              <span className="font-medium">
                {o.orderNumber ?? o.shopifyOrderId}
                {o.test && <span className={cn(pill, 'ml-2 bg-muted text-muted-foreground')}>test</span>}
              </span>
              <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                {fmtPh(o.createdAt)}
                {items.length > 0 && ` · ${units} item${units === 1 ? '' : 's'}`}
              </span>
              <span className="font-medium tabular-nums">{money(o.totalPrice, o.currency)}</span>
              <ChevronRight className={cn('size-4 shrink-0 text-muted-foreground transition-transform duration-150', open && 'rotate-90')} />
            </button>
            {open && (
              <div className="border-t bg-muted/20 px-3 py-3">
                <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-3">
                  {(
                    [
                      ['Payment', <Badge key="p" variant={o.financialStatus === 'paid' ? 'default' : 'secondary'}>{o.financialStatus ?? 'unknown'}</Badge>],
                      ['Fulfilled', o.fulfilledAt ? fmtPh(o.fulfilledAt) : 'Not yet'],
                      ['Turnaround', turnaround(o.createdAt, o.fulfilledAt)],
                      ['Discount code', o.discountCodes?.length ? o.discountCodes.join(', ') : '—'],
                      ['Review request', o.reviewRequestSentAt ? fmtPhDate(o.reviewRequestSentAt) : '—'],
                      ['Reviewed', o.reviewSubmittedAt ? fmtPhDate(o.reviewSubmittedAt) : '—'],
                    ] as Array<[string, React.ReactNode]>
                  ).map(([k, v]) => (
                    <div key={k}>
                      <dt className="text-muted-foreground">{k}</dt>
                      <dd className="mt-0.5 text-foreground">{v}</dd>
                    </div>
                  ))}
                </dl>
                {items.length > 0 ? (
                  <div className="mt-3 overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead className="text-left text-muted-foreground">
                        <tr>
                          <th className="py-1 pr-3 font-medium">Qty</th>
                          <th className="py-1 pr-3 font-medium">Item</th>
                          <th className="py-1 pr-3 text-right font-medium">Price</th>
                          <th className="py-1 text-right font-medium">Line total</th>
                        </tr>
                      </thead>
                      <tbody>
                        {items.map((i, n) => (
                          <tr key={n} className="border-t">
                            <td className="py-1 pr-3 tabular-nums">{i.quantity}</td>
                            <td className="py-1 pr-3">{i.title}</td>
                            <td className="py-1 pr-3 text-right tabular-nums">{peso(i.unitPrice)}</td>
                            <td className="py-1 text-right tabular-nums">{peso(i.unitPrice * i.quantity)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="mt-3 text-xs text-muted-foreground">The CRM sent no line items for this order.</p>
                )}
                {o.test && <p className="mt-2 text-xs text-muted-foreground">Shopify test order: shown so nothing looks missing, but it counts nowhere.</p>}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function Checkouts({carts, reminderTotal}: {carts: CrmCheckout[]; reminderTotal?: number}) {
  if (!carts.length) return <p className="py-8 text-center text-sm text-muted-foreground">No abandoned checkouts.</p>;
  return (
    <ul className="divide-y divide-border rounded-lg border">
      {carts.map((k) => {
        const status = cartStatus(k);
        return (
          <li key={k.shopifyCheckoutId} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2.5 text-sm">
            <div className="min-w-[8rem]">
              <div className="font-medium tabular-nums">{money(k.totalPrice, k.currency)}</div>
              <div className="text-xs text-muted-foreground">{fmtPh(k.createdAt ?? k.updatedAt)}</div>
            </div>
            <Stepper stage={k.stage} />
            <span className="text-xs text-muted-foreground">
              {reminderTotal === undefined
                ? `${k.remindersSent} reminder${k.remindersSent === 1 ? '' : 's'} sent`
                : `${remindersOf(k.remindersSent, reminderTotal)} reminder${reminderTotal === 1 ? '' : 's'} sent`}
              {k.lastReminderAt && ` · last ${fmtPh(k.lastReminderAt)}`}
            </span>
            <span className={cn(pill, STATUS_TONE[status])}>{status}</span>
            {status === 'Active' && k.abandonedCheckoutUrl && (
              <CopyButton text={k.abandonedCheckoutUrl} className="ml-auto h-7">Copy recovery link</CopyButton>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function Pets({row, vouchers, now}: {row: CustomerRow; vouchers: CrmBirthdayVoucherSafe[] | null; now: Date}) {
  if (!row.petName && !row.petBirthday) return <p className="py-8 text-center text-sm text-muted-foreground">No pet profile on this customer.</p>;
  const status = vouchers === null ? null : petBirthdayStatus(row, vouchers, now);
  const days = daysToPetBirthday(row.petBirthday, now);
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border px-3 py-3">
      <div className="flex items-center gap-3">
        <span className="flex size-8 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <PawPrint className="size-4" />
        </span>
        <div>
          <div className="text-sm font-medium">{row.petName ?? 'Unnamed pet'}</div>
          <div className="text-xs text-muted-foreground">
            {row.petBirthday ? `Birthday ${fmtPhDate(row.petBirthday).replace(/,\s*\d{4}$/, '')}` : 'No birthday on file'}
            {days !== null && ` · ${days === 0 ? 'today' : `next in ${days} day${days === 1 ? '' : 's'}`}`}
          </div>
        </div>
      </div>
      <div className="text-right">
        <div className="text-[11px] text-muted-foreground">Voucher {phDay(now.getTime()).slice(0, 4)}</div>
        {vouchers === null ? (
          <span className="text-xs text-muted-foreground">unknown</span>
        ) : status ? (
          <span className={cn(pill, PET_TONE[status])}>{status}</span>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        )}
      </div>
    </div>
  );
}
