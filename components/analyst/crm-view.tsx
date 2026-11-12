'use client';

// The website CRM: customers, orders and cart recovery, read live from the
// Zoomy CRM Worker (the same source the storefront admin reads). KPI groups,
// then one table at a time, each searchable and exportable. Read-only by design:
// the reminder and win-back sends stay on the storefront admin, so nothing here
// can email a customer.
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
// read and there is no contact, "unknown" when any source was not (never claimed as never).
//
// RET-08 (8B/8C): a customer's name or email (Customers, Abandoned checkouts, Orders, Pet birthdays) opens their profile drawer
// (customer-profile.tsx), built from the lists already on this page. `?customer=<shopifyCustomerId>` is written with the native
// History API, which Next's router syncs with useSearchParams without a server round trip, so a refresh reopens it and Back closes it.
//
// RET-09 (8A): everything the storefront admin's CRM page (Vince's /admin/crm) does, in one view with tabs (owner, 2026-11-12):
// Customers · Abandoned checkouts · Orders · Pet birthdays. Every table sorts by its column headers (aria-sort, nulls last), shows
// 10 / 25 / 50 rows, clears its filters and exports a CSV with Vince's summary header (src/crm-table.ts). The Abandoned checkouts tab
// carries its own cart-recovery tiles and the CRM's reminder schedule line; Orders carries the review schedule line. One sort model on
// Customers: the header sort IS the order, and 7A's Sort select is a shortcut that writes the same state ("Haven't contacted longest"
// = Last contacted ascending, "Most contacted" = times contacted descending); a header click shows "By column" in the select. The
// recovery link is copyable on every cart on this page only: never in a CSV, never in Ask Coop.
import {downloadCsv} from '@/src/csv';
import dynamic from 'next/dynamic';
import {useSearchParams} from 'next/navigation';
import {useCallback, useMemo, useRef, useState} from 'react';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Clock,
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
import {CopyButton, CustomerProfile, PET_TONE, PlatinumBar, STATUS_TONE, Stepper, type ProfileTab} from './customer-profile';
import {InfoPop, InfoTip} from './info-tip';
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
  textMatch,
  tierCounts,
  toPlatinum,
  turnaround,
  EMPTY_CART_FILTER,
  EMPTY_CUSTOMER_FILTER,
  EMPTY_ORDER_FILTER,
  type CustomerAudience,
  type CustomerRow,
} from '@/src/crm-compute';
import {
  CART_SORT,
  CUSTOMER_SORT,
  ORDER_SORT,
  PET_SORT,
  cartCsv,
  customerCsv,
  filterNote,
  nextSort,
  orderCsv,
  petCsv,
  petRows,
  remindersOf,
  reminderSchedule,
  reviewSchedule,
  sortRows,
  type CartSortKey,
  type CustomerSortKey,
  type OrderSortKey,
  type PetRow,
  type PetSortKey,
  type Sort,
} from '@/src/crm-table';
import type {CrmBirthdayVoucherSafe, MembershipEventsRead} from '@/src/crm-project';
import {phDay} from '@/src/custom-range';
import type {CustomerContact} from '@/src/customer-contacts';
import {refreshCrm} from '@/src/crm-actions';
import type {CrmCheckout, CrmCustomer, CrmMembershipConfig, CrmMetrics, CrmOrder} from '@/src/crm-types';

const PAGE_SIZES = [10, 25, 50] as const;

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

/** 7A's Sort select as shortcuts into the one header sort ("column" = a header sort the select has no name for). */
type SortChoice = 'all' | 'last_contacted_asc' | 'contacted_desc' | 'column';
const SORT_CHOICES: Record<Exclude<SortChoice, 'column'>, Sort<CustomerSortKey> | null> = {
  all: null,
  last_contacted_asc: {key: 'lastContacted', dir: 'asc'},
  contacted_desc: {key: 'timesContacted', dir: 'desc'},
};
function sortChoiceOf(s: Sort<CustomerSortKey> | null): SortChoice {
  if (s === null) return 'all';
  if (s.key === 'lastContacted' && s.dir === 'asc') return 'last_contacted_asc';
  if (s.key === 'timesContacted' && s.dir === 'desc') return 'contacted_desc';
  return 'column';
}

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

type Tab = 'customers' | 'carts' | 'orders' | 'pets';

