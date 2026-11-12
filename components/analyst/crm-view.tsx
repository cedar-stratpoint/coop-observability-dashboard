'use client';

// The website CRM: customers, orders and cart recovery, read live from the
// Zoomy CRM Worker (the same source the storefront admin reads). Three KPI
// groups, then one table at a time — carts, orders, customers — each searchable
// and exportable. Read-only by design: the reminder and win-back sends stay on
// the storefront admin, so nothing here can email a customer.
//
// RET-04: the Customers tab shows what Ask Coop answers (repeat rate, buyers by
// orders, new buyers per month, the repeat promo / win-back audiences) from the
// SAME functions in src/crm-compute.ts the chat tools use; a parity test pins
// it (test/crm-customers-page.test.ts). A list the CRM could not read is null
// and shows "Unavailable", never 0.
//
// RET-05: each customer row can log a manual contact (DM, SMS, call, email by hand, other; contact-log-dialog.tsx). The
// Manual column counts them apart from the automated emails, through the same contactTally the chat uses. The log not
// applied (contacts null) reads "Unavailable" in that column, never 0.
//
// RET-07 (7A): a Last contacted column (PH date + kind) from the same customerRows the chat uses; "never" when every source was
// read and there is no contact, "unknown" when any source was not (never claimed as never). The sort control reuses the chat's
// comparators (compareLastContacted, compareTimesContacted).
//
// RET-08 (8B/8C): a customer's name or email (Customers, Cart recovery, Orders) opens their profile drawer (customer-profile.tsx),
// built from the lists already on this page. `?customer=<shopifyCustomerId>` is written with the native History API, which Next's
// router syncs with useSearchParams without a server round trip, so a refresh reopens it and Back closes it.
import {downloadCsv} from '@/src/csv';
import dynamic from 'next/dynamic';
import {useSearchParams} from 'next/navigation';
import {useCallback, useMemo, useRef, useState} from 'react';
import {
  AlertTriangle,
  Crown,
  Mail,
  MailCheck,
  MessageSquarePlus,
  PawPrint,
  Receipt,
  Repeat2,
  RotateCcw,
  ShoppingCart,
  Users,
} from 'lucide-react';
import {Card, CardContent} from '@/components/ui/card';
import {Badge} from '@/components/ui/badge';
import {cn} from '@/lib/utils';
import {Metric} from './metric';
import {RefreshControl} from './refresh-control';
import {ContactLogDialog} from './contact-log-dialog';
import {CustomerProfile, STATUS_TONE, type ProfileTab} from './customer-profile';
import {Eyebrow} from './sections';
import {Pagination} from './pagination';
import type {ChartBlock} from '@/src/chat/block-types';
import {
  AUDIENCE_RULES,
  CONTACT_KIND_LABEL,
  REPEAT_TARGET_PCT,
  audienceRows,
  buyersByOrders,
  cartStatus,
  compareLastContacted,
  compareTimesContacted,
  contactTally,
  customerRows,
  enrichCustomers,
  filterActive,
  filterCarts,
  filterCustomers,
  filterOrders,
  fmtPh,
  fmtPhDate,
  lastContactLabel,
  membershipWindowStart,
  money,
  newBuyersByMonth,
  peso,
  repeatRate,
  tierCounts,
  turnaround,
  EMPTY_CART_FILTER,
  EMPTY_CUSTOMER_FILTER,
  EMPTY_ORDER_FILTER,
  type CustomerAudience,
  type CustomerRow,
} from '@/src/crm-compute';
import type {CrmBirthdayVoucherSafe} from '@/src/crm-project';
import type {CustomerContact} from '@/src/customer-contacts';
import {refreshCrm} from '@/src/crm-actions';
import type {
  CrmCheckout,
  CrmCustomer,
  CrmMembershipConfig,
  CrmMetrics,
  CrmOrder,
} from '@/src/crm-types';

const PER_PAGE = 10;

// The chart renderer Ask Coop draws with: same marks, tokens and tooltip, so the
// page's charts read like the chat's. Recharts stays an async chunk (as in
// chat-blocks.tsx); the skeleton holds the height so nothing jumps.
const ChartView = dynamic(() => import('./chat-charts').then((m) => m.ChartView), {
  ssr: false,
  loading: () => <div className="h-[200px] w-full animate-pulse rounded-lg bg-muted/40" aria-hidden />,
});

const UNAVAILABLE = 'Unavailable';
const unavailableClass = 'text-base text-muted-foreground';

/** A one-series count bar chart in the chat's ChartBlock shape; the rows come straight from src/crm-compute.ts. */
function countChart(id: string, title: string, xLabel: string, rows: Array<{group: string; customers: number}>): ChartBlock {
  const columns = [
    {key: 'group', label: xLabel, unit: 'text' as const, role: 'category' as const},
    {key: 'customers', label: 'Buyers', unit: 'count' as const, role: 'measure' as const},
  ];
  return {
    kind: 'chart',
    id,
    source: id,
    title,
    reliable: true,
    caveats: [],
    basis: null,
    chart: {
      form: 'bar',
      orientation: 'vertical',
      x: {key: 'group', label: xLabel, unit: 'text'},
      series: [{key: 'customers', label: 'Buyers', unit: 'count', entity: 'buyers', color: 'chart-1'}],
      rows,
      folded: null,
    },
    chosen: {form: 'bar', orientation: 'vertical', reason: '', adjustments: [], mode: 'auto'},
    twin: {columns, rows},
  };
}

/** RET-07: the Customers tab order on top of the audience ('all' = the default order; same comparators as Ask Coop's sorts). */
type CustomerSort = 'all' | 'last_contacted_asc' | 'contacted_desc';
const PRESETS: Array<{key: CustomerAudience; label: string}> = [
  {key: 'all', label: 'All'},
  {key: 'repeat_promo', label: 'Repeat promo'},
  {key: 'win_back', label: 'Win-back'},
];

