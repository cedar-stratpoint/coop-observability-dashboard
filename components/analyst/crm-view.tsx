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
//
// RET-10 (9A): the Cohort menu replaces the preset buttons. Built in (All, Repeat promo, Win-back) still list through inAudience,
// exactly as before; saved cohorts (customer_cohorts) are grouped by their group with live counts, and members come from
// matchesCohort on these same rows, every render (nothing stored, nothing tagged by hand). The cohort bar says the rule as a
// sentence, the repeat buyer rate against the 25% target and who saved it; the Cohorts column and the profile show each
// customer's labels with the rule on hover. cohorts null (table not applied, mock mode) = saved cohorts "unavailable".
import {instagramUrl} from '@/src/instagram';
import {downloadCsv} from '@/src/csv';
import dynamic from 'next/dynamic';
import {useRouter, useSearchParams} from 'next/navigation';
import {useCallback, useEffect, useMemo, useRef, useState, useTransition} from 'react';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  CircleAlert,
  CircleCheck,
  Clock,
  Crown,
  Link2,
  Mail,
  MailCheck,
  MessageSquarePlus,
  Pencil,
  PawPrint,
  Plus,
  Receipt,
  Repeat2,
  RotateCcw,
  ShoppingCart,
  Sparkles,
  Trash2,
  Users,
} from 'lucide-react';
import {Card, CardContent} from '@/components/ui/card';
import {Badge} from '@/components/ui/badge';
import {cn} from '@/lib/utils';
import {Metric} from './metric';
import {RefreshControl} from './refresh-control';
import {ContactLogDialog} from './contact-log-dialog';
import {FilterSelect} from './filter-select';
import {CohortBuilderDialog, blankDraft, draftFromProposal, draftOf, type CohortDraft} from './cohort-builder-dialog';
import {CohortDraftCard, type CohortDraftValue} from './cohort-draft-card';
import {useCoopChat} from './coop-chat';
import {CohortChip, CopyButton, CustomerProfile, PET_TONE, STATUS_TONE, Stepper, type ProfileTab} from './customer-profile';
import {InfoPop} from './info-tip';
import {Eyebrow} from './sections';
import {Pagination} from './pagination';
import type {ChartBlock} from '@/src/chat/block-types';
import {
  BUILTIN_COHORT_RULES,
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
  voucherOptions,
  filterOrders,
  fmtPh,
  fmtPhDate,
  lastContactLabel,
  matchesCohort,
  membershipWindowStart,
  money,
  newBuyersByMonth,
  peso,
  repeatRate,
  ruleText,
  textMatch,
  tierCounts,
  turnaround,
  bdayVoucherText,
  withVoucherFacts,
  BUILTIN_RULE_COHORTS,
  voucherLabels,
  voucherUseText,
  EMPTY_CART_FILTER,
  EMPTY_CUSTOMER_FILTER,
  EMPTY_ORDER_FILTER,
  type CustomerAudience,
  type CustomerRow,
  type VoucherUse,
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
import {loggableKeys, type CustomerContact} from '@/src/customer-contacts';
import {cohortLabel, cohortPreview, cohortSuggestions, cohortsOf, compareCohorts, type CustomerCohort} from '@/src/customer-cohorts';
import {deleteCohort} from '@/src/customer-cohorts-actions';
import {refreshCrm} from '@/src/crm-actions';
import {unlinkPeople} from '@/src/customer-links-actions';
import {boothCell, boothText, instagramState, matchesInstagramFilter, type CustomerBooth, type InstagramFilter} from '@/src/customer-links';
import {ROUTE_LABEL, matchesPawsportFilter, pawsportState, petText, type PawsportBadge, type PawsportFilter, type PawsportRead} from '@/src/pawsport';
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

/** The built-in cohorts (RET-03 audiences), listed through inAudience exactly as before 9A. */
const BUILTINS: Array<{key: Exclude<CustomerAudience, 'all'>; label: string}> = [
  {key: 'repeat_promo', label: 'Repeat promo'},
  {key: 'win_back', label: 'Win-back'},
];
/** The Cohort menu's value: 'all', a built-in audience, a built-in rule cohort (RET-13A, listed through matchesCohort), or `cohort:<id>` for a saved one. */
type CohortSel = 'all' | Exclude<CustomerAudience, 'all'> | (typeof BUILTIN_RULE_COHORTS)[number]['key'] | `cohort:${string}`;
const savedSel = (id: string): CohortSel => `cohort:${id}`;


type Tab = 'customers' | 'carts' | 'orders' | 'pets';

const TABS: Array<{key: Tab; label: string; icon: React.ComponentType<{className?: string}>}> = [
  {key: 'customers', label: 'Customers', icon: Users},
  {key: 'carts', label: 'Abandoned checkouts', icon: RotateCcw},
  {key: 'orders', label: 'Orders', icon: Receipt},
  {key: 'pets', label: 'Pet birthdays', icon: PawPrint},
];


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

/** RET-11: one chip per code (labels deduplicated, most used first, ×N when used more than once); each use's order and date on hover. */
function VoucherChips({uses}: {uses: VoucherUse[] | null | undefined}) {
  if (!uses) return <span className="text-xs text-muted-foreground" title="Unknown: the orders list was not read">unknown</span>;
  if (!uses.length) return <span className="text-xs text-muted-foreground">—</span>;
  return (
    <span className="flex min-w-[11rem] max-w-[16rem] flex-wrap gap-1">
      {voucherLabels(uses).map((v) => (
        <span
          key={v.label}
          title={v.uses.map(voucherUseText).join('\n')}
          className="inline-flex max-w-full items-center overflow-hidden rounded-md border border-border bg-card text-[11px] leading-5 whitespace-nowrap"
        >
          <span className="truncate px-1.5 text-foreground">{v.label}</span>
          {v.uses.length > 1 && <span className="bg-muted px-1.5 tabular-nums text-muted-foreground">×{v.uses.length}</span>}
          <span className="sr-only">: {v.uses.map(voucherUseText).join('; ')}</span>
        </span>
      ))}
    </span>
  );
}

/** RET-15 Slice B: the Instagram cell. A linked handle carries a link marker and, for the person who linked it, an Unlink button. */
function InstagramCell({found, read, linkId, onUnlink, busy}: {found: CustomerBooth | undefined; read: {leads: boolean; links: boolean}; linkId: string | null; onUnlink: (id: string) => void; busy: boolean}) {
  const cell = boothCell(found, read);
  if (cell === 'unknown') return <span className="text-xs text-muted-foreground" title="Unknown: the booth leads or the Same person links could not be read">unknown</span>;
  if (cell === 'none') return <span className="text-xs text-muted-foreground">—</span>;
  return (
    <span className="flex flex-wrap items-center gap-1.5 text-xs">
      {cell.instagram ? (instagramUrl(cell.instagram) ? <a href={instagramUrl(cell.instagram)!} target="_blank" rel="noopener noreferrer" className="text-primary underline underline-offset-2" title="Open their Instagram to message them (nothing is sent from Coop)">@{cell.instagram}</a> : <span className="text-foreground">@{cell.instagram}</span>) : <span className="text-muted-foreground">—</span>}
      {cell.source === 'linked' && (
        <span className="inline-flex items-center gap-1 text-muted-foreground" title="Linked by hand with Same person in Ask Coop. The customer's own record is unchanged.">
          <Link2 className="size-3" aria-hidden />
          <span className="sr-only">Linked by hand</span>
          {linkId && (
            <button type="button" disabled={busy} onClick={() => onUnlink(linkId)} className="rounded px-1 underline underline-offset-2 hover:text-foreground disabled:opacity-50">
              Unlink
            </button>
          )}
        </span>
      )}
    </span>
  );
}

type PawsportReadState = {status: PawsportRead['status']; incomplete: boolean};

/** RET-18 P1: the PawSport cell: number, pet and how they joined. Unavailable / unknown is never "—" (unknown is never "none"). */
function PawsportCell({badge, read}: {badge: PawsportBadge | undefined; read: PawsportReadState}) {
  const state = pawsportState(badge, read);
  if (state === 'unknown')
    return (
      <span className="text-xs text-muted-foreground" title={read.status === 'ok' ? 'Unknown: the PawSport list was cut off before this customer could be checked' : 'Unavailable: Shopify could not be read through the CRM'}>
        {read.status === 'ok' ? 'unknown' : 'Unavailable'}
      </span>
    );
  if (!badge) return <span className="text-xs text-muted-foreground">—</span>;
  const pet = petText(badge.pet);
  return (
    <span className="flex min-w-[9rem] flex-col gap-0.5 text-xs">
      <span className="flex items-center gap-1.5 whitespace-nowrap">
        <span className="font-medium tabular-nums text-foreground">{badge.number ?? 'No number'}</span>
        <span className="rounded-md border border-border bg-card px-1.5 text-[11px] leading-5 text-muted-foreground" title="How they joined: the printed QR, the /pawsport form, or My Account">
          {ROUTE_LABEL[badge.route]}
        </span>
      </span>
      {pet && <span className="truncate text-muted-foreground">{pet}</span>}
    </span>
  );
}

/** RET-15 Slice B: the Booth cell, one chip per lead: campaign, prize, pet. */
function BoothChips({found, read}: {found: CustomerBooth | undefined; read: {leads: boolean; links: boolean}}) {
  const cell = boothCell(found, read);
  if (cell === 'unknown') return <span className="text-xs text-muted-foreground" title="Unknown: the booth leads or the Same person links could not be read">unknown</span>;
  if (cell === 'none') return <span className="text-xs text-muted-foreground">—</span>;
  return (
    <span className="flex min-w-[11rem] max-w-[16rem] flex-wrap gap-1">
      {cell.booth.map((b, i) => (
        <span key={i} className="inline-flex max-w-full items-center overflow-hidden rounded-md border border-border bg-card px-1.5 text-[11px] leading-5 whitespace-nowrap">
          <span className="truncate text-foreground">{boothText(b) || 'Booth lead'}</span>
        </span>
      ))}
    </span>
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
  cohorts,
  booth,
  boothRead,
  pawsport,
  pawsportRead,
  viewer,
  contactLogLegacy = false,
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
  /** RET-10 saved cohorts (rules only); null when the table is not set up here or could not be read: shown as unavailable. */
  cohorts: CustomerCohort[] | null;
  /** RET-15 Slice B: per customer email, the Instagram + booth metadata from exact matches and saved "Same person" links (computed on the server). */
  booth: Record<string, CustomerBooth>;
  /** Whether the booth leads and the links were read; when not, a customer with nothing found reads "unknown", never "—". */
  boothRead: {leads: boolean; links: boolean};
  /** RET-18 P1: per shopifyCustomerId, the customer's PawSport (matched on the server by Shopify id, email, then mobile). */
  pawsport: Record<string, PawsportBadge>;
  /** Whether Shopify was read (fully): when not, a customer without a match reads "Unavailable" / "unknown", never "—". */
  pawsportRead: PawsportReadState;
  /** The signed-in email: the log shows Delete only on this person's own contacts. */
  viewer: string | null;
  /** RET-17: the log was read without the Instagram / mobile / replied columns (SQL not applied): the Log dialog logs by email only. */
  contactLogLegacy?: boolean;
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
  const [cohortSel, setCohortSel] = useState<CohortSel>('all');
  const [builder, setBuilder] = useState<CohortDraft | null>(null);
  // RET-10 9B: a one-click suggestion opened as a draft on the page, and the "Describe a cohort" sentence for Ask Coop.
  const [pageDraft, setPageDraft] = useState<CohortDraftValue | null>(null);
  const [describe, setDescribe] = useState('');
  const {ask} = useCoopChat();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [cohortMsg, setCohortMsg] = useState<string | null>(null);
  const [deleting, startDelete] = useTransition();
  const [unlinking, startUnlink] = useTransition();
  const boothOf = (c: CustomerRow): CustomerBooth | undefined => booth[(c.email ?? '').trim().toLowerCase()];
  // Owner 2026-11-25: "filter na has Instagram". Kept apart from CustomerFilter: the handle comes from the page's booth map, not the CRM row.
  const [igFilter, setIgFilter] = useState<InstagramFilter>('all');
  // RET-18 P1: PawSport All / Has / None; disabled when Shopify could not be read (never "None" on an unknown).
  const [psFilter, setPsFilter] = useState<PawsportFilter>('all');
  const pawsportOf = (c: {shopifyCustomerId: string}): PawsportBadge | undefined => pawsport[c.shopifyCustomerId];
  // The filter in effect: 'all' while Shopify is unreadable, so a choice made before (a stale "Has") never empties the list.
  const psEffective: PawsportFilter = pawsportRead.status === 'ok' ? psFilter : 'all';
  // The viewer can only unlink a link they made (the action checks again).
  const myLinkId = (c: CustomerRow): string | null => (viewer === null ? null : (boothOf(c)?.links.find((l) => l.createdBy === viewer)?.id ?? null));
  const unlink = (id: string) =>
    startUnlink(async () => {
      const r = await unlinkPeople(id);
      setCohortMsg(r.ok ? 'Unlinked. The customer keeps their own record; only the Instagram and Booth details went.' : r.error);
    });
  // Vince's defaults: newest abandoned and newest placed first, soonest birthday first. Customers keep their list order until sorted.
  const [cartSort, setCartSort] = useState<Sort<CartSortKey> | null>({key: 'abandoned', dir: 'desc'});
  const [orderSort, setOrderSort] = useState<Sort<OrderSortKey> | null>({key: 'placed', dir: 'desc'});
  const [customerSort, setCustomerSort] = useState<Sort<CustomerSortKey> | null>(null);
  const [petSort, setPetSort] = useState<Sort<PetSortKey> | null>({key: 'next', dir: 'asc'});
  const [logFor, setLogFor] = useState<CustomerRow | null>(null);
  const needle = q.trim().toLowerCase();
  // The open profile lives in the URL; the tab and order it opens on are this page's state.
  const searchParams = useSearchParams();
  const router = useRouter();
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

  // RET-10 9B: Ask Coop's draft block links here. `?cohort_draft=` (Adjust the rule) opens the builder on that draft; `?cohort=<id>` (after
  // Save) selects the saved cohort. Both are read once and removed from the address, so a refresh does not reopen them. The draft is
  // untrusted input: draftFromProposal re-validates the rule, and the save action validates everything again.
  const draftParam = searchParams.get('cohort_draft');
  const cohortParam = searchParams.get('cohort');
  useEffect(() => {
    if (draftParam === null && cohortParam === null) return;
    if (draftParam !== null) {
      try {
        setTab('customers');
        setBuilder(draftFromProposal(JSON.parse(draftParam) as Record<string, unknown>));
      } catch {
        /* a broken link opens nothing */
      }
    }
    if (cohortParam !== null && (cohorts ?? []).some((c) => c.id === cohortParam)) {
      setTab('customers');
      setCohortSel(savedSel(cohortParam));
      setPage(1);
    }
    const p = new URLSearchParams(window.location.search);
    p.delete('cohort_draft');
    p.delete('cohort');
    const qs = p.toString();
    window.history.replaceState(null, '', `${window.location.pathname}${qs ? `?${qs}` : ''}`);
  }, [draftParam, cohortParam, cohorts]);
  const askCoop = () => {
    const text = describe.trim();
    if (!text) return;
    ask(`Make a cohort: ${text}`);
    setDescribe('');
  };

  // A saved cohort that is gone (deleted, or the read failed) falls back to All rather than an empty list.
  const savedCohort = cohortSel.startsWith('cohort:') ? (cohorts?.find((c) => savedSel(c.id) === cohortSel) ?? null) : null;
  const preset: CustomerAudience = cohortSel === 'repeat_promo' || cohortSel === 'win_back' ? cohortSel : 'all';
  // RET-13A: a built-in that is a rule on a cohort field; it lists through matchesCohort like a saved cohort does.
  const ruleBuiltin = BUILTIN_RULE_COHORTS.find((b) => b.key === cohortSel) ?? null;
  const cohortOn = preset !== 'all' || savedCohort !== null || ruleBuiltin !== null;
  const filtersOn =
    tab === 'carts'
      ? filterActive(cartFilter)
      : tab === 'orders'
        ? filterActive(orderFilter)
        : tab === 'customers'
          ? filterActive(customerFilter) || cohortOn || igFilter !== 'all' || psEffective !== 'all'
          : petFilter !== 'all';
  const clearFilters = () => {
    if (tab === 'carts') setCartFilter(EMPTY_CART_FILTER);
    else if (tab === 'orders') setOrderFilter(EMPTY_ORDER_FILTER);
    else if (tab === 'customers') {
      setCustomerFilter(EMPTY_CUSTOMER_FILTER);
      setCohortSel('all');
      setIgFilter('all');
      setPsFilter('all');
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
    const rows = customerRows(enriched, tally, nowDate, {automated: checkouts !== null && birthdayVouchers !== null && membershipEvents !== null, manual: contacts !== null});
    // RET-11 / RET-13A: the codes each customer redeemed and this year's birthday voucher (one helper, shared with Ask Coop).
    return withVoucherFacts(rows, orders, birthdayVouchers, nowDate);
  }, [customers, orders, checkouts, birthdayVouchers, membershipEvents, contacts, membership.programStart, nowDate]);
  // Each customer's logged contacts for the dialog, newest first (the read is already ordered that way).
  const contactsByEmail = useMemo(() => {
    const m = new Map<string, CustomerContact[]>();
    for (const c of contacts ?? []) if (c.email) m.set(c.email, [...(m.get(c.email) ?? []), c]); // RET-17: Instagram / mobile-only contacts have no email
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
  // RET-17 review: the Website CRM logs by email (history and counts here match by email); the phone rides along only with an email.
  const crmPerson = (c: CustomerRow) => ({email: c.email, instagram: null, mobile: c.email ? c.phone : null});
  const canLog = (c: CustomerRow): boolean => loggableKeys({email: c.email, instagram: null, mobile: null}).email !== null;
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
  const ruleBuiltinCounts = useMemo(() => new Map(BUILTIN_RULE_COHORTS.map((b) => [b.key, all.filter((r) => matchesCohort(r, b.rule)).length])), [all]);
  // Saved cohorts, sorted for the menu; their live counts; and each customer's labels (one evaluator: matchesCohort).
  const savedCohorts = useMemo(() => [...(cohorts ?? [])].sort(compareCohorts), [cohorts]);
  const cohortGroups = useMemo(() => {
    const m = new Map<string, CustomerCohort[]>();
    for (const c of savedCohorts) m.set(c.group, [...(m.get(c.group) ?? []), c]);
    return [...m.entries()];
  }, [savedCohorts]);
  const cohortCounts = useMemo(() => new Map(savedCohorts.map((c) => [c.id, all.filter((r) => matchesCohort(r, c.rule)).length])), [savedCohorts, all]);
  const cohortsByCustomer = useMemo(() => new Map(all.map((r) => [r.shopifyCustomerId, cohortsOf(r, savedCohorts)])), [all, savedCohorts]);
  const cohortsOfRow = (r: CustomerRow): CustomerCohort[] => cohortsByCustomer.get(r.shopifyCustomerId) ?? [];
  // RET-10 9B: first-order codes with buyers no saved cohort covers yet (RET-06's codeCohorts), as one-click drafts. Code counts the preview.
  const suggestions = useMemo(() => (cohorts === null ? [] : cohortSuggestions(all, savedCohorts).slice(0, 4)), [cohorts, all, savedCohorts]);
  const pagePreview = useMemo(() => (pageDraft ? cohortPreview(all, pageDraft.rule) : null), [pageDraft, all]);
  // Voucher filter: every code with buyers (any order), most buyers first, with its buyer count.
  const voucherChoices = useMemo(() => voucherOptions(all), [all]);
  // Pets need only the customer list (one pet per customer, as the CRM projects it).
  const pets = useMemo(() => petRows(customers ?? [], birthdayVouchers, nowDate), [customers, birthdayVouchers, nowDate]);

  const cartRows = useMemo(() => sortRows(filterCarts(checkouts ?? [], cartFilter, needle), cartSort, CART_SORT), [checkouts, cartFilter, needle, cartSort]);
  const orderRows = useMemo(() => sortRows(filterOrders(orders ?? [], orderFilter, needle), orderSort, ORDER_SORT), [orders, orderFilter, needle, orderSort]);
  const customerList = useMemo(() => {
    const audience = audienceRows(filterCustomers(all, customerFilter, needle), preset, nowDate);
    const rule = savedCohort?.rule ?? ruleBuiltin?.rule ?? null;
    const ruled = rule ? audience.filter((r) => matchesCohort(r, rule)) : audience;
    const igListed = igFilter === 'all' ? ruled : ruled.filter((r) => matchesInstagramFilter(igFilter, instagramState(booth[(r.email ?? '').trim().toLowerCase()], boothRead)));
    const listed = psEffective === 'all' ? igListed : igListed.filter((r) => matchesPawsportFilter(psEffective, pawsportState(pawsport[r.shopifyCustomerId], pawsportRead)));
    return customerSort === null ? listed : sortRows(listed, customerSort, CUSTOMER_SORT);
  }, [all, customerFilter, needle, preset, savedCohort, ruleBuiltin, nowDate, customerSort, igFilter, booth, boothRead, psEffective, pawsport, pawsportRead]);
  const igCount = useMemo(() => all.filter((r) => instagramState(booth[(r.email ?? '').trim().toLowerCase()], boothRead) === 'has').length, [all, booth, boothRead]);
  const psCounts = useMemo(() => {
    const n = {has: 0, none: 0, unknown: 0};
    for (const r of all) n[pawsportState(pawsport[r.shopifyCustomerId], pawsportRead)] += 1;
    return n;
  }, [all, pawsport, pawsportRead]);
  // The cohort bar: everyone in the selected cohort (search and the other filters aside), their repeat buyer rate and the rule.
  const cohortBar = useMemo(() => {
    if (!cohortOn) return null;
    const rule = savedCohort?.rule ?? ruleBuiltin?.rule ?? null;
    const members = rule ? all.filter((r) => matchesCohort(r, rule)) : audienceRows(all, preset, nowDate);
    const builtin = ruleBuiltin ?? BUILTINS.find((b) => b.key === preset);
    return {
      label: savedCohort ? cohortLabel(savedCohort) : `Built in · ${builtin?.label ?? ''}`,
      count: members.length,
      rate: repeatRate(members.map((r) => r.orderCount)),
      sentence: ruleText(rule ?? BUILTIN_COHORT_RULES[preset as Exclude<CustomerAudience, 'all'>]),
    };
  }, [cohortOn, savedCohort, ruleBuiltin, all, preset, nowDate]);
  const cohortName = savedCohort ? cohortLabel(savedCohort) : (ruleBuiltin?.label ?? preset);
  const removeCohort = () => {
    if (!savedCohort) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setCohortMsg(null);
    startDelete(async () => {
      const res = await deleteCohort(savedCohort.id);
      setConfirmDelete(false);
      if (res.ok) {
        setCohortSel('all');
        setCohortMsg(`${cohortLabel(savedCohort)} deleted.`);
        router.refresh();
      } else setCohortMsg(res.error);
    });
  };
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
      const name = savedCohort ? 'crm-customers-cohort' : ruleBuiltin ? `crm-customers-${ruleBuiltin.key.replace('_', '-')}` : preset === 'all' ? 'crm-customers' : `crm-customers-${preset.replace('_', '-')}`;
      const note = filterNote([['Cohort', cohortOn ? cohortName : 'all'], ['Tier', customerFilter.tier], ['Bought', customerFilter.buyers], ['Voucher', customerFilter.voucher ?? 'all'], ['Instagram', igFilter]], q);
      downloadCsv(`${name} (${customerList.length}).csv`, customerCsv(customerList, asOf, note, membership.platinumThreshold, name, ruleBuiltin !== null, {map: new Map(Object.entries(booth)), read: boothRead}));
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
        ? tab === 'customers' && cohortOn && !filterActive(customerFilter)
          ? 'No one fits this cohort right now.'
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
              placeholder={tab === 'pets' ? 'Search email or pet' : tab === 'customers' ? 'Search name, email or code' : 'Search email, order # or name'}
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
              {/* The Cohort menu (RET-10): native select with a group per cohort group, like the other filters, so it works on a phone. */}
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                Cohort
                <select
                  value={savedCohort || preset !== 'all' || ruleBuiltin ? cohortSel : 'all'}
                  onChange={(e) => {
                    setConfirmDelete(false);
                    setCohortMsg(null);
                    onFilter(setCohortSel, e.target.value as CohortSel);
                  }}
                  className={cn(
                    'h-8 max-w-[16rem] rounded-lg border bg-background px-2 text-xs text-foreground outline-none focus-visible:border-primary',
                    cohortOn ? 'border-primary text-primary' : 'border-border',
                  )}
                >
                  <optgroup label="Built in">
                    <option value="all">All customers</option>
                    {BUILTINS.map((b) => (
                      <option key={b.key} value={b.key}>
                        {b.label}
                        {customerRead ? ` (${presetCounts[b.key]})` : ''}
                      </option>
                    ))}
                    {BUILTIN_RULE_COHORTS.map((b) => (
                      <option key={b.key} value={b.key}>
                        {b.label}
                        {customerRead ? ` (${birthdayVouchers === null || orders === null ? 'unknown' : (ruleBuiltinCounts.get(b.key) ?? 0)})` : ''}
                      </option>
                    ))}
                  </optgroup>
                  {cohorts === null ? (
                    <optgroup label="Saved cohorts">
                      <option disabled value="unavailable">Unavailable here</option>
                    </optgroup>
                  ) : (
                    cohortGroups.map(([group, list]) => (
                      <optgroup key={group} label={group}>
                        {list.map((c) => (
                          <option key={c.id} value={savedSel(c.id)}>
                            {c.name}
                            {customerRead ? ` (${cohortCounts.get(c.id) ?? 0})` : ''}
                          </option>
                        ))}
                      </optgroup>
                    ))
                  )}
                </select>
              </label>
              <button
                type="button"
                onClick={() => setBuilder(blankDraft())}
                disabled={cohorts === null || !customerRead}
                title={cohorts === null ? 'Saved cohorts are unavailable: cohorts are not set up in this environment' : !customerRead ? 'Unavailable: the CRM did not answer' : 'Save a rule as a cohort'}
                className="inline-flex h-8 items-center gap-1 rounded-lg border border-dashed border-primary/60 px-2.5 text-xs font-medium text-primary transition-[color,border-color,background-color,transform] duration-150 hover:bg-accent active:scale-[0.97] disabled:cursor-not-allowed disabled:border-border disabled:text-muted-foreground disabled:hover:bg-transparent"
              >
                <Plus className="size-3.5" /> New cohort
              </button>
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
                label="Voucher"
                value={customerFilter.voucher ?? 'all'}
                onChange={(voucher) => onFilter(setCustomerFilter, {...customerFilter, voucher})}
                options={[
                  ['all', 'All'],
                  ['any', 'Used a voucher'],
                  ['none', 'Bought, no voucher'],
                  ...voucherChoices.map(({code, buyers}): [string, string] => [code, `${code} · ${buyers}`]),
                ]}
              />
              <FilterSelect
                label="Instagram"
                value={igFilter}
                onChange={(v) => {
                  setIgFilter(v as InstagramFilter);
                  setPage(1);
                }}
                options={[
                  ['all', 'All'],
                  ['has', `Has Instagram · ${igCount}`],
                  ['none', 'No Instagram'],
                ]}
              />
              <FilterSelect
                label="PawSport"
                value={psEffective}
                disabled={pawsportRead.status !== 'ok'}
                title={pawsportRead.status !== 'ok' ? 'Unavailable: Shopify could not be read through the CRM' : pawsportRead.incomplete ? 'The PawSport list was cut off: customers not found read unknown and are in neither Has nor None' : undefined}
                onChange={(v) => {
                  setPsFilter(v as PawsportFilter);
                  setPage(1);
                }}
                options={
                  pawsportRead.status === 'ok'
                    ? [
                        ['all', 'All'],
                        ['has', `Has PawSport · ${psCounts.has}`],
                        ['none', `No PawSport · ${psCounts.none}`],
                        // A cut-off list (page cap or no cursor): the customers not checked are counted and can be listed, so the gap is visible.
                        ...(pawsportRead.incomplete ? ([['unknown', `Unknown · ${psCounts.unknown}`]] as Array<[string, string]>) : []),
                      ]
                    : [['all', 'Unavailable']]
                }
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
          {tab === 'customers' && cohorts !== null && customerRead && (
            <div className="flex basis-full flex-col gap-2">
              {/* RET-10 9B: describe it, don't build it. Ask Coop drafts the rule (propose_crm_cohort); the owner saves from its answer. */}
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  askCoop();
                }}
                className="flex flex-wrap items-center gap-2"
              >
                <input
                  value={describe}
                  onChange={(e) => setDescribe(e.target.value)}
                  maxLength={300}
                  placeholder="Describe a cohort, e.g. Circuit Makati buyers who haven't reordered"
                  aria-label="Describe a cohort for Ask Coop"
                  className="h-8 min-w-0 flex-[1_1_16rem] rounded-lg border border-dashed border-primary/60 bg-background px-2.5 text-xs text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-primary"
                />
                <button
                  type="submit"
                  disabled={!describe.trim()}
                  className="inline-flex h-8 items-center gap-1 rounded-lg bg-primary px-3 text-xs font-medium text-primary-foreground transition-[background-color,transform] duration-150 hover:bg-primary/90 active:scale-[0.97] disabled:opacity-50"
                >
                  <Sparkles className="size-3.5" aria-hidden /> Ask Coop
                </button>
              </form>
              {suggestions.length > 0 && !pageDraft && (
                <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                  <span className="inline-flex items-center gap-1">
                    <Sparkles className="size-3.5 text-primary" aria-hidden /> First-order codes not in a cohort yet:
                  </span>
                  {suggestions.map((s) => (
                    <button
                      key={s.code}
                      type="button"
                      onClick={() => setPageDraft(s.draft)}
                      className="inline-flex h-7 items-center rounded-md border border-dashed border-primary/60 bg-accent px-2 text-[11.5px] font-medium text-accent-foreground transition-[background-color,transform] duration-150 hover:bg-accent/70 active:scale-[0.97]"
                    >
                      {cohortLabel(s.draft)} · {s.buyers} buyer{s.buyers === 1 ? '' : 's'}
                    </button>
                  ))}
                </div>
              )}
              {pageDraft && pagePreview && (
                <CohortDraftCard
                  key={cohortLabel(pageDraft)}
                  draft={pageDraft}
                  preview={pagePreview}
                  intro="Suggested from a first-order code no cohort covers yet. Rename it (which event was it?), then save."
                  onAdjust={(d) => {
                    setPageDraft(null);
                    setBuilder(draftFromProposal(d));
                  }}
                  onDismiss={() => setPageDraft(null)}
                  onSaved={(id) => {
                    setPageDraft(null);
                    setCohortSel(savedSel(id));
                    setCohortMsg(null);
                    setPage(1);
                  }}
                />
              )}
            </div>
          )}
          {tab === 'customers' && cohortBar && (
            <div className="basis-full rounded-xl border border-border bg-[var(--card-warm)] px-4 py-3">
              <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-foreground">{cohortBar.label}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {cohortBar.sentence}. Philippine days; test orders never count.
                    {savedCohort && <> Saved by {viewer !== null && savedCohort.createdBy === viewer ? 'you' : savedCohort.createdBy}.</>}
                  </p>
                </div>
                {savedCohort && viewer !== null && savedCohort.createdBy === viewer && (
                  <div className="flex shrink-0 items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => setBuilder(draftOf(savedCohort))}
                      className="inline-flex h-7 items-center gap-1 rounded-md border px-2 text-xs font-medium text-muted-foreground transition-[color,border-color,transform] duration-150 hover:border-primary hover:text-foreground active:scale-[0.97]"
                    >
                      <Pencil className="size-3.5" /> Edit
                    </button>
                    <button
                      type="button"
                      onClick={removeCohort}
                      onBlur={() => setConfirmDelete(false)}
                      disabled={deleting}
                      aria-label={confirmDelete ? 'Confirm delete' : 'Delete this cohort'}
                      className={cn(
                        'inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs font-medium transition-[color,background-color,transform] duration-150 active:scale-[0.97] disabled:opacity-50',
                        confirmDelete ? 'bg-destructive/10 text-destructive' : 'text-muted-foreground hover:text-destructive',
                      )}
                    >
                      <Trash2 className="size-3.5" />
                      {confirmDelete ? 'Delete?' : null}
                    </button>
                  </div>
                )}
              </div>
              <div className="mt-2 flex flex-wrap items-baseline gap-x-5 gap-y-1 text-xs text-muted-foreground">
                <span>
                  <b className="font-semibold tabular-nums text-foreground">{cohortBar.count.toLocaleString()}</b> customer{cohortBar.count === 1 ? '' : 's'}
                </span>
                <span className="inline-flex items-center gap-1">
                  {cohortBar.rate.ratePct === null ? (
                    <>Repeat buyer rate: no buyers yet</>
                  ) : (
                    <>
                      {cohortBar.rate.ratePct >= REPEAT_TARGET_PCT ? (
                        <CircleCheck className="size-3.5 text-[var(--status-good)]" aria-hidden />
                      ) : (
                        <CircleAlert className="size-3.5 text-[var(--status-warn)]" aria-hidden />
                      )}
                      <span>
                        Repeat buyer rate{' '}
                        <b className="font-semibold tabular-nums text-foreground">
                          {cohortBar.rate.repeat} of {cohortBar.rate.buyers} buyers ({cohortBar.rate.ratePct.toFixed(1)}%)
                        </b>
                        , {cohortBar.rate.ratePct >= REPEAT_TARGET_PCT ? 'at or above' : 'below'} the {REPEAT_TARGET_PCT}% target
                      </span>
                    </>
                  )}
                </span>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                {preset !== 'all' && customerSort === null ? 'Listed by last order, oldest first. ' : ''}
                Check email consent before contacting anyone. Nothing is sent from here.
              </p>
            </div>
          )}
          {tab === 'customers' && cohortMsg && (
            <p role="status" className="basis-full text-xs text-muted-foreground">
              {cohortMsg}
            </p>
          )}
          {tab === 'customers' && cohorts === null && configured && (
            <p className="basis-full text-xs text-muted-foreground">Saved cohorts are unavailable here (not set up in this environment). The built-in lists still work.</p>
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
                        <SortTh label="Leave a review email" k="reviewSent" sort={orderSort} onSort={sortOrders} title="When the website sent the Leave a review email (automatic, after fulfillment)" />
                        <SortTh label="Reviewed" k="reviewed" sort={orderSort} onSort={sortOrders} />
                      </tr>
                    )}
                    {tab === 'customers' && (
                      <tr>
                        <SortTh label="Name" k="name" sort={customerSort} onSort={sortCustomers} />
                        <th className={th}>Contact</th>
                        <SortTh label="Email" k="email" sort={customerSort} onSort={sortCustomers} />
                        <th className={th} title="Saved cohorts this customer matches right now. Hover a label for its rule">Cohorts</th>
                        <SortTh label="Member since" k="memberSince" sort={customerSort} onSort={sortCustomers} title="When the customer record was created (PH date)" />
                        <SortTh label="Orders" k="orders" sort={customerSort} onSort={sortCustomers} className="text-right" />
                        <SortTh
                          label="Vouchers used"
                          k="vouchers"
                          sort={customerSort}
                          onSort={sortCustomers}
                          title="Discount codes redeemed on counted orders, most uses first. Hover a code for its orders"
                        />
                        <th className={th} title="Instagram from the booth lead with the same email or mobile, or one you linked with Same person in Ask Coop">Instagram</th>
                        <th className={th} title="Booth sign-up: campaign, prize, pet">Booth</th>
                        <th className={th} title="PawSport from Shopify (custom.pet_passport): number, pet, and how they joined (QR, Form or Account)">PawSport</th>
                        {ruleBuiltin && <th className={th} title="This year's birthday voucher: sent, not used (with its expiry), expired, or used">Birthday voucher</th>}
                        <SortTh label="First order" k="firstOrder" sort={customerSort} onSort={sortCustomers} />
                        <SortTh label="Last order" k="lastOrder" sort={customerSort} onSort={sortCustomers} />
                        <SortTh label="Days since" k="daysSince" sort={customerSort} onSort={sortCustomers} className="text-right" title="Philippine days since the last counted order" />
                        <SortTh label="Emails sent" k="emailsSent" sort={customerSort} onSort={sortCustomers} className="text-right" title="Automated CRM emails already sent: cart reminders, win-back, Leave a review emails, birthday vouchers" />
                        <SortTh label="Manual" k="manual" sort={customerSort} onSort={sortCustomers} className="text-right" title="Contacts the team logged by hand: DM, SMS, call, email by hand, other" />
                        <SortTh label="Last contacted" k="lastContacted" sort={customerSort} onSort={sortCustomers} title="The newest contact of any kind, Philippine date. Unknown when a source could not be read" />
                        <SortTh label="Consent" k="consent" sort={customerSort} onSort={sortCustomers} />
                        <SortTh label="Pet" k="pet" sort={customerSort} onSort={sortCustomers} />
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
                          <td className="px-2 py-1.5">
                            {/* Owner 2026-11-25: Log contact sits next to the name, not at the far right, and reads as a button.
                                RET-17 review: the Website CRM logs by email (its history and counts match by email), so no email = no Log. */}
                            {canLog(c) ? (
                            <button
                              type="button"
                              onClick={() => setLogFor(c)}
                              aria-label={`Log a contact with ${nameOf(c) || c.email || 'this customer'}`}
                              className="inline-flex items-center gap-1 whitespace-nowrap rounded-md border border-primary/40 bg-primary/5 px-2.5 py-1 text-[11px] font-semibold text-primary transition-[background-color,transform] duration-150 hover:bg-primary/10 active:scale-[0.97] motion-reduce:transition-none"
                            >
                              <MessageSquarePlus className="size-3.5" aria-hidden />
                              Log contact
                            </button>
                            ) : (
                              <span className="px-2.5 text-xs text-muted-foreground" title="No email address: a contact cannot be logged for this customer here">—</span>
                            )}
                          </td>
                          <td className="px-4 py-2.5">
                            <ProfileLink onOpen={open} owner={c}>{c.email ?? '—'}</ProfileLink>
                          </td>
                          <td className="px-4 py-2.5" title={cohorts === null ? 'Unavailable: saved cohorts are not set up here' : undefined}>
                            {cohortsOfRow(c).length ? (
                              <span className="flex max-w-[16rem] flex-wrap gap-1">
                                {cohortsOfRow(c).map((k) => (
                                  <CohortChip key={k.id} cohort={k} why={ruleText(k.rule)} />
                                ))}
                              </span>
                            ) : (
                              <span className="text-xs text-muted-foreground">—</span>
                            )}
                          </td>
                          <td className="whitespace-nowrap px-4 py-2.5 text-xs text-muted-foreground">{fmtPhDate(c.createdAt)}</td>
                          <td className="px-4 py-2.5 text-right tabular-nums">{c.orderCount}</td>
                          <td className="px-4 py-2.5"><VoucherChips uses={c.vouchers} /></td>
                          <td className="px-4 py-2.5"><InstagramCell found={boothOf(c)} read={boothRead} linkId={myLinkId(c)} onUnlink={unlink} busy={unlinking} /></td>
                          <td className="px-4 py-2.5"><BoothChips found={boothOf(c)} read={boothRead} /></td>
                          <td className="px-4 py-2.5"><PawsportCell badge={pawsportOf(c)} read={pawsportRead} /></td>
                          {ruleBuiltin && <td className="whitespace-nowrap px-4 py-2.5 text-xs text-muted-foreground">{bdayVoucherText(c.bdayVoucher)}</td>}
                          <td className="whitespace-nowrap px-4 py-2.5 text-xs text-muted-foreground">{fmtPhDate(c.firstOrderAt)}</td>
                          <td className="whitespace-nowrap px-4 py-2.5 text-xs text-muted-foreground">{fmtPhDate(c.lastOrderAt)}</td>
                          <td className="px-4 py-2.5 text-right tabular-nums">{c.daysSinceLastOrder ?? '—'}</td>
                          <td className="px-4 py-2.5 text-right tabular-nums" title={c.emailsSent === null ? 'Unknown: a CRM source did not answer' : undefined}>
                            {c.emailsSent ?? '—'}
                          </td>
                          <td className="px-4 py-2.5 text-right tabular-nums" title={c.manualContacts === null ? 'Unavailable: the contact log is not set up here' : undefined}>
                            {c.manualContacts ?? '—'}
                          </td>
                          <td className="whitespace-nowrap px-2 py-1.5 text-xs text-muted-foreground">
                            {/* RET-17 (owner 2026-11-25): click Last contacted to log a contact on a chosen day. Automated emails stay read-only. */}
                            {canLog(c) ? (
                            <button
                              type="button"
                              onClick={() => setLogFor(c)}
                              title={c.lastContactKnown ? 'Log a contact, on the day it happened. Automated emails stay as they are.' : 'Unknown: a CRM source or the contact log did not answer. Click to log a contact.'}
                              aria-label={`Last contacted ${lastContactLabel(c)}. Log a contact with ${nameOf(c) || c.email || 'this customer'}`}
                              className="rounded-md px-2 py-1 text-left underline decoration-dotted decoration-muted-foreground/50 underline-offset-[3px] transition-[color,background-color] duration-150 hover:bg-primary/5 hover:text-foreground hover:decoration-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                            >
                              {lastContactLabel(c)}
                              {c.lastContactKind && <span className="block no-underline">{CONTACT_KIND_LABEL[c.lastContactKind]}</span>}
                            </button>
                            ) : (
                              <span className="block px-2 py-1" title={c.lastContactKnown ? undefined : 'Unknown: a CRM source or the contact log did not answer'}>
                                {lastContactLabel(c)}
                                {c.lastContactKind && <span className="block">{CONTACT_KIND_LABEL[c.lastContactKind]}</span>}
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-2.5 text-xs text-muted-foreground">{c.consent.replace(/_/g, ' ')}</td>
                          <td className="px-4 py-2.5 text-xs text-muted-foreground">{c.petName ?? '—'}</td>
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
                          <dt>Leave a review email</dt>
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
                      </div>
                      <div className="mt-0.5 truncate text-xs text-muted-foreground">
                        <ProfileLink onOpen={open} owner={c}>{c.email ?? '—'}</ProfileLink>
                      </div>
                      {cohortsOfRow(c).length > 0 && (
                        <div className="mt-1.5 flex flex-wrap gap-1">
                          {cohortsOfRow(c).map((k) => (
                            <CohortChip key={k.id} cohort={k} why={ruleText(k.rule)} />
                          ))}
                        </div>
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
                          <dt>Pet</dt>
                          <dd className="text-foreground">{c.petName ?? '—'}</dd>
                        </div>
                        <div className="flex flex-col">
                          <dt>Member since</dt>
                          <dd className="tabular-nums text-foreground">{fmtPhDate(c.createdAt)}</dd>
                        </div>
                        <div className="col-span-3 flex justify-between gap-2">
                          <dt>Vouchers used</dt>
                          <dd><VoucherChips uses={c.vouchers} /></dd>
                        </div>
                        <div className="col-span-3 flex justify-between gap-2">
                          <dt>Instagram</dt>
                          <dd><InstagramCell found={boothOf(c)} read={boothRead} linkId={myLinkId(c)} onUnlink={unlink} busy={unlinking} /></dd>
                        </div>
                        <div className="col-span-3 flex justify-between gap-2">
                          <dt>Booth</dt>
                          <dd><BoothChips found={boothOf(c)} read={boothRead} /></dd>
                        </div>
                        <div className="col-span-3 flex justify-between gap-2">
                          <dt>PawSport</dt>
                          <dd><PawsportCell badge={pawsportOf(c)} read={pawsportRead} /></dd>
                        </div>
                        {ruleBuiltin && (
                          <div className="col-span-3 flex justify-between gap-2">
                            <dt>Birthday voucher</dt>
                            <dd className="text-foreground">{bdayVoucherText(c.bdayVoucher)}</dd>
                          </div>
                        )}
                        <div className="col-span-3 flex justify-between gap-2">
                          <dt>Last contacted</dt>
                          <dd className="text-foreground">
                            {lastContactLabel(c)}
                            {c.lastContactKind && <span className="text-muted-foreground"> · {CONTACT_KIND_LABEL[c.lastContactKind]}</span>}
                          </dd>
                        </div>
                      </dl>
                      {canLog(c) && <button
                        type="button"
                        onClick={() => setLogFor(c)}
                        className="mt-2.5 inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium text-muted-foreground transition-[color,border-color,transform] duration-150 hover:border-primary hover:text-foreground active:scale-[0.97]"
                      >
                        <MessageSquarePlus className="size-3.5" /> Log contact
                      </button>}
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
          boothInfo={profileRow ? boothOf(profileRow) : undefined}
          pawsport={profileRow ? pawsportOf(profileRow) : undefined}
          pawsportUnavailable={pawsportRead.status !== 'ok'}
          orders={orders}
          checkouts={checkouts}
          birthdayVouchers={birthdayVouchers}
          membershipEvents={membershipEvents}
          contacts={contacts}
          cohorts={profileRow ? cohortsOfRow(profileRow) : cohorts === null ? null : []}
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
      {builder && (
        <CohortBuilderDialog
          initial={builder}
          existing={savedCohorts}
          rows={all}
          onClose={() => setBuilder(null)}
          onSaved={(id) => {
            setCohortSel(savedSel(id));
            setCohortMsg(null);
            setPage(1);
          }}
        />
      )}
      {logFor && (
        <ContactLogDialog
          name={nameOf(logFor)}
          person={crmPerson(logFor)}
          history={historyOf(logFor)}
          viewer={viewer}
          legacy={contactLogLegacy}
          onClose={() => setLogFor(null)}
        />
      )}
    </div>
  );
}