const TABS: Array<{key: Tab; label: string; icon: React.ComponentType<{className?: string}>}> = [
  {key: 'customers', label: 'Customers', icon: Users},
  {key: 'carts', label: 'Abandoned checkouts', icon: RotateCcw},
  {key: 'orders', label: 'Orders', icon: Receipt},
  {key: 'pets', label: 'Pet birthdays', icon: PawPrint},
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

const th = 'px-4 py-2.5 font-medium';

/** A sortable column header: the button toggles the direction, aria-sort says where it stands, an ⓘ can sit beside it. */
function SortTh<K extends string>({
  label,
  k,
  sort,
  onSort,
  className,
  title,
  info,
}: {
  label: string;
  k: K;
  sort: Sort<K> | null;
  onSort: (k: K) => void;
  className?: string;
  title?: string;
  info?: React.ReactNode;
}) {
  const active = sort?.key === k;
  const Icon = !active ? ArrowUpDown : sort.dir === 'asc' ? ArrowUp : ArrowDown;
  return (
    <th aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'} className={cn(th, className)} title={title}>
      <span className="inline-flex items-center gap-1">
        <button
          type="button"
          onClick={() => onSort(k)}
          className={cn(
            'inline-flex items-center gap-1 whitespace-nowrap uppercase tracking-wide transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:outline-none',
            active && 'text-foreground',
          )}
        >
          {label}
          <Icon className={cn('size-3 shrink-0', !active && 'opacity-40')} aria-hidden />
        </button>
        {info}
      </span>
    </th>
  );
}

/** "⏱ Reminder: sent 1 hour after abandonment", straight from the CRM's settings; nothing when the CRM did not send them. */
function ScheduleLine({text}: {text: string | null}) {
  if (!text) return null;
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground" title="Read live from the CRM engine's settings. Change it in the storefront admin.">
      <Clock className="size-3.5 shrink-0" aria-hidden />
      {text}
    </span>
  );
}

/** Gold: the bar and the pesos left this membership year. Platinum: Qualified. A guest has no tier. */
function ToPlatinum({row, threshold}: {row: CustomerRow; threshold: number}) {
  if (row.membershipTier === 'platinum') return <span className={cn('rounded-full px-2 py-0.5 text-xs font-medium', STATUS_TONE.Recovered)}>Qualified</span>;
  if (row.membershipTier !== 'gold') return <span className="text-xs text-muted-foreground">—</span>;
  const {pct, left} = toPlatinum(row.spendYtd, threshold);
  return (
    <div className="min-w-[9.5rem]" title={`${peso(row.spendYtd)} of ${peso(threshold)} this membership year`}>
      <PlatinumBar pct={pct} text={left > 0 ? `${peso(left)} left` : 'Eligible'} />
    </div>
  );
}

const nextLabel = (days: number | null): string =>
  days === null ? '—' : days === 0 ? 'Today' : days === 1 ? 'Tomorrow' : `in ${days} days`;
const birthdayLabel = (b: string | null): string => (b ? fmtPhDate(b).replace(/,\s*\d{4}$/, '') : '—');