/** The preset rule in words, built from AUDIENCE_RULES so the copy cannot drift from the code. */
function presetRule(a: Exclude<CustomerAudience, 'all'>): string {
  const r = AUDIENCE_RULES[a];
  const orders = r.maxOrders === r.minOrders ? `exactly ${r.minOrders} order` : `${r.minOrders} or more orders`;
  return `${orders}, the last one ${r.minDays}+ days ago (PH time). Test orders never count.`;
}

type Tab = 'carts' | 'orders' | 'customers';

const TABS: Array<{key: Tab; label: string; icon: React.ComponentType<{className?: string}>}> = [
  {key: 'carts', label: 'Cart recovery', icon: RotateCcw},
  {key: 'orders', label: 'Orders', icon: Receipt},
  {key: 'customers', label: 'Customers', icon: Users},
];

/** One labelled dropdown. Native select on purpose: it is the control every
 * admin already knows, and it works on a phone without a popover library. */
function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: Array<[string, string]>;
}) {
  return (
    <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
      {label}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={cn(
          'h-8 rounded-lg border bg-background px-2 text-xs text-foreground outline-none',
          'focus-visible:border-primary',
          value === 'all' ? 'border-border' : 'border-primary text-primary',
        )}
      >
        {options.map(([v, l]) => (
          <option value={v} key={v}>
            {l}
          </option>
        ))}
      </select>
    </label>
  );
}

/** A name, email or order number that opens the profile; plain text when no customer matches. Module-level so a re-render (the URL
 * changing on open) keeps the same buttons, and focus can return to the one that opened the drawer. */
function ProfileLink({
  owner,
  onOpen,
  tab = 'timeline',
  orderId = null,
  className,
  children,
}: {
  owner: CustomerRow | null;
  onOpen: (owner: CustomerRow, tab: ProfileTab, orderId: string | null) => void;
  tab?: ProfileTab;
  orderId?: string | null;
  className?: string;
  children: React.ReactNode;
}) {
  if (!owner) return <span className={className}>{children}</span>;
  return (
    <button
      type="button"
      onClick={() => onOpen(owner, tab, orderId)}
      className={cn('max-w-full truncate text-left underline-offset-2 transition-colors hover:text-primary hover:underline focus-visible:text-primary focus-visible:underline focus-visible:outline-none', className)}
    >
      {children}
    </button>
  );
}

