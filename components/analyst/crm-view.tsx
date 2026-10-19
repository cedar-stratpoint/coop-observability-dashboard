'use client';

// The website CRM: customers, orders and cart recovery, read live from the
// Zoomy CRM Worker (the same source the storefront admin reads). Three KPI
// groups, then one table at a time — carts, orders, customers — each searchable
// and exportable. Read-only by design: the reminder and win-back sends stay on
// the storefront admin, so nothing here can email a customer.
import {toCsv} from '@/src/csv';
import {useMemo, useState} from 'react';
import {
  AlertTriangle,
  Crown,
  Mail,
  MailCheck,
  PawPrint,
  Receipt,
  RotateCcw,
  ShoppingCart,
  Users,
} from 'lucide-react';
import {Card, CardContent} from '@/components/ui/card';
import {Badge} from '@/components/ui/badge';
import {cn} from '@/lib/utils';
import {Metric} from './metric';
import {RefreshControl} from './refresh-control';
import {Eyebrow} from './sections';
import {Pagination} from './pagination';
import {
  cartStatus,
  enrichCustomers,
  filterActive,
  filterCarts,
  filterCustomers,
  filterOrders,
  fmtPh,
  tierCounts,
  turnaround,
  EMPTY_CART_FILTER,
  EMPTY_CUSTOMER_FILTER,
  EMPTY_ORDER_FILTER,
  type CartStatus,
} from '@/src/crm-compute';
import {refreshCrm} from '@/src/crm-actions';
import type {
  CrmBirthdayVoucher,
  CrmCheckout,
  CrmCustomer,
  CrmMembershipConfig,
  CrmMetrics,
  CrmOrder,
} from '@/src/crm-types';

const PER_PAGE = 10;