/** This year's voucher pill; "unknown" when the ledger was not read, a dash without a birthday. The code never reaches the page. */
function VoucherStatus({p, read}: {p: PetRow; read: boolean}) {
  if (!read) return <span className="text-xs text-muted-foreground">unknown</span>;
  if (!p.status) return <span className="text-xs text-muted-foreground">—</span>;
  return (
    <span className={cn('rounded-full px-2 py-0.5 text-xs font-medium', PET_TONE[p.status])} title={p.sentAt ? `Sent ${fmtPh(p.sentAt)} Philippine time` : undefined}>
      {p.status}
    </span>
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

const pill = 'rounded-full px-2 py-0.5 text-xs font-medium';

export function CrmView({
  metrics,
  customers,
  orders,
  checkouts,
  birthdayVouchers,
  membershipEvents,
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
  /** RET-07 7C: null = unread (unknown); live false = the CRM route is not deployed yet (not counted, emails sent stays known). */
  membershipEvents: MembershipEventsRead | null;
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
  const [tab, setTab] = useState<Tab>('customers');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  // Rows per page, one per table (Vince's per-table select), kept while switching tabs.
  const [perPage, setPerPage] = useState<Record<Tab, number>>({customers: 10, carts: 10, orders: 10, pets: 10});
  // One filter set and one sort per table, kept while switching tabs so a narrowed view is still there when you come back to it.
  const [cartFilter, setCartFilter] = useState(EMPTY_CART_FILTER);
  const [orderFilter, setOrderFilter] = useState(EMPTY_ORDER_FILTER);
  const [customerFilter, setCustomerFilter] = useState(EMPTY_CUSTOMER_FILTER);
  const [petFilter, setPetFilter] = useState('all');
  const [preset, setPreset] = useState<CustomerAudience>('all');
  // Vince's defaults: newest abandoned and newest placed first, soonest birthday first. Customers keep their list order until sorted.
  const [cartSort, setCartSort] = useState<Sort<CartSortKey> | null>({key: 'abandoned', dir: 'desc'});
  const [orderSort, setOrderSort] = useState<Sort<OrderSortKey> | null>({key: 'placed', dir: 'desc'});
  const [customerSort, setCustomerSort] = useState<Sort<CustomerSortKey> | null>(null);
  const [petSort, setPetSort] = useState<Sort<PetSortKey> | null>({key: 'next', dir: 'asc'});
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

  const filtersOn =
    tab === 'carts'
      ? filterActive(cartFilter)
      : tab === 'orders'
        ? filterActive(orderFilter)
        : tab === 'customers'
          ? filterActive(customerFilter) || preset !== 'all'
          : petFilter !== 'all';
  const clearFilters = () => {
    if (tab === 'carts') setCartFilter(EMPTY_CART_FILTER);
    else if (tab === 'orders') setOrderFilter(EMPTY_ORDER_FILTER);
    else if (tab === 'customers') {
      setCustomerFilter(EMPTY_CUSTOMER_FILTER);
      setPreset('all');
    } else setPetFilter('all');
    setPage(1);
  };
  /** Every filter or sort change resets to page 1: page 4 of a narrowed or reordered list is not the page you were reading. */
  const onFilter = <T,>(set: (v: T) => void, next: T) => {
    set(next);
    setPage(1);
  };
  const sorter =
    <K extends string>(set: React.Dispatch<React.SetStateAction<Sort<K> | null>>) =>
    (k: K) => {
      set((cur) => nextSort(cur, k));
      setPage(1);
    };
  const sortCarts = sorter(setCartSort);
  const sortOrders = sorter(setOrderSort);
  const sortCustomers = sorter(setCustomerSort);
  const sortPets = sorter(setPetSort);

  // Customers need both lists: without orders every count would read 0, so either one missing = unavailable.
  const customerRead = customers !== null && orders !== null;
  const all = useMemo((): CustomerRow[] => {
    if (!customers || !orders) return [];
    // The membership year as the chat computes it (Jan 1, or the programme start when later), not the raw programme start.
    const enriched = enrichCustomers(customers, orders, membershipWindowStart(nowDate, membership.programStart));
    // Emails sent needs every CRM source and the manual count needs the log; an unread part is unknown for every row, never 0.
    const tally = contactTally({checkouts: checkouts ?? [], orders, birthdayVouchers: birthdayVouchers ?? [], membershipEvents: membershipEvents?.events ?? [], manualContacts: contacts ?? []});
    return customerRows(enriched, tally, nowDate, {automated: checkouts !== null && birthdayVouchers !== null && membershipEvents !== null, manual: contacts !== null});
  }, [customers, orders, checkouts, birthdayVouchers, membershipEvents, contacts, membership.programStart, nowDate]);
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
  // Pets need only the customer list (one pet per customer, as the CRM projects it).
  const pets = useMemo(() => petRows(customers ?? [], birthdayVouchers, nowDate), [customers, birthdayVouchers, nowDate]);

  const cartRows = useMemo(() => sortRows(filterCarts(checkouts ?? [], cartFilter, needle), cartSort, CART_SORT), [checkouts, cartFilter, needle, cartSort]);
  const orderRows = useMemo(() => sortRows(filterOrders(orders ?? [], orderFilter, needle), orderSort, ORDER_SORT), [orders, orderFilter, needle, orderSort]);
  const customerList = useMemo(() => {
    const listed = audienceRows(filterCustomers(all, customerFilter, needle), preset, nowDate);
    return customerSort === null ? listed : sortRows(listed, customerSort, CUSTOMER_SORT);
  }, [all, customerFilter, needle, preset, nowDate, customerSort]);
  const petList = useMemo(
    () => sortRows(pets.filter((p) => textMatch(needle, [p.email, p.petName]) && (petFilter === 'all' || p.status === petFilter)), petSort, PET_SORT),
    [pets, needle, petFilter, petSort],
  );

  const total = {customers: customerList.length, carts: cartRows.length, orders: orderRows.length, pets: petList.length}[tab];
  const tabRead = tab === 'carts' ? checkouts !== null : tab === 'orders' ? orders !== null : tab === 'pets' ? customers !== null : customerRead;
  const per = perPage[tab];
  const pageCount = Math.max(1, Math.ceil(total / per));
  // Clamped, not reset: searching shortens the list, and a page number left
  // past the end would render an empty table.
  const safePage = Math.min(page, pageCount);
  const shown = <T,>(rows: T[]): T[] => rows.slice((safePage - 1) * per, safePage * per);

  const onTab = (t: Tab) => {
    setTab(t);
    setPage(1);
  };

  // The PH year: the voucher ledger and petBirthdayStatus key on it.
  const thisYear = Number(phDay(nowDate.getTime()).slice(0, 4));
  const reminderTotal = metrics?.reminderStepCount;

  const onExport = () => {
    const asOf = fmtPh(new Date().toISOString());
    if (tab === 'carts') {
      const note = filterNote([['Progress', cartFilter.stage], ['Status', cartFilter.status], ['RETURN30', cartFilter.winback]], q);
      downloadCsv(`crm-abandoned-checkouts (${cartRows.length}).csv`, cartCsv(cartRows, asOf, note, reminderTotal));
    } else if (tab === 'orders') {
      const note = filterNote([['Payment', orderFilter.payment], ['Fulfillment', orderFilter.fulfillment], ['Reviewed', orderFilter.reviewed]], q);
      downloadCsv(`crm-orders (${orderRows.length}).csv`, orderCsv(orderRows, asOf, note));
    } else if (tab === 'customers') {
      const name = preset === 'all' ? 'crm-customers' : `crm-customers-${preset.replace('_', '-')}`;
      const note = filterNote([['Audience', preset], ['Tier', customerFilter.tier], ['Bought', customerFilter.buyers]], q);
      downloadCsv(`${name} (${customerList.length}).csv`, customerCsv(customerList, asOf, note, membership.platinumThreshold, name));
    } else {
      const note = filterNote([['Voucher', petFilter]], q);
      downloadCsv(`crm-pet-birthdays (${petList.length}).csv`, petCsv(petList, asOf, note, thisYear));
    }
  };

  const vouchersThisYear = birthdayVouchers?.filter((v) => v.year === thisYear).length ?? 0;
  /** A metric the CRM did not return reads "Unavailable", never 0 (RET-04 audit finding). */
  const m = (v: number | undefined, f: (n: number) => string = (n) => n.toLocaleString()) =>
    metrics && v !== undefined ? {value: f(v)} : {value: UNAVAILABLE, valueClassName: unavailableClass};
  const counted = (n: number, read: boolean) =>
    read ? {value: n.toLocaleString()} : {value: UNAVAILABLE, valueClassName: unavailableClass};
  const partial = configured && (!metrics || customers === null || orders === null || checkouts === null || birthdayVouchers === null);
  const threshold = `₱${membership.platinumThreshold.toLocaleString('en-PH')}`;

  const emptyText = !tabRead && configured
    ? 'Unavailable: the CRM did not answer. Refresh to try again.'
    : needle
      ? 'Nothing matches that search.'
      : filtersOn
        ? tab === 'customers' && preset !== 'all' && !filterActive(customerFilter)
          ? 'No one fits this audience right now.'
          : 'Nothing matches these filters.'
        : tab === 'pets'
          ? 'No pets on file yet.'
          : 'No rows yet.';

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

      {/* Tile hints: Vince's ⓘ copy, reworded where Coop's rule differs (Shopify test orders count nowhere but in the CRM's own totals). */}
      <section>
        <Eyebrow icon={ShoppingCart}>Store overview</Eyebrow>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <Metric icon={Users} label="Customers" {...m(metrics?.customers)} hint="Every customer record the CRM holds, buyers or not." />
          <Metric
            icon={Receipt}
            label="Orders"
            {...m(metrics?.orders)}
            hint="Every order the CRM captured, in any status. This is the CRM's own count, so Shopify test orders are in it. Every other figure on this page leaves them out."
          />
          <Metric
            label="Total revenue"
            {...m(metrics?.totalRevenue, peso)}
            sub="Paid orders only"
            hint="The CRM's sum of order totals for paid orders only. Refunded and unpaid orders are left out, so it can be lower than adding up every row of the Orders CSV."
          />
          <Metric label="Orders (7d)" {...m(metrics?.ordersLast7Days)} hint="Orders placed in the last 7 days, any status. The CRM's own rolling window, not a calendar week." />
          <Metric label="Revenue (7d)" {...m(metrics?.revenueLast7Days, peso)} hint="Paid revenue from orders placed in the last 7 days (the CRM's rolling window)." />
        </div>
      </section>

      <section>
        <Eyebrow icon={Crown}>Membership</Eyebrow>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Metric
            label="Platinum"
            {...counted(tiers.platinum, customers !== null)}
            sub={`Crossed ${threshold} since ${membership.programStart}`}
            hint={`Members who crossed the ${threshold} paid-spend threshold this membership year.`}
          />
          <Metric label="Gold" {...counted(tiers.gold, customers !== null)} sub="Account holders, default tier" hint="Account holders on the default Gold tier, below the Platinum threshold." />
          <Metric label="Guests" {...counted(tiers.guest, customers !== null)} sub="Checked out without an account" hint="Customers with no account (guest checkout). They have no membership tier." />
          <Metric
            icon={PawPrint}
            label="Birthday vouchers"
            {...counted(vouchersThisYear, birthdayVouchers !== null)}
            sub={birthdayVouchers ? `Sent in ${thisYear} · ${birthdayVouchers.length.toLocaleString()} all time` : 'The voucher ledger did not answer'}
            hint="Pet birthday vouchers the CRM emailed this year, one per customer per year. The codes stay in the storefront admin."
          />
        </div>
      </section>

      {/* RET-04: what Ask Coop answers about repeat buying, from the same compute. Aggregates only: no names here. */}
      <section>
        <Eyebrow icon={Repeat2}>Repeat buyers</Eyebrow>
        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)_minmax(0,1.5fr)]">
          <Metric
            icon={Repeat2}
            label="Repeat buyer rate"
            hint="Buyers with 2 or more orders divided by buyers with 1 or more, all time, any payment status. Test orders never count."
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
                  'inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-[color,background-color,border-color,transform] duration-150 ease-out active:scale-[0.97]',
                  tab === t.key
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-border text-muted-foreground hover:border-primary hover:text-primary',
                )}
              >
                <t.icon className="size-3.5" />
                {t.label}
                <span className="tabular-nums opacity-70">
                  {(t.key === 'carts' ? checkouts : t.key === 'orders' ? orders : t.key === 'pets' ? (customers === null ? null : pets) : customerRead ? customers : null)?.length ?? '—'}
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
              placeholder={tab === 'pets' ? 'Search email or pet' : 'Search email, order # or name'}
              aria-label="Search the table"
              className="h-9 w-56 rounded-lg border border-border bg-background px-3 text-sm outline-none focus-visible:border-primary max-sm:w-auto max-sm:flex-1"
            />
            <button
              type="button"
              onClick={onExport}
              disabled={!total}
              className="h-9 rounded-lg border border-border px-3 text-xs font-medium text-muted-foreground transition-[color,border-color,transform] duration-150 hover:border-primary hover:text-primary active:scale-[0.97] disabled:opacity-50"
            >
              Export CSV
            </button>
          </div>
        </div>

        {/* The Abandoned checkouts tab carries its own cart-recovery tiles (owner: one view, with tabs). */}
        {tab === 'carts' && (
          <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <Metric icon={ShoppingCart} label="Abandoned (active)" {...m(metrics?.abandonedActive)} sub="Email captured, not yet bought" hint="Checkouts that captured an email but have not turned into an order yet." />
            <Metric
              icon={MailCheck}
              label="Recovered"
              {...m(metrics?.recovered)}
              sub="Bought after a reminder"
              hint="Abandoned checkouts that turned into an order after at least one reminder email. Carts bought without a reminder are not counted here."
            />
            <Metric icon={Mail} label="Reminded" {...m(metrics?.reminded)} hint="Abandoned checkouts that got at least one reminder email. This is what the recovery rate divides by." />
            <Metric label="Recovery rate" {...m(metrics?.recoveryRate, (n) => `${n}%`)} sub="Recovered ÷ reminded" hint="Recovered divided by reminded: of the checkouts the CRM emailed, the share that went on to buy." />
            <Metric label="Revenue recovered" {...m(metrics?.revenueRecovered, peso)} hint="The total value of the checkouts recovered after a reminder." />
          </div>
        )}

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
                    onClick={() => onFilter(setPreset, p.key)}
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
                value={sortChoiceOf(customerSort)}
                onChange={(v) => v !== 'column' && onFilter(setCustomerSort, SORT_CHOICES[v as Exclude<SortChoice, 'column'>])}
                options={[
                  ['all', 'Default'],
                  ['last_contacted_asc', "Haven't contacted longest"],
                  ['contacted_desc', 'Most contacted'],
                  ...(sortChoiceOf(customerSort) === 'column' ? ([['column', 'By column']] as Array<[string, string]>) : []),
                ]}
              />
            </>
          )}
          {tab === 'pets' && (
            <FilterSelect
              label={`Voucher ${thisYear}`}
              value={petFilter}
              onChange={(v) => onFilter(setPetFilter, v)}
              options={[
                ['all', 'All'],
                ['Sent', 'Sent'],
                ['Upcoming', 'Upcoming'],
                ['Passed', 'Passed'],
              ]}
            />
          )}
          {filtersOn && (
            <button
              type="button"
              onClick={clearFilters}
              className="text-xs font-medium text-primary underline-offset-2 hover:underline"
            >
              Clear filters
            </button>
          )}
          {tab === 'carts' && <span className="sm:ml-auto"><ScheduleLine text={reminderSchedule(metrics)} /></span>}
          {tab === 'orders' && <span className="sm:ml-auto"><ScheduleLine text={reviewSchedule(metrics)} /></span>}
          {tab === 'customers' && preset !== 'all' && (
            <p className="basis-full text-xs text-muted-foreground">
              {PRESETS.find((p) => p.key === preset)?.label}: {presetRule(preset)}{customerSort === null ? ' Listed by last order, oldest first.' : ''}
              Check email consent before contacting anyone. Nothing is sent from here.
            </p>
          )}
        </div>

        <Card>
          <CardContent className="p-0">
            {total === 0 ? (
              <p className="py-10 text-center text-sm text-muted-foreground">{emptyText}</p>
            ) : (
              <>
              <div className="overflow-x-auto max-md:hidden">
                <table className="w-full text-sm">
                  <thead className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                    {tab === 'carts' && (
                      <tr>
                        <SortTh label="Email" k="email" sort={cartSort} onSort={sortCarts} />
                        <SortTh label="Cart" k="total" sort={cartSort} onSort={sortCarts} className="text-right" />
                        <SortTh label="Items" k="items" sort={cartSort} onSort={sortCarts} className="text-right" title="Line items in the cart" />
                        <SortTh
                          label="Progress"
                          k="progress"
                          sort={cartSort}
                          onSort={sortCarts}
                          info={
                            <InfoPop label="How each progress stage is detected">
                              <p className="font-medium">How each stage is detected</p>
                              <p><b>Email</b>: the shopper entered their email at checkout.</p>
                              <p><b>Shipping</b>: a shipping address was entered, or a shipping method was worked out (which needs one).</p>
                              <p>
                                <b>Payment</b>: the shopper submitted payment (pressed Pay) but it did not go through, for example a declined card. A high-intent cart worth
                                recovering. A payment that goes through becomes an order (see Status).
                              </p>
                              <p className="text-muted-foreground">Typing card details without submitting cannot be seen, the same limit Google Analytics has.</p>
                            </InfoPop>
                          }
                        />
                        <SortTh
                          label="Reminders"
                          k="reminders"
                          sort={cartSort}
                          onSort={sortCarts}
                          title={reminderTotal === undefined ? 'Reminder emails sent' : `Reminder emails sent, of the ${reminderTotal} the CRM sends per cart`}
                        />
                        <SortTh label="RETURN30" k="winback" sort={cartSort} onSort={sortCarts} title="When the one-off RETURN30 win-back email went out. Tracked apart from the reminders." />
                        <SortTh
                          label="Status"
                          k="status"
                          sort={cartSort}
                          onSort={sortCarts}
                          info={
                            <InfoPop label="What each status means">
                              <p className="font-medium">What each status means</p>
                              <p><b>Active</b>: still abandoned. The shopper has not bought yet, and reminder emails may still go out.</p>
                              <p><b>Recovered</b>: the shopper came back and bought <b>after</b> a reminder was sent. A sale the reminders helped win back.</p>
                              <p><b>Converted</b>: the shopper bought on their own, <b>before</b> any reminder was sent.</p>
                            </InfoPop>
                          }
                        />
                        <SortTh label="Abandoned" k="abandoned" sort={cartSort} onSort={sortCarts} />
                        <th className="px-2 py-2.5"><span className="sr-only">Recovery link</span></th>
                      </tr>
                    )}
                    {tab === 'orders' && (
                      <tr>
                        <SortTh label="Order" k="order" sort={orderSort} onSort={sortOrders} />
                        <SortTh label="Email" k="email" sort={orderSort} onSort={sortOrders} />
                        <SortTh label="Total" k="total" sort={orderSort} onSort={sortOrders} className="text-right" />
                        <SortTh label="Payment" k="payment" sort={orderSort} onSort={sortOrders} />
                        <SortTh label="Placed" k="placed" sort={orderSort} onSort={sortOrders} />
                        <SortTh label="Turnaround" k="turnaround" sort={orderSort} onSort={sortOrders} title="Placed to fulfilled" />
                        <SortTh label="Fulfilled" k="fulfilled" sort={orderSort} onSort={sortOrders} />
                        <SortTh label="Review sent" k="reviewSent" sort={orderSort} onSort={sortOrders} title="When the CRM emailed the review request" />
                        <SortTh label="Reviewed" k="reviewed" sort={orderSort} onSort={sortOrders} />
                      </tr>
                    )}
                    {tab === 'customers' && (
                      <tr>
                        <SortTh label="Name" k="name" sort={customerSort} onSort={sortCustomers} />
                        <SortTh label="Email" k="email" sort={customerSort} onSort={sortCustomers} />
                        <SortTh label="Member since" k="memberSince" sort={customerSort} onSort={sortCustomers} title="When the customer record was created (PH date)" />
                        <SortTh
                          label="Tier"
                          k="tier"
                          sort={customerSort}
                          onSort={sortCustomers}
                          info={
                            <InfoPop label="What each tier means">
                              <p className="font-medium">Membership tiers</p>
                              <p><b>Platinum</b>: crossed {threshold} of paid spend this membership year (from {membership.programStart} or January 1, whichever is later).</p>
                              <p><b>Gold</b>: has an account. The default tier.</p>
                              <p><b>Guest</b>: checked out without an account, so no tier.</p>
                              <p className="text-muted-foreground">The tier is the one the storefront stamped on the customer.</p>
                            </InfoPop>
                          }
                        />
                        <SortTh
                          label="To Platinum"
                          k="toPlatinum"
                          sort={customerSort}
                          onSort={sortCustomers}
                          info={<InfoTip text={`Gold members: this membership year's paid spend toward ${threshold}, and the pesos left. Platinum members already qualify.`} />}
                        />
                        <SortTh label="Orders" k="orders" sort={customerSort} onSort={sortCustomers} className="text-right" />
                        <SortTh label="First order" k="firstOrder" sort={customerSort} onSort={sortCustomers} />
                        <SortTh label="Last order" k="lastOrder" sort={customerSort} onSort={sortCustomers} />
                        <SortTh label="Days since" k="daysSince" sort={customerSort} onSort={sortCustomers} className="text-right" title="Philippine days since the last counted order" />
                        <SortTh label="Emails sent" k="emailsSent" sort={customerSort} onSort={sortCustomers} className="text-right" title="Automated CRM emails already sent: cart reminders, win-back, review requests, birthday vouchers" />
                        <SortTh label="Manual" k="manual" sort={customerSort} onSort={sortCustomers} className="text-right" title="Contacts the team logged by hand: DM, SMS, call, email by hand, other" />
                        <SortTh label="Last contacted" k="lastContacted" sort={customerSort} onSort={sortCustomers} title="The newest contact of any kind, Philippine date. Unknown when a source could not be read" />
                        <SortTh label="Consent" k="consent" sort={customerSort} onSort={sortCustomers} />
                        <SortTh label="Spend (year)" k="spend" sort={customerSort} onSort={sortCustomers} className="text-right" />
                        <SortTh label="Pet" k="pet" sort={customerSort} onSort={sortCustomers} />
                        <th className="px-2 py-2.5"><span className="sr-only">Log a contact</span></th>
                      </tr>
                    )}
                    {tab === 'pets' && (
                      <tr>
                        <SortTh label="Email" k="email" sort={petSort} onSort={sortPets} />
                        <SortTh label="Pet" k="pet" sort={petSort} onSort={sortPets} />
                        <th className={th}>Birthday</th>
                        <SortTh label="Next birthday" k="next" sort={petSort} onSort={sortPets} />
                        <SortTh
                          label={`Voucher ${thisYear}`}
                          k="status"
                          sort={petSort}
                          onSort={sortPets}
                          info={
                            <InfoPop label="What each voucher status means">
                              <p className="font-medium">This year&apos;s birthday voucher</p>
                              <p><b>Sent</b>: this year&apos;s voucher already went out. Hover it for when.</p>
                              <p><b>Upcoming</b>: the birthday is still ahead this year and no voucher has gone out yet.</p>
                              <p><b>Passed</b>: this year&apos;s birthday went by with no voucher sent. It will not send again until next year.</p>
                              <p className="text-muted-foreground">One voucher per customer per year. The CRM keeps one pet per customer here, so there is no primary-pet tag.</p>
                            </InfoPop>
                          }
                        />
                      </tr>
                    )}
                  </thead>
                  <tbody>
                    {tab === 'carts' &&
                      shown(cartRows).map((c) => {
                        const status = cartStatus(c);
                        return (
                          <tr key={c.shopifyCheckoutId} className="border-b last:border-0">
                            <td className="px-4 py-2.5">
                              <ProfileLink onOpen={open} owner={ownerOf(null, c.email)} tab="checkouts">{c.email ?? '—'}</ProfileLink>
                            </td>
                            <td className="px-4 py-2.5 text-right tabular-nums">{money(c.totalPrice, c.currency)}</td>
                            <td className="px-4 py-2.5 text-right tabular-nums">{c.items ?? '—'}</td>
                            <td className="px-4 py-2.5"><Stepper stage={c.stage} /></td>
                            <td className="whitespace-nowrap px-4 py-2.5 tabular-nums">
                              {remindersOf(c.remindersSent, reminderTotal)}
                              {c.lastReminderAt && <span className="block text-xs text-muted-foreground">Sent {fmtPh(c.lastReminderAt)}</span>}
                            </td>
                            <td className="px-4 py-2.5 text-xs text-muted-foreground">{fmtPh(c.winbackSentAt)}</td>
                            <td className="px-4 py-2.5">
                              <span className={cn(pill, STATUS_TONE[status])}>{status}</span>
                            </td>
                            <td className="px-4 py-2.5 text-xs text-muted-foreground">{fmtPh(c.createdAt ?? c.updatedAt)}</td>
                            <td className="px-2 py-1.5 text-right">
                              {c.abandonedCheckoutUrl ? <CopyButton text={c.abandonedCheckoutUrl} className="h-7 whitespace-nowrap">Copy link</CopyButton> : <span className="text-xs text-muted-foreground">—</span>}
                            </td>
                          </tr>
                        );
                      })}
                    {tab === 'orders' &&
                      shown(orderRows).map((o) => (
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
                          <td className="px-4 py-2.5 text-right tabular-nums">{money(o.totalPrice, o.currency)}</td>
                          <td className="px-4 py-2.5">
                            <Badge variant={o.financialStatus === 'paid' ? 'default' : 'secondary'}>
                              {o.financialStatus ?? 'unknown'}
                            </Badge>
                          </td>
                          <td className="whitespace-nowrap px-4 py-2.5 text-xs text-muted-foreground">{fmtPh(o.createdAt)}</td>
                          <td className="whitespace-nowrap px-4 py-2.5 text-xs tabular-nums text-muted-foreground">{turnaround(o.createdAt, o.fulfilledAt)}</td>
                          <td className="whitespace-nowrap px-4 py-2.5 text-xs text-muted-foreground">{fmtPh(o.fulfilledAt)}</td>
                          <td className="whitespace-nowrap px-4 py-2.5 text-xs text-muted-foreground">{fmtPh(o.reviewRequestSentAt)}</td>
                          <td className="px-4 py-2.5">
                            {o.reviewSubmittedAt ? (
                              <span className={cn(pill, STATUS_TONE.Recovered)} title={`Reviewed ${fmtPh(o.reviewSubmittedAt)}`}>Reviewed</span>
                            ) : (
                              <span className={cn(pill, STATUS_TONE.Converted)}>Pending</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    {tab === 'customers' &&
                      shown(customerList).map((c) => (
                        <tr key={c.shopifyCustomerId} className="border-b last:border-0">
                          <td className="px-4 py-2.5">
                            <ProfileLink onOpen={open} owner={c} className="font-medium">{nameOf(c) || '—'}</ProfileLink>
                          </td>
                          <td className="px-4 py-2.5">
                            <ProfileLink onOpen={open} owner={c}>{c.email ?? '—'}</ProfileLink>
                          </td>
                          <td className="whitespace-nowrap px-4 py-2.5 text-xs text-muted-foreground">{fmtPhDate(c.createdAt)}</td>
                          <td className="px-4 py-2.5">
                            <span className="text-xs capitalize text-muted-foreground">
                              {c.membershipTier ?? 'guest'}
                            </span>
                          </td>
                          <td className="px-4 py-2.5"><ToPlatinum row={c} threshold={membership.platinumThreshold} /></td>
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
                    {tab === 'pets' &&
                      shown(petList).map((p) => (
                        <tr key={p.shopifyCustomerId} className="border-b last:border-0">
                          <td className="px-4 py-2.5">
                            <ProfileLink onOpen={open} owner={ownerOf(p.shopifyCustomerId, p.email)} tab="pets">{p.email ?? '—'}</ProfileLink>
                          </td>
                          <td className="px-4 py-2.5">{p.petName ?? <span className="text-muted-foreground">—</span>}</td>
                          <td className="whitespace-nowrap px-4 py-2.5 text-xs text-muted-foreground">{birthdayLabel(p.petBirthday)}</td>
                          <td className="whitespace-nowrap px-4 py-2.5 tabular-nums">{nextLabel(p.nextDays)}</td>
                          <td className="px-4 py-2.5"><VoucherStatus p={p} read={birthdayVouchers !== null} /></td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>

              {/* Mobile (below md): the same rows as scannable cards. Same data
                  and order as the table; the desktop table is hidden under md. */}
              <ul className="divide-y divide-border md:hidden">
                {tab === 'carts' &&
                  shown(cartRows).map((c) => {
                    const status = cartStatus(c);
                    return (
                      <li key={c.shopifyCheckoutId} className="px-4 py-3">
                        <div className="flex items-start justify-between gap-3">
                          <ProfileLink onOpen={open} owner={ownerOf(null, c.email)} tab="checkouts" className="min-w-0 flex-1 truncate text-sm font-medium">
                            {c.email ?? '—'}
                          </ProfileLink>
                          <span className={cn('shrink-0', pill, STATUS_TONE[status])}>{status}</span>
                        </div>
                        <div className="mt-1 flex items-baseline gap-2">
                          <span className="text-base font-semibold tabular-nums">{money(c.totalPrice, c.currency)}</span>
                          {c.items !== undefined && <span className="text-xs text-muted-foreground">{c.items} item{c.items === 1 ? '' : 's'}</span>}
                        </div>
                        <div className="mt-1.5"><Stepper stage={c.stage} /></div>
                        <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground">
                          <div className="flex justify-between gap-2">
                            <dt>Reminders</dt>
                            <dd className="tabular-nums text-foreground">{remindersOf(c.remindersSent, reminderTotal)}</dd>
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
                        {c.abandonedCheckoutUrl && <CopyButton text={c.abandonedCheckoutUrl} className="mt-2.5">Copy recovery link</CopyButton>}
                      </li>
                    );
                  })}
                {tab === 'orders' &&
                  shown(orderRows).map((o) => (
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
                        <div className="flex justify-between gap-2">
                          <dt>Fulfilled</dt>
                          <dd>{fmtPh(o.fulfilledAt)}</dd>
                        </div>
                        <div className="flex justify-between gap-2">
                          <dt>Review sent</dt>
                          <dd>{fmtPh(o.reviewRequestSentAt)}</dd>
                        </div>
                        <div className="col-span-2 flex justify-between gap-2">
                          <dt>Reviewed</dt>
                          <dd className="text-foreground">{o.reviewSubmittedAt ? fmtPh(o.reviewSubmittedAt) : 'Pending'}</dd>
                        </div>
                      </dl>
                    </li>
                  ))}
                {tab === 'customers' &&
                  shown(customerList).map((c) => (
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
                      {(c.membershipTier === 'gold' || c.membershipTier === 'platinum') && (
                        <div className="mt-2"><ToPlatinum row={c} threshold={membership.platinumThreshold} /></div>
                      )}
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
                        <div className="flex flex-col">
                          <dt>Member since</dt>
                          <dd className="tabular-nums text-foreground">{fmtPhDate(c.createdAt)}</dd>
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
                {tab === 'pets' &&
                  shown(petList).map((p) => (
                    <li key={p.shopifyCustomerId} className="flex items-center justify-between gap-3 px-4 py-3">
                      <div className="min-w-0">
                        <div className="text-sm font-medium">{p.petName ?? 'Unnamed pet'}</div>
                        <div className="truncate text-xs text-muted-foreground">
                          <ProfileLink onOpen={open} owner={ownerOf(p.shopifyCustomerId, p.email)} tab="pets">{p.email ?? '—'}</ProfileLink>
                        </div>
                        <div className="mt-0.5 text-xs text-muted-foreground">
                          {birthdayLabel(p.petBirthday)} · {nextLabel(p.nextDays)}
                        </div>
                      </div>
                      <VoucherStatus p={p} read={birthdayVouchers !== null} />
                    </li>
                  ))}
              </ul>
              </>
            )}
          </CardContent>
        </Card>

        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-4">
            <p className="text-xs tabular-nums text-muted-foreground">
              Showing {total ? (safePage - 1) * per + 1 : 0}–{Math.min(safePage * per, total)} of {total}
            </p>
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              Rows
              <select
                value={per}
                onChange={(e) => onFilter((n: number) => setPerPage((cur) => ({...cur, [tab]: n})), Number(e.target.value))}
                aria-label="Rows per page"
                className="h-8 rounded-lg border border-border bg-background px-2 text-xs text-foreground outline-none focus-visible:border-primary"
              >
                {PAGE_SIZES.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <Pagination page={safePage} pageCount={pageCount} onPage={setPage} label="Table pagination" />
        </div>
      </section>

      {profileId !== null && (
        <CustomerProfile
          row={profileRow}
          orders={orders}
          checkouts={checkouts}
          birthdayVouchers={birthdayVouchers}
          membershipEvents={membershipEvents}
          contacts={contacts}
          membership={membership}
          now={nowDate}
          viewer={viewer}
          initialTab={profileAt.tab}
          openOrderId={profileAt.orderId}
          paused={logFor !== null}
          onClose={closeProfile}
          onLogContact={setLogFor}
          reminderTotal={reminderTotal}
        />
      )}
      {logFor && <ContactLogDialog name={nameOf(logFor)} email={logFor.email} history={historyOf(logFor)} viewer={viewer} onClose={() => setLogFor(null)} />}
    </div>
  );
}