export function CrmView({
  metrics,
  customers,
  orders,
  checkouts,
  birthdayVouchers,
  membership,
  contacts,
  viewer,
  configured,
  now,
  fetchedAt,
}: {
  metrics: CrmMetrics | null;
  customers: CrmCustomer[] | null;
  orders: CrmOrder[] | null;
  checkouts: CrmCheckout[] | null;
  birthdayVouchers: CrmBirthdayVoucherSafe[] | null;
  membership: CrmMembershipConfig;
  /** The manual contact log, newest first; null when it is not set up here or could not be read (RET-05). */
  contacts: CustomerContact[] | null;
  /** The signed-in email: the log shows Delete only on this person's own contacts. */
  viewer: string | null;
  configured: boolean;
  /** The server's clock for this render (days since last order, the membership year). */
  now: string;
  /** Null when the CRM did not answer: the header then never says "Updated just now". */
  fetchedAt: string | null;
}) {
  const nowDate = useMemo(() => new Date(now), [now]);
  const [tab, setTab] = useState<Tab>('carts');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  // One filter set per table, kept while switching tabs so a narrowed view is
  // still there when you come back to it.
  const [cartFilter, setCartFilter] = useState(EMPTY_CART_FILTER);
  const [orderFilter, setOrderFilter] = useState(EMPTY_ORDER_FILTER);
  const [customerFilter, setCustomerFilter] = useState(EMPTY_CUSTOMER_FILTER);
  const [preset, setPreset] = useState<CustomerAudience>('all');
  const [customerSort, setCustomerSort] = useState<CustomerSort>('all');
  const [logFor, setLogFor] = useState<CustomerRow | null>(null);
  const needle = q.trim().toLowerCase();
  // The open profile lives in the URL; the tab and order it opens on are this page's state.
  const searchParams = useSearchParams();
  const profileId = searchParams.get('customer');
  const [profileAt, setProfileAt] = useState<{tab: ProfileTab; orderId: string | null}>({tab: 'timeline', orderId: null});
  const pushedProfile = useRef(false);
  const withCustomer = (id: string | null): string => {
    const p = new URLSearchParams(window.location.search);
    if (id === null) p.delete('customer');
    else p.set('customer', id);
    const qs = p.toString();
    return `${window.location.pathname}${qs ? `?${qs}` : ''}`;
  };
  const openProfile = (id: string, tab: ProfileTab = 'timeline', orderId: string | null = null) => {
    setProfileAt({tab, orderId});
    // A new history entry the first time (Back closes it), then replace while it stays open.
    window.history[profileId === null ? 'pushState' : 'replaceState'](null, '', withCustomer(id));
    if (profileId === null) pushedProfile.current = true;
  };
  const closeProfile = useCallback(() => {
    if (pushedProfile.current) {
      pushedProfile.current = false;
      window.history.back();
    } else window.history.replaceState(null, '', withCustomer(null));
  }, []);

  const activeFilter =
    tab === 'carts' ? cartFilter : tab === 'orders' ? orderFilter : customerFilter;
  const clearFilters = () => {
    if (tab === 'carts') setCartFilter(EMPTY_CART_FILTER);
    else if (tab === 'orders') setOrderFilter(EMPTY_ORDER_FILTER);
    else setCustomerFilter(EMPTY_CUSTOMER_FILTER);
    setPage(1);
  };
  /** Every filter change resets to page 1 — page 4 of a narrowed list is empty. */
  const onFilter = <T extends object>(set: (v: T) => void, next: T) => {
    set(next);
    setPage(1);
  };

  // Customers need both lists: without orders every count would read 0, so either one missing = unavailable.
  const customerRead = customers !== null && orders !== null;
  const all = useMemo((): CustomerRow[] => {
    if (!customers || !orders) return [];
    // The membership year as the chat computes it (Jan 1, or the programme start when later), not the raw programme start.
    const enriched = enrichCustomers(customers, orders, membershipWindowStart(nowDate, membership.programStart));
    // Emails sent needs every CRM source and the manual count needs the log; an unread part is unknown for every row, never 0.
    const tally = contactTally({checkouts: checkouts ?? [], orders, birthdayVouchers: birthdayVouchers ?? [], manualContacts: contacts ?? []});
    return customerRows(enriched, tally, nowDate, {automated: checkouts !== null && birthdayVouchers !== null, manual: contacts !== null});
  }, [customers, orders, checkouts, birthdayVouchers, contacts, membership.programStart, nowDate]);
  // Each customer's logged contacts for the dialog, newest first (the read is already ordered that way).
  const contactsByEmail = useMemo(() => {
    const m = new Map<string, CustomerContact[]>();
    for (const c of contacts ?? []) m.set(c.email, [...(m.get(c.email) ?? []), c]);
    return m;
  }, [contacts]);
  // Who a cart or an order belongs to, the way enrichCustomers matches: the customer id first, else the email.
  const customerIndex = useMemo(() => {
    const byId = new Map<string, CustomerRow>();
    const byEmail = new Map<string, CustomerRow>();
    for (const c of all) {
      byId.set(c.shopifyCustomerId, c);
      const e = (c.email ?? '').trim().toLowerCase();
      if (e && !byEmail.has(e)) byEmail.set(e, c);
    }
    return {byId, byEmail};
  }, [all]);
  const ownerOf = (customerId: string | null | undefined, email: string | null): CustomerRow | null =>
    (customerId ? customerIndex.byId.get(customerId) : undefined) ?? customerIndex.byEmail.get((email ?? '').trim().toLowerCase()) ?? null;
  const profileRow = profileId === null ? null : (customerIndex.byId.get(profileId) ?? null);
  const open = (owner: CustomerRow, tab: ProfileTab, orderId: string | null) => openProfile(owner.shopifyCustomerId, tab, orderId);
  const historyOf = (c: CustomerRow): CustomerContact[] | null =>
    contacts === null ? null : (contactsByEmail.get((c.email ?? '').trim().toLowerCase()) ?? []);
  const nameOf = (c: CustomerRow): string => [c.firstName, c.lastName].filter(Boolean).join(' ');
  const tiers = useMemo(() => tierCounts(customers ?? []), [customers]);
  const repeat = useMemo(() => repeatRate(all.map((c) => c.orderCount)), [all]);
  // Named so the Orders tile (the CRM's own total, test orders in) and "No buyers yet" never read as a contradiction (staging is all test orders).
  const testOrders = (orders ?? []).filter((o) => o.test === true).length;
  const charts = useMemo(
    () => ({
      buckets: countChart('crm-buyers-by-orders', 'Buyers by orders', 'Orders (all time)', buyersByOrders(all)),
      months: countChart('crm-new-buyers', 'New buyers per month', 'First order (PH month)', newBuyersByMonth(all)),
    }),
    [all],
  );
  const presetCounts = useMemo(
    () => ({
      repeat_promo: audienceRows(all, 'repeat_promo', nowDate).length,
      win_back: audienceRows(all, 'win_back', nowDate).length,
    }),
    [all, nowDate],
  );

  const rows = useMemo(() => {
    if (tab === 'carts') return filterCarts(checkouts ?? [], cartFilter, needle);
    if (tab === 'orders') return filterOrders(orders ?? [], orderFilter, needle);
    const listed = audienceRows(filterCustomers(all, customerFilter, needle), preset, nowDate);
    return customerSort === 'all' ? listed : listed.sort(customerSort === 'last_contacted_asc' ? compareLastContacted : compareTimesContacted);
  }, [tab, needle, checkouts, orders, all, cartFilter, orderFilter, customerFilter, preset, customerSort, nowDate]);
  const tabRead = tab === 'carts' ? checkouts !== null : tab === 'orders' ? orders !== null : customerRead;

  const pageCount = Math.max(1, Math.ceil(rows.length / PER_PAGE));
  // Clamped, not reset: searching shortens the list, and a page number left
  // past the end would render an empty table.
  const safePage = Math.min(page, pageCount);
  const shown = rows.slice((safePage - 1) * PER_PAGE, safePage * PER_PAGE);

  const onTab = (t: Tab) => {
    setTab(t);
    setPage(1);
  };

  const onExport = () => {
    if (tab === 'carts') {
      downloadCsv(`crm-abandoned-carts (${rows.length}).csv`, [
        ['Email', 'Cart value', 'Progress', 'Status', 'Reminders sent', 'Last reminder (PH time)', 'Reminder (RETURN30)', 'Abandoned (PH time)'],
        ...(rows as CrmCheckout[]).map((c) => [
          c.email ?? '',
          money(c.totalPrice, c.currency),
          c.stage,
          cartStatus(c),
          String(c.remindersSent),
          fmtPh(c.lastReminderAt),
          fmtPh(c.winbackSentAt),
          fmtPh(c.createdAt ?? c.updatedAt),
        ]),
      ]);
    } else if (tab === 'orders') {
      downloadCsv(`crm-orders (${rows.length}).csv`, [
        ['Order', 'Email', 'Total', 'Payment', 'Fulfillment', 'Placed (PH time)', 'Fulfilled (PH time)', 'Turnaround', 'Reviewed'],
        ...(rows as CrmOrder[]).map((o) => [
          o.orderNumber ?? o.shopifyOrderId,
          o.email ?? '',
          money(o.totalPrice, o.currency),
          o.financialStatus ?? '',
          o.fulfillmentStatus ?? '',
          fmtPh(o.createdAt),
          fmtPh(o.fulfilledAt),
          turnaround(o.createdAt, o.fulfilledAt),
          o.reviewSubmittedAt ? 'yes' : '',
        ]),
      ]);
    } else {
      const name = preset === 'all' ? 'crm-customers' : `crm-customers-${preset.replace('_', '-')}`;
      downloadCsv(`${name} (${rows.length}).csv`, [
        ['Name', 'Email', 'Mobile', 'Tier', 'Orders', 'First order (PH)', 'Last order (PH)', 'Days since last order', 'Emails sent', 'Manual contacts', 'Times contacted', 'Last contacted (PH)', 'Last contact kind', 'Email consent', 'Lifetime spend', 'Spend this membership year', 'Pet'],
        ...(rows as CustomerRow[]).map((c) => [
          [c.firstName, c.lastName].filter(Boolean).join(' '),
          c.email ?? '',
          c.phone ?? '',
          c.membershipTier ?? 'guest',
          String(c.orderCount),
          c.firstOrderAt ? fmtPhDate(c.firstOrderAt) : '',
          c.lastOrderAt ? fmtPhDate(c.lastOrderAt) : '',
          c.daysSinceLastOrder === null ? '' : String(c.daysSinceLastOrder),
          c.emailsSent === null ? 'unknown' : String(c.emailsSent),
          c.manualContacts === null ? 'unknown' : String(c.manualContacts),
          c.timesContacted === null ? 'unknown' : String(c.timesContacted),
          lastContactLabel(c),
          c.lastContactKind ? CONTACT_KIND_LABEL[c.lastContactKind] : '',
          c.consent,
          peso(c.spent),
          peso(c.spendYtd),
          c.petName ?? '',
        ]),
      ]);
    }
  };

  const thisYear = nowDate.getUTCFullYear();
  const vouchersThisYear = birthdayVouchers?.filter((v) => v.year === thisYear).length ?? 0;
  /** A metric the CRM did not return reads "Unavailable", never 0 (RET-04 audit finding). */
  const m = (v: number | undefined, f: (n: number) => string = (n) => n.toLocaleString()) =>
    metrics && v !== undefined ? {value: f(v)} : {value: UNAVAILABLE, valueClassName: unavailableClass};
  const counted = (n: number, read: boolean) =>
    read ? {value: n.toLocaleString()} : {value: UNAVAILABLE, valueClassName: unavailableClass};
  const partial = configured && (!metrics || customers === null || orders === null || checkouts === null || birthdayVouchers === null);

  return (
    <div className="space-y-8 p-6 md:p-10 max-md:space-y-6 max-md:p-4">
      {/* The refresh cluster sits on the title's baseline: this page has no
          reporting period above it, so "when was this read" belongs with the
          title rather than buried under the last table. */}
      <header className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div>
          <h1 className="font-serif text-3xl font-normal tracking-tight">Website CRM</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Customers, orders and cart recovery from zoomyforpets.com — live from the CRM engine,
            read-only. Reminder and win-back sends stay in the storefront admin.
          </p>
        </div>
        <div className="flex items-center gap-3 pt-1.5">
          {fetchedAt && (
            <span
              className="hidden text-xs text-muted-foreground sm:inline"
              title={`Last read at ${fmtPh(fetchedAt)} Philippine time`}
            >
              {fmtPh(fetchedAt)}
            </span>
          )}
          <RefreshControl fetchedAt={fetchedAt} beforeRefresh={refreshCrm} />
        </div>
      </header>

      {!configured && (
        <div className="flex items-start gap-2 rounded-lg border border-dashed px-3 py-2 text-xs leading-snug text-muted-foreground">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span>
            CRM credentials are not set in this environment (<code>CRM_API_URL</code> and{' '}
            <code>CRM_API_READ_TOKEN</code>), so this page is empty rather than wrong.
          </span>
        </div>
      )}

      {partial && (
        <div className="flex items-start gap-2 rounded-lg border border-dashed border-amber-400/60 px-3 py-2 text-xs leading-snug text-amber-700 dark:text-amber-300">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span>
            The CRM engine did not answer part of this request. Figures it could not read show as Unavailable, not 0.
            Refresh to try again.
          </span>
        </div>
      )}

      <section>
        <Eyebrow icon={ShoppingCart}>Store overview</Eyebrow>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <Metric icon={Users} label="Customers" {...m(metrics?.customers)} />
          <Metric icon={Receipt} label="Orders" {...m(metrics?.orders)} />
          <Metric label="Total revenue" {...m(metrics?.totalRevenue, peso)} sub="Paid orders only" />
          <Metric label="Orders (7d)" {...m(metrics?.ordersLast7Days)} />
          <Metric label="Revenue (7d)" {...m(metrics?.revenueLast7Days, peso)} />
        </div>
      </section>

      <section>
        <Eyebrow icon={Crown}>Membership</Eyebrow>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Metric
            label="Platinum"
            {...counted(tiers.platinum, customers !== null)}
            sub={`Crossed ₱${membership.platinumThreshold.toLocaleString('en-PH')} since ${membership.programStart}`}
          />
          <Metric label="Gold" {...counted(tiers.gold, customers !== null)} sub="Account holders, default tier" />
          <Metric label="Guests" {...counted(tiers.guest, customers !== null)} sub="Checked out without an account" />
          <Metric
            icon={PawPrint}
            label="Birthday vouchers"
            {...counted(vouchersThisYear, birthdayVouchers !== null)}
            sub={birthdayVouchers ? `Sent in ${thisYear} · ${birthdayVouchers.length.toLocaleString()} all time` : 'The voucher ledger did not answer'}
          />
        </div>
      </section>

      <section>
        <Eyebrow icon={RotateCcw}>Cart recovery</Eyebrow>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <Metric icon={ShoppingCart} label="Abandoned (active)" {...m(metrics?.abandonedActive)} sub="Email captured, not yet bought" />
          <Metric icon={MailCheck} label="Recovered" {...m(metrics?.recovered)} sub="Bought after a reminder" />
          <Metric icon={Mail} label="Reminded" {...m(metrics?.reminded)} />
          <Metric label="Recovery rate" {...m(metrics?.recoveryRate, (n) => `${n}%`)} sub="Recovered ÷ reminded" />
          <Metric label="Revenue recovered" {...m(metrics?.revenueRecovered, peso)} />
        </div>
      </section>

      {/* RET-04: what Ask Coop answers about repeat buying, from the same compute. Aggregates only: no names here. */}
      <section>
        <Eyebrow icon={Repeat2}>Repeat buyers</Eyebrow>
        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)_minmax(0,1.5fr)]">
          <Metric
            icon={Repeat2}
            label="Repeat buyer rate"
            {...(!customerRead
              ? {value: UNAVAILABLE, valueClassName: unavailableClass}
              : repeat.ratePct === null
                ? {value: 'No buyers yet', valueClassName: unavailableClass}
                : {value: `${repeat.ratePct.toFixed(1)}%`})}
            sub={
              <>
                {customerRead && repeat.buyers > 0 && (
                  <span className="block tabular-nums text-foreground">
                    {repeat.repeat.toLocaleString()} of {repeat.buyers.toLocaleString()} buyers ({repeat.ratePct?.toFixed(1)}%) ordered twice or more
                  </span>
                )}
                <span className="mt-1 block">Target {REPEAT_TARGET_PCT}%. A plan target, not an actual.</span>
              </>
            }
          />
          {[charts.months, charts.buckets].map((block) => (
            <Card key={block.id}>
              <CardContent className="p-4">
                <h3 className="mb-3 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{block.title}</h3>
                {customerRead ? (
                  <ChartView block={block} />
                ) : (
                  <p className="py-8 text-center text-sm text-muted-foreground">Unavailable: the CRM did not answer.</p>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          All time, website orders in any payment status, test orders excluded{testOrders > 0 && ` (${testOrders.toLocaleString()} of ${(orders ?? []).length.toLocaleString()} orders here are Shopify test orders; the Orders tile counts them)`}. Customers with no order are not buyers and stay out of the charts.
        </p>
      </section>

      <section>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="CRM tables">
            {TABS.map((t) => (
              <button
                key={t.key}
                type="button"
                role="tab"
                aria-selected={tab === t.key}
                onClick={() => onTab(t.key)}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors',
                  tab === t.key
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-border text-muted-foreground hover:border-primary hover:text-primary',
                )}
              >
                <t.icon className="size-3.5" />
                {t.label}
                <span className="tabular-nums opacity-70">
                  {(t.key === 'carts' ? checkouts : t.key === 'orders' ? orders : customerRead ? customers : null)?.length ?? '—'}
                </span>
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2 max-sm:w-full">
            <input
              type="search"
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setPage(1);
              }}
              placeholder="Search email, order # or name"
              aria-label="Search the table"
              className="h-9 w-56 rounded-lg border border-border bg-background px-3 text-sm outline-none focus-visible:border-primary max-sm:w-auto max-sm:flex-1"
            />
            <button
              type="button"
              onClick={onExport}
              disabled={!rows.length}
              className="h-9 rounded-lg border border-border px-3 text-xs font-medium text-muted-foreground transition-colors hover:border-primary hover:text-primary disabled:opacity-50"
            >
              Export CSV
            </button>
          </div>
        </div>

        <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2">
          {tab === 'carts' && (
            <>
              <FilterSelect
                label="Progress"
                value={cartFilter.stage}
                onChange={(stage) => onFilter(setCartFilter, {...cartFilter, stage})}
                options={[
                  ['all', 'All'],
                  ['Email', 'Email'],
                  ['Shipping', 'Shipping'],
                  ['Payment', 'Payment'],
                ]}
              />
              <FilterSelect
                label="Status"
                value={cartFilter.status}
                onChange={(status) => onFilter(setCartFilter, {...cartFilter, status})}
                options={[
                  ['all', 'All'],
                  ['Active', 'Active'],
                  ['Recovered', 'Recovered'],
                  ['Converted', 'Converted'],
                ]}
              />
              <FilterSelect
                label="RETURN30"
                value={cartFilter.winback}
                onChange={(winback) => onFilter(setCartFilter, {...cartFilter, winback})}
                options={[
                  ['all', 'All'],
                  ['sent', 'Sent'],
                  ['not-sent', 'Not sent'],
                ]}
              />
            </>
          )}
          {tab === 'orders' && (
            <>
              <FilterSelect
                label="Payment"
                value={orderFilter.payment}
                onChange={(payment) => onFilter(setOrderFilter, {...orderFilter, payment})}
                options={[
                  ['all', 'All'],
                  ['paid', 'Paid'],
                  ['pending', 'Pending'],
                  ['refunded', 'Refunded'],
                ]}
              />
              <FilterSelect
                label="Fulfillment"
                value={orderFilter.fulfillment}
                onChange={(fulfillment) => onFilter(setOrderFilter, {...orderFilter, fulfillment})}
                options={[
                  ['all', 'All'],
                  ['fulfilled', 'Fulfilled'],
                  ['unfulfilled', 'Unfulfilled'],
                ]}
              />
              <FilterSelect
                label="Reviewed"
                value={orderFilter.reviewed}
                onChange={(reviewed) => onFilter(setOrderFilter, {...orderFilter, reviewed})}
                options={[
                  ['all', 'All'],
                  ['reviewed', 'Reviewed'],
                  ['pending', 'Not reviewed'],
                ]}
              />
            </>
          )}
          {tab === 'customers' && (
            <>
              <div className="flex items-center gap-1 rounded-lg border border-border p-0.5" role="group" aria-label="Audience preset">
                {PRESETS.map((p) => (
                  <button
                    key={p.key}
                    type="button"
                    aria-pressed={preset === p.key}
                    onClick={() => {
                      setPreset(p.key);
                      setPage(1);
                    }}
                    className={cn(
                      'inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-[color,background-color,transform] duration-150 ease-out active:scale-[0.97]',
                      preset === p.key ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-primary',
                    )}
                  >
                    {p.label}
                    {p.key !== 'all' && customerRead && (
                      <span className="tabular-nums opacity-70">{presetCounts[p.key]}</span>
                    )}
                  </button>
                ))}
              </div>
              <FilterSelect
                label="Tier"
                value={customerFilter.tier}
                onChange={(tier) => onFilter(setCustomerFilter, {...customerFilter, tier})}
                options={[
                  ['all', 'All'],
                  ['platinum', 'Platinum'],
                  ['gold', 'Gold'],
                  ['guest', 'Guest'],
                ]}
              />
              <FilterSelect
                label="Bought"
                value={customerFilter.buyers}
                onChange={(buyers) => onFilter(setCustomerFilter, {...customerFilter, buyers})}
                options={[
                  ['all', 'All'],
                  ['buyers', 'Has ordered'],
                  ['none', 'Never ordered'],
                ]}
              />
              <FilterSelect
                label="Sort"
                value={customerSort}
                onChange={(v) => {
                  setCustomerSort(v as CustomerSort);
                  setPage(1);
                }}
                options={[
                  ['all', 'Default'],
                  ['last_contacted_asc', "Haven't contacted longest"],
                  ['contacted_desc', 'Most contacted'],
                ]}
              />
            </>
          )}
          {tab === 'customers' && preset !== 'all' && (
            <p className="basis-full text-xs text-muted-foreground">
              {PRESETS.find((p) => p.key === preset)?.label}: {presetRule(preset)}{customerSort === 'all' ? ' Listed by last order, oldest first.' : ''}
              Check email consent before contacting anyone. Nothing is sent from here.
            </p>
          )}
          {filterActive(activeFilter) && (
            <button
              type="button"
              onClick={clearFilters}
              className="text-xs font-medium text-primary underline-offset-2 hover:underline"
            >
              Clear filters
            </button>
          )}
        </div>

        <Card>
          <CardContent className="p-0">
            {rows.length === 0 ? (
              <p className="py-10 text-center text-sm text-muted-foreground">
                {!tabRead && configured
                  ? 'Unavailable: the CRM did not answer. Refresh to try again.'
                  : needle
                    ? 'Nothing matches that search.'
                    : tab === 'customers' && preset !== 'all'
                      ? 'No one fits this audience right now.'
                      : 'No rows yet.'}
              </p>
            ) : (
              <>
              <div className="overflow-x-auto max-md:hidden">
                <table className="w-full text-sm">
                  <thead className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                    {tab === 'carts' && (
                      <tr>
                        <th className="px-4 py-2.5 font-medium">Email</th>
                        <th className="px-4 py-2.5 font-medium">Cart</th>
                        <th className="px-4 py-2.5 font-medium">Progress</th>
                        <th className="px-4 py-2.5 font-medium">Status</th>
                        <th className="px-4 py-2.5 font-medium">Reminders</th>
                        <th className="px-4 py-2.5 font-medium">RETURN30</th>
                        <th className="px-4 py-2.5 font-medium">Abandoned</th>
                      </tr>
                    )}
                    {tab === 'orders' && (
                      <tr>
                        <th className="px-4 py-2.5 font-medium">Order</th>
                        <th className="px-4 py-2.5 font-medium">Email</th>
                        <th className="px-4 py-2.5 font-medium">Total</th>
                        <th className="px-4 py-2.5 font-medium">Payment</th>
                        <th className="px-4 py-2.5 font-medium">Placed</th>
                        <th className="px-4 py-2.5 font-medium">Turnaround</th>
                      </tr>
                    )}
                    {tab === 'customers' && (
                      <tr>
                        <th className="px-4 py-2.5 font-medium">Name</th>
                        <th className="px-4 py-2.5 font-medium">Email</th>
                        <th className="px-4 py-2.5 font-medium">Tier</th>
                        <th className="px-4 py-2.5 text-right font-medium">Orders</th>
                        <th className="px-4 py-2.5 font-medium">First order</th>
                        <th className="px-4 py-2.5 font-medium">Last order</th>
                        <th className="px-4 py-2.5 text-right font-medium" title="Philippine days since the last counted order">Days since</th>
                        <th className="px-4 py-2.5 text-right font-medium" title="Automated CRM emails already sent: cart reminders, win-back, review requests, birthday vouchers">Emails sent</th>
                        <th className="px-4 py-2.5 text-right font-medium" title="Contacts the team logged by hand: DM, SMS, call, email by hand, other">Manual</th>
                        <th className="px-4 py-2.5 font-medium" title="The newest contact of any kind, Philippine date. Unknown when a source could not be read">Last contacted</th>
                        <th className="px-4 py-2.5 font-medium">Consent</th>
                        <th className="px-4 py-2.5 text-right font-medium">Spend (year)</th>
                        <th className="px-4 py-2.5 font-medium">Pet</th>
                        <th className="px-2 py-2.5"><span className="sr-only">Log a contact</span></th>
                      </tr>
                    )}
                  </thead>
                  <tbody>
                    {tab === 'carts' &&
                      (shown as CrmCheckout[]).map((c) => {
                        const status = cartStatus(c);
                        return (
                          <tr key={c.shopifyCheckoutId} className="border-b last:border-0">
                            <td className="px-4 py-2.5">
                              <ProfileLink onOpen={open} owner={ownerOf(null, c.email)} tab="checkouts">{c.email ?? '—'}</ProfileLink>
                            </td>
                            <td className="px-4 py-2.5 tabular-nums">{money(c.totalPrice, c.currency)}</td>
                            <td className="px-4 py-2.5 text-xs text-muted-foreground">{c.stage}</td>
                            <td className="px-4 py-2.5">
                              <span className={cn('rounded-full px-2 py-0.5 text-xs font-medium', STATUS_TONE[status])}>
                                {status}
                              </span>
                            </td>
                            <td className="px-4 py-2.5 tabular-nums">
                              {c.remindersSent}
                              {c.lastReminderAt && (
                                <span className="ml-1 text-xs text-muted-foreground">· {fmtPh(c.lastReminderAt)}</span>
                              )}
                            </td>
                            <td className="px-4 py-2.5 text-xs text-muted-foreground">{fmtPh(c.winbackSentAt)}</td>
                            <td className="px-4 py-2.5 text-xs text-muted-foreground">
                              {fmtPh(c.createdAt ?? c.updatedAt)}
                            </td>
                          </tr>
                        );
                      })}
                    {tab === 'orders' &&
                      (shown as CrmOrder[]).map((o) => (
                        <tr key={o.shopifyOrderId} className="border-b last:border-0">
                          <td className="px-4 py-2.5 font-medium">
                            <ProfileLink onOpen={open} owner={ownerOf(o.shopifyCustomerId, o.email)} tab="orders" orderId={o.shopifyOrderId}>
                              {o.orderNumber ?? o.shopifyOrderId}
                            </ProfileLink>
                          </td>
                          <td className="px-4 py-2.5">
                            <ProfileLink onOpen={open} owner={ownerOf(o.shopifyCustomerId, o.email)} tab="orders" orderId={o.shopifyOrderId}>
                              {o.email ?? '—'}
                            </ProfileLink>
                          </td>
                          <td className="px-4 py-2.5 tabular-nums">{money(o.totalPrice, o.currency)}</td>
                          <td className="px-4 py-2.5">
                            <Badge variant={o.financialStatus === 'paid' ? 'default' : 'secondary'}>
                              {o.financialStatus ?? 'unknown'}
                            </Badge>
                          </td>
                          <td className="px-4 py-2.5 text-xs text-muted-foreground">{fmtPh(o.createdAt)}</td>
                          <td className="px-4 py-2.5 text-xs tabular-nums text-muted-foreground">
                            {turnaround(o.createdAt, o.fulfilledAt)}
                          </td>
                        </tr>
                      ))}
                    {tab === 'customers' &&
                      (shown as CustomerRow[]).map((c) => (
                        <tr key={c.shopifyCustomerId} className="border-b last:border-0">
                          <td className="px-4 py-2.5">
                            <ProfileLink onOpen={open} owner={c} className="font-medium">{nameOf(c) || '—'}</ProfileLink>
                          </td>
                          <td className="px-4 py-2.5">
                            <ProfileLink onOpen={open} owner={c}>{c.email ?? '—'}</ProfileLink>
                          </td>
                          <td className="px-4 py-2.5">
                            <span className="text-xs capitalize text-muted-foreground">
                              {c.membershipTier ?? 'guest'}
                            </span>
                          </td>
                          <td className="px-4 py-2.5 text-right tabular-nums">{c.orderCount}</td>
                          <td className="whitespace-nowrap px-4 py-2.5 text-xs text-muted-foreground">{fmtPhDate(c.firstOrderAt)}</td>
                          <td className="whitespace-nowrap px-4 py-2.5 text-xs text-muted-foreground">{fmtPhDate(c.lastOrderAt)}</td>
                          <td className="px-4 py-2.5 text-right tabular-nums">{c.daysSinceLastOrder ?? '—'}</td>
                          <td className="px-4 py-2.5 text-right tabular-nums" title={c.emailsSent === null ? 'Unknown: a CRM source did not answer' : undefined}>
                            {c.emailsSent ?? '—'}
                          </td>
                          <td className="px-4 py-2.5 text-right tabular-nums" title={c.manualContacts === null ? 'Unavailable: the contact log is not set up here' : undefined}>
                            {c.manualContacts ?? '—'}
                          </td>
                          <td className="whitespace-nowrap px-4 py-2.5 text-xs text-muted-foreground" title={c.lastContactKnown ? undefined : 'Unknown: a CRM source or the contact log did not answer'}>
                            {lastContactLabel(c)}
                            {c.lastContactKind && <span className="block">{CONTACT_KIND_LABEL[c.lastContactKind]}</span>}
                          </td>
                          <td className="px-4 py-2.5 text-xs text-muted-foreground">{c.consent.replace(/_/g, ' ')}</td>
                          <td className="px-4 py-2.5 text-right tabular-nums">{peso(c.spendYtd)}</td>
                          <td className="px-4 py-2.5 text-xs text-muted-foreground">{c.petName ?? '—'}</td>
                          <td className="px-2 py-1.5 text-right">
                            <button
                              type="button"
                              onClick={() => setLogFor(c)}
                              aria-label={`Log a contact with ${nameOf(c) || c.email || 'this customer'}`}
                              title="Log a contact"
                              className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-[color,background-color,transform] duration-150 hover:bg-muted hover:text-foreground active:scale-[0.97]"
                            >
                              <MessageSquarePlus className="size-4" />
                            </button>
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>

              {/* Mobile (below md): the same rows as scannable cards. Same data
                  and order as the table; the desktop table is hidden under md. */}
              <ul className="divide-y divide-border md:hidden">
                {tab === 'carts' &&
                  (shown as CrmCheckout[]).map((c) => {
                    const status = cartStatus(c);
                    return (
                      <li key={c.shopifyCheckoutId} className="px-4 py-3">
                        <div className="flex items-start justify-between gap-3">
                          <ProfileLink onOpen={open} owner={ownerOf(null, c.email)} tab="checkouts" className="min-w-0 flex-1 truncate text-sm font-medium">
                            {c.email ?? '—'}
                          </ProfileLink>
                          <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-xs font-medium', STATUS_TONE[status])}>
                            {status}
                          </span>
                        </div>
                        <div className="mt-1 text-base font-semibold tabular-nums">{money(c.totalPrice, c.currency)}</div>
                        <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground">
                          <div className="flex justify-between gap-2">
                            <dt>Reminders</dt>
                            <dd className="tabular-nums text-foreground">{c.remindersSent}</dd>
                          </div>
                          <div className="flex justify-between gap-2">
                            <dt>RETURN30</dt>
                            <dd>{fmtPh(c.winbackSentAt)}</dd>
                          </div>
                          {c.lastReminderAt && (
                            <div className="col-span-2 flex justify-between gap-2">
                              <dt>Last reminder</dt>
                              <dd>{fmtPh(c.lastReminderAt)}</dd>
                            </div>
                          )}
                          <div className="col-span-2 flex justify-between gap-2">
                            <dt>Abandoned</dt>
                            <dd>{fmtPh(c.createdAt ?? c.updatedAt)}</dd>
                          </div>
                        </dl>
                      </li>
                    );
                  })}
                {tab === 'orders' &&
                  (shown as CrmOrder[]).map((o) => (
                    <li key={o.shopifyOrderId} className="px-4 py-3">
                      <div className="flex items-start justify-between gap-3">
                        <ProfileLink onOpen={open} owner={ownerOf(o.shopifyCustomerId, o.email)} tab="orders" orderId={o.shopifyOrderId} className="text-sm font-medium">
                          {o.orderNumber ?? o.shopifyOrderId}
                        </ProfileLink>
                        <Badge variant={o.financialStatus === 'paid' ? 'default' : 'secondary'}>
                          {o.financialStatus ?? 'unknown'}
                        </Badge>
                      </div>
                      <div className="mt-1 text-base font-semibold tabular-nums">{money(o.totalPrice, o.currency)}</div>
                      <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground">
                        <div className="col-span-2 flex justify-between gap-2">
                          <dt>Email</dt>
                          <dd className="min-w-0 truncate text-foreground">
                            <ProfileLink onOpen={open} owner={ownerOf(o.shopifyCustomerId, o.email)} tab="orders" orderId={o.shopifyOrderId}>
                              {o.email ?? '—'}
                            </ProfileLink>
                          </dd>
                        </div>
                        <div className="flex justify-between gap-2">
                          <dt>Placed</dt>
                          <dd>{fmtPh(o.createdAt)}</dd>
                        </div>
                        <div className="flex justify-between gap-2">
                          <dt>Turnaround</dt>
                          <dd className="tabular-nums">{turnaround(o.createdAt, o.fulfilledAt)}</dd>
                        </div>
                      </dl>
                    </li>
                  ))}
                {tab === 'customers' &&
                  (shown as CustomerRow[]).map((c) => (
                    <li key={c.shopifyCustomerId} className="px-4 py-3">
                      <div className="flex items-start justify-between gap-3">
                        <ProfileLink onOpen={open} owner={c} className="min-w-0 flex-1 truncate text-sm font-medium">
                          {nameOf(c) || '—'}
                        </ProfileLink>
                        <span className="shrink-0 text-xs capitalize text-muted-foreground">{c.membershipTier ?? 'guest'}</span>
                      </div>
                      <div className="mt-0.5 truncate text-xs text-muted-foreground">
                        <ProfileLink onOpen={open} owner={c}>{c.email ?? '—'}</ProfileLink>
                      </div>
                      <dl className="mt-2 grid grid-cols-3 gap-x-4 gap-y-1 text-xs text-muted-foreground">
                        <div className="flex flex-col">
                          <dt>Orders</dt>
                          <dd className="tabular-nums text-foreground">{c.orderCount}</dd>
                        </div>
                        <div className="flex flex-col">
                          <dt>Last order</dt>
                          <dd className="tabular-nums text-foreground">{fmtPhDate(c.lastOrderAt)}</dd>
                        </div>
                        <div className="flex flex-col">
                          <dt>Days since</dt>
                          <dd className="tabular-nums text-foreground">{c.daysSinceLastOrder ?? '—'}</dd>
                        </div>
                        <div className="flex flex-col">
                          <dt>Emails sent</dt>
                          <dd className="tabular-nums text-foreground">{c.emailsSent ?? '—'}</dd>
                        </div>
                        <div className="flex flex-col">
                          <dt>Manual</dt>
                          <dd className="tabular-nums text-foreground">{c.manualContacts ?? '—'}</dd>
                        </div>
                        <div className="flex flex-col">
                          <dt>Consent</dt>
                          <dd className="text-foreground">{c.consent.replace(/_/g, ' ')}</dd>
                        </div>
                        <div className="flex flex-col">
                          <dt>Spend (yr)</dt>
                          <dd className="tabular-nums text-foreground">{peso(c.spendYtd)}</dd>
                        </div>
                        <div className="flex flex-col">
                          <dt>Pet</dt>
                          <dd className="text-foreground">{c.petName ?? '—'}</dd>
                        </div>
                        <div className="col-span-3 flex justify-between gap-2">
                          <dt>Last contacted</dt>
                          <dd className="text-foreground">
                            {lastContactLabel(c)}
                            {c.lastContactKind && <span className="text-muted-foreground"> · {CONTACT_KIND_LABEL[c.lastContactKind]}</span>}
                          </dd>
                        </div>
                      </dl>
                      <button
                        type="button"
                        onClick={() => setLogFor(c)}
                        className="mt-2.5 inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium text-muted-foreground transition-[color,border-color,transform] duration-150 hover:border-primary hover:text-foreground active:scale-[0.97]"
                      >
                        <MessageSquarePlus className="size-3.5" /> Log contact
                      </button>
                    </li>
                  ))}
              </ul>
              </>
            )}
          </CardContent>
        </Card>

        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">
            Showing {rows.length ? (safePage - 1) * PER_PAGE + 1 : 0}–
            {Math.min(safePage * PER_PAGE, rows.length)} of {rows.length}
          </p>
          <Pagination page={safePage} pageCount={pageCount} onPage={setPage} label="Table pagination" />
        </div>
      </section>

      {profileId !== null && (
        <CustomerProfile
          row={profileRow}
          orders={orders}
          checkouts={checkouts}
          birthdayVouchers={birthdayVouchers}
          contacts={contacts}
          membership={membership}
          now={nowDate}
          viewer={viewer}
          initialTab={profileAt.tab}
          openOrderId={profileAt.orderId}
          paused={logFor !== null}
          onClose={closeProfile}
          onLogContact={setLogFor}
        />
      )}
      {logFor && <ContactLogDialog name={nameOf(logFor)} email={logFor.email} history={historyOf(logFor)} viewer={viewer} onClose={() => setLogFor(null)} />}
    </div>
  );
}