const peso = (n: number) =>
  `₱${Number(n || 0).toLocaleString('en-PH', {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;

/** A money string straight off the API, which may carry its own currency. */
const money = (amount: string | null, currency?: string | null) => {
  const n = Number(amount ?? 0);
  const sym = !currency || currency === 'PHP' ? '₱' : `${currency} `;
  return `${sym}${n.toLocaleString('en-PH', {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
};

const STATUS_TONE: Record<CartStatus, string> = {
  Active: 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300',
  Recovered: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300',
  Converted: 'bg-muted text-muted-foreground',
};

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

function downloadCsv(filename: string, rows: string[][]) {
  const url = URL.createObjectURL(new Blob([toCsv(rows)], {type: 'text/csv'}));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function CrmView({
  metrics,
  customers,
  orders,
  checkouts,
  birthdayVouchers,
  membership,
  configured,
  fetchedAt,
}: {
  metrics: CrmMetrics | null;
  customers: CrmCustomer[];
  orders: CrmOrder[];
  checkouts: CrmCheckout[];
  birthdayVouchers: CrmBirthdayVoucher[];
  membership: CrmMembershipConfig;
  configured: boolean;
  fetchedAt: string;
}) {
  const [tab, setTab] = useState<Tab>('carts');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  // One filter set per table, kept while switching tabs so a narrowed view is
  // still there when you come back to it.
  const [cartFilter, setCartFilter] = useState(EMPTY_CART_FILTER);
  const [orderFilter, setOrderFilter] = useState(EMPTY_ORDER_FILTER);
  const [customerFilter, setCustomerFilter] = useState(EMPTY_CUSTOMER_FILTER);
  const needle = q.trim().toLowerCase();

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

  const enriched = useMemo(
    () => enrichCustomers(customers, orders, membership.programStart),
    [customers, orders, membership.programStart],
  );
  const tiers = useMemo(() => tierCounts(customers), [customers]);

  const rows = useMemo(() => {
    if (tab === 'carts') return filterCarts(checkouts, cartFilter, needle);
    if (tab === 'orders') return filterOrders(orders, orderFilter, needle);
    return filterCustomers(enriched, customerFilter, needle);
  }, [tab, needle, checkouts, orders, enriched, cartFilter, orderFilter, customerFilter]);

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
      downloadCsv(`crm-customers (${rows.length}).csv`, [
        ['Name', 'Email', 'Mobile', 'Tier', 'Orders', 'Lifetime spend', 'Spend this membership year', 'Pet'],
        ...(rows as ReturnType<typeof enrichCustomers>).map((c) => [
          [c.firstName, c.lastName].filter(Boolean).join(' '),
          c.email ?? '',
          c.phone ?? '',
          c.membershipTier ?? 'guest',
          String(c.orderCount),
          peso(c.spent),
          peso(c.spendYtd),
          c.petName ?? '',
        ]),
      ]);
    }
  };

  const thisYear = new Date().getUTCFullYear();
  const vouchersThisYear = birthdayVouchers.filter((v) => v.year === thisYear).length;

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
          <span
            className="hidden text-xs text-muted-foreground sm:inline"
            title={`Last read at ${fmtPh(fetchedAt)} Philippine time`}
          >
            {fmtPh(fetchedAt)}
          </span>
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

      {configured && !metrics && (
        <div className="flex items-start gap-2 rounded-lg border border-dashed border-amber-400/60 px-3 py-2 text-xs leading-snug text-amber-700 dark:text-amber-300">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span>The CRM engine did not answer this request — the figures below may be incomplete.</span>
        </div>
      )}

      <section>
        <Eyebrow icon={ShoppingCart}>Store overview</Eyebrow>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <Metric icon={Users} label="Customers" value={(metrics?.customers ?? 0).toLocaleString()} />
          <Metric icon={Receipt} label="Orders" value={(metrics?.orders ?? 0).toLocaleString()} />
          <Metric label="Total revenue" value={peso(metrics?.totalRevenue ?? 0)} sub="Paid orders only" />
          <Metric label="Orders (7d)" value={(metrics?.ordersLast7Days ?? 0).toLocaleString()} />
          <Metric label="Revenue (7d)" value={peso(metrics?.revenueLast7Days ?? 0)} />
        </div>
      </section>

      <section>
        <Eyebrow icon={Crown}>Membership</Eyebrow>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Metric
            label="Platinum"
            value={tiers.platinum.toLocaleString()}
            sub={`Crossed ₱${membership.platinumThreshold.toLocaleString('en-PH')} since ${membership.programStart}`}
          />
          <Metric label="Gold" value={tiers.gold.toLocaleString()} sub="Account holders, default tier" />
          <Metric label="Guests" value={tiers.guest.toLocaleString()} sub="Checked out without an account" />
          <Metric
            icon={PawPrint}
            label="Birthday vouchers"
            value={vouchersThisYear.toLocaleString()}
            sub={`Sent in ${thisYear} · ${birthdayVouchers.length.toLocaleString()} all time`}
          />
        </div>
      </section>

      <section>
        <Eyebrow icon={RotateCcw}>Cart recovery</Eyebrow>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <Metric icon={ShoppingCart} label="Abandoned (active)" value={(metrics?.abandonedActive ?? 0).toLocaleString()} sub="Email captured, not yet bought" />
          <Metric icon={MailCheck} label="Recovered" value={(metrics?.recovered ?? 0).toLocaleString()} sub="Bought after a reminder" />
          <Metric icon={Mail} label="Reminded" value={(metrics?.reminded ?? 0).toLocaleString()} />
          <Metric label="Recovery rate" value={`${metrics?.recoveryRate ?? 0}%`} sub="Recovered ÷ reminded" />
          <Metric label="Revenue recovered" value={peso(metrics?.revenueRecovered ?? 0)} />
        </div>
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
                  {t.key === 'carts' ? checkouts.length : t.key === 'orders' ? orders.length : customers.length}
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
            </>
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
                {needle ? 'Nothing matches that search.' : 'No rows yet.'}
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
                        <th className="px-4 py-2.5 font-medium">Orders</th>
                        <th className="px-4 py-2.5 font-medium">Spend (year)</th>
                        <th className="px-4 py-2.5 font-medium">Pet</th>
                      </tr>
                    )}
                  </thead>
                  <tbody>
                    {tab === 'carts' &&
                      (shown as CrmCheckout[]).map((c) => {
                        const status = cartStatus(c);
                        return (
                          <tr key={c.shopifyCheckoutId} className="border-b last:border-0">
                            <td className="px-4 py-2.5">{c.email ?? '—'}</td>
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
                          <td className="px-4 py-2.5 font-medium">{o.orderNumber ?? o.shopifyOrderId}</td>
                          <td className="px-4 py-2.5">{o.email ?? '—'}</td>
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
                      (shown as ReturnType<typeof enrichCustomers>).map((c) => (
                        <tr key={c.shopifyCustomerId} className="border-b last:border-0">
                          <td className="px-4 py-2.5">
                            {[c.firstName, c.lastName].filter(Boolean).join(' ') || '—'}
                          </td>
                          <td className="px-4 py-2.5">{c.email ?? '—'}</td>
                          <td className="px-4 py-2.5">
                            <span className="text-xs capitalize text-muted-foreground">
                              {c.membershipTier ?? 'guest'}
                            </span>
                          </td>
                          <td className="px-4 py-2.5 tabular-nums">{c.orderCount}</td>
                          <td className="px-4 py-2.5 tabular-nums">{peso(c.spendYtd)}</td>
                          <td className="px-4 py-2.5 text-xs text-muted-foreground">{c.petName ?? '—'}</td>
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
                          <span className="min-w-0 flex-1 truncate text-sm font-medium">{c.email ?? '—'}</span>
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
                        <span className="text-sm font-medium">{o.orderNumber ?? o.shopifyOrderId}</span>
                        <Badge variant={o.financialStatus === 'paid' ? 'default' : 'secondary'}>
                          {o.financialStatus ?? 'unknown'}
                        </Badge>
                      </div>
                      <div className="mt-1 text-base font-semibold tabular-nums">{money(o.totalPrice, o.currency)}</div>
                      <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground">
                        <div className="col-span-2 flex justify-between gap-2">
                          <dt>Email</dt>
                          <dd className="min-w-0 truncate text-foreground">{o.email ?? '—'}</dd>
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
                  (shown as ReturnType<typeof enrichCustomers>).map((c) => (
                    <li key={c.shopifyCustomerId} className="px-4 py-3">
                      <div className="flex items-start justify-between gap-3">
                        <span className="min-w-0 flex-1 truncate text-sm font-medium">
                          {[c.firstName, c.lastName].filter(Boolean).join(' ') || '—'}
                        </span>
                        <span className="shrink-0 text-xs capitalize text-muted-foreground">{c.membershipTier ?? 'guest'}</span>
                      </div>
                      <div className="mt-0.5 truncate text-xs text-muted-foreground">{c.email ?? '—'}</div>
                      <dl className="mt-2 grid grid-cols-3 gap-x-4 gap-y-1 text-xs text-muted-foreground">
                        <div className="flex flex-col">
                          <dt>Orders</dt>
                          <dd className="tabular-nums text-foreground">{c.orderCount}</dd>
                        </div>
                        <div className="flex flex-col">
                          <dt>Spend (yr)</dt>
                          <dd className="tabular-nums text-foreground">{peso(c.spendYtd)}</dd>
                        </div>
                        <div className="flex flex-col">
                          <dt>Pet</dt>
                          <dd className="text-foreground">{c.petName ?? '—'}</dd>
                        </div>
                      </dl>
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
    </div>
  );
}
