'use client';

import {useEffect, useState} from 'react';
import Link from 'next/link';
import {usePathname, useSearchParams} from 'next/navigation';
import {signOut} from 'next-auth/react';
import {Activity, BarChart3, CalendarDays, ChevronDown, ChevronLeft, ChevronRight, Contact, FileBarChart, Gauge, HeartPulse, Home, ListChecks, LogOut, Mail, Menu, Package, Receipt, ReceiptText, Settings, Store, Tag, Upload, Users} from 'lucide-react';
import type {DigestArchiveRow} from '../../src/types';
import {cn} from '@/lib/utils';
import {fmtRange, hasNoSalesData, periodKind} from '../../src/week';
import {ThemeToggle} from './theme-toggle';
import {ViewSwitcher} from './company-switcher';
import {EnvStrip, EnvSwitcher} from './env-switcher';
import {UploadQueueProvider} from './upload-queue';
import {UploadQueueIndicator} from './upload-queue-indicator';
import {BrandMark} from './brand-mark';
import {brandFor} from '@/src/brands';
import {shouldRedirectFromZoomy} from '@/src/company-nav';
import {PlaybookProvider} from './playbook';
import {CoopChatProvider, AskCoopPill} from './coop-chat';
import {CustomRangePicker} from './custom-range-picker';

// The left rail. Overview is a group (accordion in the expanded rail) whose
// children are the sub-views that live under it; the rest are flat tabs.
type NavItem = {href: string; label: string; icon: React.ComponentType<{className?: string}>};

const OVERVIEW: NavItem = {href: '/', label: 'Overview', icon: Home};
const OVERVIEW_CHILDREN: NavItem[] = [
  {href: '/health', label: 'Business Health', icon: Gauge},
  {href: '/?channel=all', label: 'Sales', icon: BarChart3},
  {href: '/offline-sales', label: 'Offline Sales', icon: Receipt},
  {href: '/offline-sales/orders', label: 'Transactions', icon: ReceiptText},
  {href: '/offline-sales/events', label: 'Events', icon: CalendarDays},
];
/** The three contact lists behind the Customers tab, in the top bar's dropdown. */
const CUSTOMER_SOURCES: Array<{href: string; label: string; hint: string}> = [
  {href: '/customers/all', label: 'All contacts', hint: 'Every list, merged by person'},
  {href: '/customers/website-crm', label: 'Website CRM', hint: 'zoomyforpets.com buyers & carts'},
  {href: '/customers/leads', label: 'Event lead contacts', hint: 'Spin-the-wheel booth signups'},
  {href: '/customers/lazada', label: 'Lazada contacts', hint: 'Marketplace buyers, by phone'},
];

const FLAT_TABS: NavItem[] = [
  // Products merged into Inventory (feat/inventory-revamp); /products redirects in.
  {href: '/inventory', label: 'Inventory', icon: Package},
  // One tab for every contact list we hold: the website CRM, the booth leads and
  // the Lazada marketplace buyers. The source switcher in the top bar moves
  // between them (CUSTOMER_SOURCES below).
  {href: '/customers', label: 'Customers', icon: Users},
  // F9 Coop Reports: dashboards saved from the chat drawer.
  {href: '/reports', label: 'Reports', icon: FileBarChart},
  {href: '/traffic', label: 'Traffic', icon: Activity},
  {href: '/repricer', label: 'Repricer', icon: Tag},
  {href: '/settings', label: 'Settings', icon: Settings},
];

// Active detection. '/' is the Overview home ONLY without a channel; '/?channel='
// is the Sales compare view. Everything else matches by path prefix.
const leafActive = (href: string, pathname: string, channel: string | null) => {
  if (href === '/') return pathname === '/' && !channel;
  if (href === '/?channel=all') return pathname === '/' && Boolean(channel);
  // Transactions (/offline-sales/orders) and Events (/offline-sales/events) live
  // under /offline-sales, so all three must not light up together: Offline Sales
  // owns /offline-sales and any other subpath, while Transactions and Events each
  // own their own subtree. This transfers the highlight to the child when you open
  // it from the Offline Sales page.
  if (href === '/offline-sales') {
    return pathname === '/offline-sales'
      || (pathname.startsWith('/offline-sales/')
        && !pathname.startsWith('/offline-sales/events')
        && !pathname.startsWith('/offline-sales/orders'));
  }
  if (href === '/offline-sales/orders') return pathname.startsWith('/offline-sales/orders');
  if (href === '/offline-sales/events') return pathname.startsWith('/offline-sales/events');
  return pathname.startsWith(href.split('?')[0]);
};

/** The Coop wordmark — lowercase, with the second "o" in brand green. */
function CoopMark() {
  return (
    <span className="select-none font-sans text-[19px] font-extrabold leading-none tracking-tight text-foreground">
      co<span style={{color: 'var(--primary)'}}>o</span>p
    </span>
  );
}

export function DashboardShell({
  digests,
  user,
  nav,
  children,
}: {
  digests: DigestArchiveRow[];
  usingMock?: boolean;
  user?: {name?: string | null; email?: string | null; image?: string | null};
  /** Tenant chrome: active company + companies to switch between. Absent = the
   *  single-tenant (Zoomy) path, which renders exactly as before. */
  nav?: {
    activeKey: string;
    companyId: string | null;
    isCoopAdmin: boolean;
    views: {key: string; companyId: string | null; role: string; name: string}[];
    holdsCoopAdmin?: boolean;
    env?: 'staging' | 'production';
  };
  children: React.ReactNode;
}) {
  const pathname = usePathname() || '/';
  const [accountOpen, setAccountOpen] = useState(false);
  // Mobile "More" sheet (below md). Deterministic false default → matches SSR, so
  // desktop hydration is unaffected (mirrors the navExpanded pattern below).
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  // Sign-out confirmation — signing out is easy to hit by accident and costs a
  // re-auth, so both entry points open a confirm dialog instead of acting directly.
  const [signOutOpen, setSignOutOpen] = useState(false);
  const initials = (user?.name || user?.email || 'ZY')
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase())
    .join('');
  const searchParams = useSearchParams();
  const currentWeek = searchParams.get('week') ?? digests[0]?.window_from ?? '';
  // Query-safe: merges ?week into hrefs that may already carry a query (e.g. the
  // Sales child, /?channel=all) instead of blindly appending a second '?'.
  const withWeek = (href: string) => {
    if (!currentWeek) return href;
    const [path, q = ''] = href.split('?');
    const params = new URLSearchParams(q);
    params.set('week', currentWeek);
    return `${path}?${params.toString()}`;
  };

  const current = digests.find((d) => d.window_from === currentWeek) ?? digests[0];
  const currentRange = current ? fmtRange(current.window_from, current.window_to, current.digest.window.label) : '';

  // The reporting-period picker only makes sense in period-scoped analytics views —
  // hide it on the home brief ("/" with no channel), Settings, Business Health
  // (which uses its own fixed trailing-6-month window shown on the page), and
  // Product Controls (a live catalog, not a period-scoped report).
  const channel = searchParams.get('channel');
  const isHome = pathname === '/' && !channel;
  const showPeriod =
    Boolean(current) &&
    !isHome &&
    !pathname.startsWith('/settings') &&
    !pathname.startsWith('/health') &&
    !pathname.startsWith('/repricer') &&
    // Saved reports carry their own dates (live range or pinned), not a digest week.
    !pathname.startsWith('/reports') &&
    !pathname.startsWith('/products') &&
    // Inventory is now the merged live catalog (Products folded in), not a
    // period-scoped report, so it has no week picker (guardrail 2).
    !pathname.startsWith('/inventory') &&
    // The CRM reads the live CRM engine, whose figures are all-time or rolling
    // 7-day. A digest week sitting above them implied a scope it does not have.
    // The Customers hub carries live contact lists, not a digest window — it
    // shows a source switcher in the same slot instead.
    !pathname.startsWith('/customers') &&
    !pathname.startsWith('/crm') &&
    !pathname.startsWith('/lazada') &&
    !pathname.startsWith('/offline-sales');

  const [periodOpen, setPeriodOpen] = useState(false);
  const [sourceOpen, setSourceOpen] = useState(false);
  const showSource = pathname.startsWith('/customers');
  const currentSource =
    CUSTOMER_SOURCES.find((s) => pathname.startsWith(s.href)) ?? CUSTOMER_SOURCES[0];

  // Nav rail can expand to show labels beside the icons (8 icon-only tabs are
  // hard to tell apart). Default collapsed to match SSR; restore the saved
  // choice after mount to avoid a hydration mismatch, and persist changes.
  const [navExpanded, setNavExpanded] = useState(false);
  useEffect(() => {
    try {
      if (localStorage.getItem('coop-nav-expanded') === '1') setNavExpanded(true);
    } catch {}
  }, []);
  // Flyout submenu for the collapsed rail's Overview group.
  const [overviewFlyout, setOverviewFlyout] = useState(false);
  const toggleNav = () =>
    setNavExpanded((v) => {
      const next = !v;
      try {
        localStorage.setItem('coop-nav-expanded', next ? '1' : '0');
      } catch {}
      setOverviewFlyout(false); // don't carry a collapsed-rail popover across modes
      return next;
    });

  // Overview accordion (shown in the expanded rail). Whether any Overview view
  // is the current page — used to highlight the collapsed parent icon and to
  // auto-open the accordion when you navigate into a child.
  const overviewGroupActive =
    leafActive('/', pathname, channel) || OVERVIEW_CHILDREN.some((c) => leafActive(c.href, pathname, channel));
  const [overviewOpen, setOverviewOpen] = useState(true);
  useEffect(() => {
    if (overviewGroupActive) setOverviewOpen(true);
  }, [overviewGroupActive]);

  // Per-view nav. nav absent => legacy single-tenant Zoomy (incl. local dev-auth
  // bypass). Zoomy keeps its exact legacy tabs. The data-blind Coop Admin view gets
  // the role console; any other company view (Goldline) gets its own tabs. Pages are
  // guarded server-side regardless. The active view drives all of this.
  const isZoomy = !shouldRedirectFromZoomy(nav ?? null);
  const showUploads = !isZoomy; // Ask Coop (Zoomy-only) is hidden for non-Zoomy views
  const isCoopAdminView = Boolean(nav?.isCoopAdmin);
  const activeView = nav?.views.find((v) => v.key === nav.activeKey);
  const activeName = isCoopAdminView ? 'Coop Admin' : (activeView?.name ?? 'Zoomy');
  // Wordmark for the single-view label: the active company's brand. Only with no nav
  // at all (local dev bypass / legacy staff) is it assumed to be Zoomy.
  const staticBrand = brandFor(isCoopAdminView ? null : nav ? activeView?.companyId : 'zoomy');

  const uploadsTab: NavItem = {href: '/uploads', label: 'Uploads', icon: Upload};
  const overviewTab: NavItem = {href: '/overview', label: 'Overview', icon: BarChart3};
  const storesTab: NavItem = {href: '/stores', label: 'Stores', icon: Store};
  const stockTab: NavItem = {href: '/stock', label: 'Inventory', icon: Package};
  const actionsTab: NavItem = {href: '/action-feed', label: 'Actions', icon: ListChecks};
  const healthTab: NavItem = {href: '/store-health', label: 'Health', icon: HeartPulse};
  const usersTab: NavItem = {href: '/admin/users', label: 'Users & Roles', icon: Users};
  // Settings for non-Zoomy views only matters to multi-role users (Starting view).
  const multiView = Boolean(nav && nav.views.length > 1);
  const settingsTab: NavItem = {href: '/settings', label: 'Settings', icon: Settings};

  const overviewChildren = isZoomy ? OVERVIEW_CHILDREN : [];
  const flatTabs = isZoomy
    ? FLAT_TABS
    : isCoopAdminView
      ? [usersTab, ...(multiView ? [settingsTab] : [])]
      : [overviewTab, storesTab, stockTab, actionsTab, healthTab, uploadsTab, ...(multiView ? [settingsTab] : [])];

  // ── Mobile nav model (below md only) ──────────────────────────────────────
  // The left rail is hidden under md; these drive a bottom tab bar + a "More" sheet.
  // Reuses leafActive so highlight logic matches the rail. Desktop never renders this.
  const mobileTabs = isZoomy
    ? [
        {href: '/', label: 'Home', icon: Home, active: leafActive('/', pathname, channel)},
        {href: '/?channel=all', label: 'Sales', icon: BarChart3, active: leafActive('/?channel=all', pathname, channel)},
        {href: '/inventory', label: 'Inventory', icon: Package, active: leafActive('/inventory', pathname, channel)},
        {href: '/offline-sales', label: 'Offline', icon: Receipt, active: leafActive('/offline-sales', pathname, channel)},
      ]
    : isCoopAdminView
      ? [
          {href: '/admin/users', label: 'Users', icon: Users, active: leafActive('/admin/users', pathname, channel)},
        ]
      : [
          {href: '/overview', label: 'Overview', icon: BarChart3, active: leafActive('/overview', pathname, channel)},
          {href: '/stock', label: 'Inventory', icon: Package, active: leafActive('/stock', pathname, channel)},
          {href: '/action-feed', label: 'Actions', icon: ListChecks, active: leafActive('/action-feed', pathname, channel)},
          {href: '/uploads', label: 'Uploads', icon: Upload, active: leafActive('/uploads', pathname, channel)},
        ];
  const moreItems: NavItem[] = isZoomy
    ? [
        {href: '/health', label: 'Business Health', icon: Gauge},
        {href: '/offline-sales/orders', label: 'Transactions', icon: ReceiptText},
        {href: '/offline-sales/events', label: 'Events', icon: CalendarDays},
        {href: '/customers', label: 'Customers', icon: Users},
        {href: '/reports', label: 'Reports', icon: FileBarChart},
        {href: '/traffic', label: 'Traffic', icon: Activity},
        {href: '/repricer', label: 'Repricer', icon: Tag},
        {href: '/settings', label: 'Settings', icon: Settings},
      ]
    : isCoopAdminView
      ? multiView
        ? [settingsTab]
        : []
      : [storesTab, healthTab, ...(multiView ? [settingsTab] : [])];
  const moreActive = moreItems.some((i) => leafActive(i.href, pathname, channel));

  return (
    <PlaybookProvider>
    {/* Upload queue lives in the shell so uploads keep running across in-app navigation. */}
    <UploadQueueProvider company={nav?.companyId ?? null}>
    <UploadQueueIndicator />
    <CoopChatProvider scopeLabel={currentRange || undefined}>
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      {/* ── Top bar ─────────────────────────────────────────────────────────── */}
      {/* Sticky (not relative) so it stays pinned on scroll, flush above the
          sticky rail (which pins at top-14 = this bar's height). z-30 keeps it
          over both the rail and the scrolling canvas. */}
      <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-3 border-b border-border bg-card/60 px-4 backdrop-blur-sm">
        {nav?.holdsCoopAdmin && nav.env && <EnvStrip env={nav.env} />}
        <Link href="/" aria-label="Coop home" className="flex items-center gap-2 rounded-lg transition-opacity hover:opacity-70">
          <CoopMark />
          <span className="hidden text-[13px] font-medium tracking-tight text-muted-foreground sm:inline">
            BrandOS
          </span>
        </Link>

        {/* View switcher. The only place to switch views (company role(s) and/or Coop
            Admin), so it shows at every width, phones included. A single-view user gets
            a plain label: no chevron, since there's nothing to open. */}
        {nav && nav.views.length > 1 ? (
          <div className="ml-1 min-w-0">
            <ViewSwitcher views={nav.views} activeKey={nav.activeKey} />
          </div>
        ) : (
          <span className="ml-1 inline-flex h-8 items-center gap-2 rounded-full border border-border bg-background px-3 text-sm font-medium max-sm:hidden">
            {staticBrand ? (
              <>
                <BrandMark brand={staticBrand} size={staticBrand.style === 'thin' ? 11 : 13} />
                <span className="sr-only">{activeName}</span>
              </>
            ) : (
              <>
                <span className="size-1.5 rounded-full" style={{backgroundColor: 'var(--primary)'}} />
                {activeName}
              </>
            )}
          </span>
        )}

        {/* Environment switcher (Staging ↔ Production) — anyone holding a Coop Admin
            role, whatever view is active. */}
        {nav?.holdsCoopAdmin && nav.env && <EnvSwitcher env={nav.env} />}

        {/* Source switcher — the Customers hub's three contact lists */}
        {showSource && (
          <div className="relative">
            <button
              type="button"
              onClick={() => setSourceOpen((o) => !o)}
              aria-expanded={sourceOpen}
              className="inline-flex items-center gap-2 rounded-full border border-border bg-background px-3 py-1.5 text-sm text-foreground/80 transition-colors hover:bg-muted"
            >
              <span className="text-xs font-medium">{currentSource.label}</span>
              <ChevronDown className={cn('size-3.5 text-muted-foreground transition-transform', sourceOpen && 'rotate-180')} />
            </button>
            {sourceOpen && (
              <>
                <button className="fixed inset-0 z-10 cursor-default" aria-hidden onClick={() => setSourceOpen(false)} />
                <div className="absolute left-0 z-20 mt-2 w-64 overflow-hidden rounded-xl border border-border bg-popover shadow-lg">
                  <div className="px-3 pb-1.5 pt-2.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Contact lists
                  </div>
                  <div className="pb-1">
                    {CUSTOMER_SOURCES.map((src) => {
                      const active = src.href === currentSource.href;
                      return (
                        <Link
                          key={src.href}
                          href={src.href}
                          onClick={() => setSourceOpen(false)}
                          className={cn(
                            'flex items-center gap-2.5 px-3 py-2 text-sm transition-colors',
                            active ? 'bg-accent text-accent-foreground' : 'hover:bg-muted',
                          )}
                        >
                          <span className={cn('size-1.5 shrink-0 rounded-full', active ? 'bg-primary' : 'bg-border')} />
                          <span className="flex min-w-0 flex-1 flex-col">
                            <span className="truncate">{src.label}</span>
                            <span className="truncate text-[11px] text-muted-foreground">{src.hint}</span>
                          </span>
                        </Link>
                      );
                    })}
                  </div>
                </div>
              </>
            )}
          </div>
        )}

        {/* Reporting-period switcher — analytics views only */}
        {showPeriod && (
          <div className="relative">
            <button
              type="button"
              onClick={() => setPeriodOpen((o) => !o)}
              aria-expanded={periodOpen}
              className="inline-flex items-center gap-2 rounded-full border border-border bg-background px-3 py-1.5 text-sm text-foreground/80 transition-colors hover:bg-muted"
            >
              <span className="font-mono text-xs tabular-nums">{currentRange}</span>
              <ChevronDown className={cn('size-3.5 text-muted-foreground transition-transform', periodOpen && 'rotate-180')} />
            </button>
            {periodOpen && (
              <>
                <button className="fixed inset-0 z-10 cursor-default" aria-hidden onClick={() => setPeriodOpen(false)} />
                <div className="absolute left-0 z-20 mt-2 w-64 overflow-hidden rounded-xl border border-border bg-popover shadow-lg">
                  <div className="max-h-80 overflow-y-auto pb-1">
                    {(['weekly', 'monthly'] as const).map((kind) => {
                      const group = digests.filter((d) => periodKind(d) === kind);
                      if (!group.length) return null;
                      return (
                        <div key={kind}>
                          <div className="px-3 pb-1.5 pt-2.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                            {kind === 'weekly' ? 'Weekly' : 'Monthly'}
                          </div>
                    {group.map((d) => {
                      const active = d.window_from === currentWeek;
                      // Preserve the current view's params (e.g. ?channel=) — only swap the week,
                      // so changing period reloads the same view instead of bouncing home.
                      const params = new URLSearchParams(searchParams.toString());
                      params.set('week', d.window_from);
                      // A custom range belongs to its period — drop it on switch.
                      params.delete('from');
                      params.delete('to');
                      return (
                        <Link
                          key={d.window_from}
                          href={`${pathname}?${params.toString()}`}
                          onClick={() => setPeriodOpen(false)}
                          className={cn(
                            'flex items-center gap-2.5 px-3 py-2 text-sm transition-colors',
                            active ? 'bg-accent text-accent-foreground' : 'hover:bg-muted',
                          )}
                        >
                          <span
                            className={cn('size-1.5 shrink-0 rounded-full', hasNoSalesData(d) ? 'bg-amber-500' : 'bg-primary')}
                          />
                          <span className="flex min-w-0 flex-1 flex-col">
                            <span className="truncate tabular-nums">{fmtRange(d.window_from, d.window_to, d.digest.window.label)}</span>
                            <span className="truncate text-[11px] text-muted-foreground">
                              {Math.round((Date.parse(d.window_to) - Date.parse(d.window_from)) / 86_400_000)} days
                              {hasNoSalesData(d) && ' · no sales data'}
                            </span>
                          </span>
                          {d.emailed_at && <Mail className="size-3.5 shrink-0 text-muted-foreground" />}
                        </Link>
                      );
                    })}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </>
            )}
          </div>
        )}

        {/* Custom dates within the period — only the Sales overview recomputes for it */}
        {showPeriod && current && pathname === '/' && channel && (
          <CustomRangePicker
            windowFrom={current.window_from}
            windowTo={current.window_to}
            fullPeriodOnly={(['shopee', 'lazada'] as const).filter((c) => !current.digest.daily?.[c]?.length).map((c) => (c === 'shopee' ? 'Shopee' : 'Lazada'))}
          />
        )}

        {/* Right cluster: Ask Coop · theme · avatar */}
        <div className="ml-auto flex items-center gap-2">
          {/* Ask Coop reads Zoomy data; hidden for non-Zoomy companies (the API 403s them). */}
          {!showUploads && <AskCoopPill />}
          <ThemeToggle />
          <div className="relative">
            <button
              type="button"
              onClick={() => setAccountOpen((o) => !o)}
              aria-label="Account"
              aria-expanded={accountOpen}
              className="flex size-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold text-primary-foreground transition-opacity hover:opacity-90"
              style={{backgroundColor: 'var(--primary)'}}
            >
              {initials || 'ZY'}
            </button>
            {accountOpen && (
              <>
                <button className="fixed inset-0 z-10 cursor-default" aria-hidden onClick={() => setAccountOpen(false)} />
                <div className="absolute right-0 z-20 mt-2 w-56 overflow-hidden rounded-xl border border-border bg-popover shadow-lg">
                  <div className="border-b border-border px-3 py-2.5">
                    <div className="truncate text-[13px] font-medium text-foreground">{user?.name || 'Signed in'}</div>
                    {user?.email && <div className="truncate text-[11px] text-muted-foreground">{user.email}</div>}
                  </div>
                  <button
                    onClick={() => {
                      setAccountOpen(false);
                      setSignOutOpen(true);
                    }}
                    className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-[13px] text-foreground transition-colors hover:bg-muted"
                  >
                    <LogOut className="size-3.5 text-muted-foreground" /> Sign out
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </header>

      {/* ── Body: icon rail + canvas ────────────────────────────────────────── */}
      <div className="flex min-h-0 flex-1">
        <nav
          className={cn(
            // Pin the rail to the viewport (below the h-14 header) so its height
            // is bounded — otherwise a tall page stretches it and the centered
            // toggle drifts down into the empty space below the tabs. z-20 lifts
            // the rail's stacking context above <main> so the collapsed Overview
            // flyout (which overflows into the content area) is clickable, not
            // just visible. Width is NOT transitioned: animating it relayouts the
            // adjacent charts every frame and feels laggy — the toggle is instant.
            'sticky top-14 z-20 flex h-[calc(100vh-3.5rem)] shrink-0 flex-col gap-1 self-start border-r border-sidebar-border bg-sidebar py-4 max-md:hidden',
            navExpanded ? 'w-56 items-stretch px-3' : 'w-16 items-center',
          )}
        >
          {/* Overview — a group: an accordion in the expanded rail, a single
              icon in the collapsed rail (its children need the labels). Zoomy only;
              non-Zoomy companies get a flat Overview tab below instead (no duplicate). */}
          {isZoomy && (navExpanded ? (
            <div className="flex flex-col">
              <div className="flex items-center gap-1">
                <Link
                  href={withWeek('/')}
                  aria-current={leafActive('/', pathname, channel) ? 'page' : undefined}
                  className={cn(
                    'relative flex h-10 flex-1 items-center gap-3 rounded-xl px-3 transition-colors',
                    leafActive('/', pathname, channel)
                      ? 'bg-primary/10 text-primary'
                      : 'text-muted-foreground hover:bg-sidebar-accent/50 hover:text-foreground',
                  )}
                >
                  {leafActive('/', pathname, channel) && <span className="absolute -left-3 top-1/2 h-5 w-1 -translate-y-1/2 rounded-r-full bg-primary" aria-hidden />}
                  <OVERVIEW.icon className="size-[18px] shrink-0" />
                  <span className="truncate text-[13px] font-medium">{OVERVIEW.label}</span>
                </Link>
                <button
                  type="button"
                  onClick={() => setOverviewOpen((o) => !o)}
                  aria-label={overviewOpen ? 'Collapse Overview section' : 'Expand Overview section'}
                  aria-expanded={overviewOpen}
                  className="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-sidebar-accent/50 hover:text-foreground"
                >
                  <ChevronDown className={cn('size-4 transition-transform', overviewOpen ? '' : '-rotate-90')} />
                </button>
              </div>
              {overviewOpen && (
                <div className="ml-3 mt-1 flex flex-col gap-1 border-l border-sidebar-border pl-3">
                  {overviewChildren.map((c) => {
                    const active = leafActive(c.href, pathname, channel);
                    return (
                      <Link
                        key={c.label}
                        href={withWeek(c.href)}
                        aria-current={active ? 'page' : undefined}
                        className={cn(
                          'flex h-9 items-center gap-3 rounded-lg px-3 transition-colors',
                          active ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-sidebar-accent/50 hover:text-foreground',
                        )}
                      >
                        <c.icon className="size-4 shrink-0" />
                        <span className="truncate text-[13px] font-medium">{c.label}</span>
                      </Link>
                    );
                  })}
                </div>
              )}
            </div>
          ) : (
            <div className="relative">
              {/* Collapsed: the Overview icon opens a flyout submenu with the
                  group's children + labels (no room for inline labels here). */}
              <button
                type="button"
                onClick={() => setOverviewFlyout((o) => !o)}
                title="Overview"
                aria-label="Overview"
                aria-haspopup="menu"
                aria-expanded={overviewFlyout}
                aria-current={overviewGroupActive ? 'page' : undefined}
                className={cn(
                  'relative flex size-10 items-center justify-center rounded-xl transition-colors',
                  overviewGroupActive ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-sidebar-accent/50 hover:text-foreground',
                )}
              >
                {overviewGroupActive && <span className="absolute -left-3 top-1/2 h-5 w-1 -translate-y-1/2 rounded-r-full bg-primary" aria-hidden />}
                <OVERVIEW.icon className="size-[18px] shrink-0" />
                {/* Rest-state affordance: a small chevron badge marks this icon
                    as a group with a submenu (the only one), so it reads as
                    expandable before any click. Rotates when the flyout opens. */}
                <ChevronRight
                  aria-hidden
                  className={cn(
                    'absolute bottom-0.5 right-0.5 size-2.5 transition-transform',
                    overviewFlyout ? 'rotate-90' : '',
                    overviewGroupActive ? 'text-primary/70' : 'text-muted-foreground/60',
                  )}
                />
              </button>
              {overviewFlyout && (
                <>
                  <button className="fixed inset-0 z-20 cursor-default" aria-hidden onClick={() => setOverviewFlyout(false)} />
                  <div role="menu" className="absolute left-full top-0 z-30 ml-2 w-52 overflow-hidden rounded-xl border border-border bg-popover p-1 shadow-lg">
                    {[OVERVIEW, ...overviewChildren].map((item) => {
                      const active = leafActive(item.href, pathname, channel);
                      return (
                        <Link
                          key={item.label}
                          href={withWeek(item.href)}
                          role="menuitem"
                          onClick={() => setOverviewFlyout(false)}
                          aria-current={active ? 'page' : undefined}
                          className={cn(
                            'flex h-9 items-center gap-2.5 rounded-lg px-2.5 transition-colors',
                            active ? 'bg-primary/10 text-primary' : 'text-foreground hover:bg-muted',
                          )}
                        >
                          <item.icon className="size-4 shrink-0" />
                          <span className="truncate text-[13px] font-medium">{item.label}</span>
                        </Link>
                      );
                    })}
                  </div>
                </>
              )}
            </div>
          ))}

          {flatTabs.map((t) => {
            const active = leafActive(t.href, pathname, channel);
            return (
              <Link
                key={t.href}
                href={withWeek(t.href)}
                title={navExpanded ? undefined : t.label}
                aria-label={t.label}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'relative flex h-10 items-center rounded-xl transition-colors',
                  navExpanded ? 'w-full gap-3 px-3' : 'size-10 justify-center',
                  active
                    ? 'bg-primary/10 text-primary'
                    : 'text-muted-foreground hover:bg-sidebar-accent/50 hover:text-foreground',
                )}
              >
                {active && <span className="absolute -left-3 top-1/2 h-5 w-1 -translate-y-1/2 rounded-r-full bg-primary" aria-hidden />}
                <t.icon className="size-[18px] shrink-0" />
                {navExpanded && <span className="truncate text-[13px] font-medium">{t.label}</span>}
              </Link>
            );
          })}

          {/* Expand / collapse toggle — straddles the rail's right edge, vertically centered. */}
          <button
            type="button"
            onClick={toggleNav}
            aria-label={navExpanded ? 'Collapse navigation' : 'Expand navigation'}
            aria-expanded={navExpanded}
            className="absolute -right-3 top-1/2 z-10 flex size-6 -translate-y-1/2 items-center justify-center rounded-full border border-sidebar-border bg-card text-muted-foreground shadow-sm transition-colors hover:text-foreground"
          >
            {navExpanded ? <ChevronLeft className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          </button>
        </nav>

        {/* The window scrolls, not <main>: overflow-x-clip (not overflow-auto) keeps <main>
            from becoming a scroll container, so position:sticky inside pages pins to the
            viewport (review scan, commit bars, Health header). */}
        <main id="coop-scroll" className="coop-app-in min-w-0 flex-1 overflow-x-clip max-md:pb-[calc(4rem+env(safe-area-inset-bottom))]">
          {children}
        </main>
      </div>

      {/* ── Mobile bottom tab bar (below md) ─────────────────────────────────
          The rail is hidden under md; this replaces it. Pure CSS breakpoint
          (md:hidden) → renders identically server/client and has zero effect on
          the desktop layout. Nav is frequent, so items only transition color +
          press-scale; no entrance motion. */}
      <nav
        aria-label="Primary"
        className="fixed inset-x-0 bottom-0 z-30 flex h-16 items-stretch border-t border-sidebar-border bg-card/95 pb-[env(safe-area-inset-bottom)] backdrop-blur-sm md:hidden"
      >
        {mobileTabs.map((t) => (
          <Link
            key={t.label}
            href={withWeek(t.href)}
            aria-current={t.active ? 'page' : undefined}
            className={cn(
              'flex flex-1 flex-col items-center justify-center gap-1 text-[11px] font-medium tracking-tight transition-colors active:scale-95',
              t.active ? 'text-primary' : 'text-muted-foreground',
            )}
          >
            <t.icon className="size-[26px]" strokeWidth={2} />
            <span>{t.label}</span>
          </Link>
        ))}
        <button
          type="button"
          onClick={() => setMobileNavOpen(true)}
          aria-label="More"
          aria-expanded={mobileNavOpen}
          className={cn(
            'flex flex-1 flex-col items-center justify-center gap-1 text-[11px] font-medium tracking-tight transition-colors active:scale-95',
            moreActive ? 'text-primary' : 'text-muted-foreground',
          )}
        >
          <Menu className="size-[26px]" strokeWidth={2} />
          <span>More</span>
        </button>
      </nav>

      {/* Mobile "More" sheet — secondary nav + account. Occasional use, so it
          earns a real slide-up (iOS drawer curve); backdrop fades. Rendered but
          hidden on desktop (md:hidden). */}
      <div className="md:hidden" aria-hidden={!mobileNavOpen}>
        <button
          type="button"
          tabIndex={mobileNavOpen ? 0 : -1}
          aria-label="Close menu"
          onClick={() => setMobileNavOpen(false)}
          className={cn(
            'fixed inset-0 z-40 bg-black/40 transition-opacity duration-300 motion-reduce:transition-none',
            mobileNavOpen ? 'opacity-100' : 'pointer-events-none opacity-0',
          )}
        />
        <div
          role="dialog"
          aria-modal={mobileNavOpen}
          aria-label="More navigation"
          className={cn(
            'fixed inset-x-0 bottom-0 z-50 rounded-t-2xl border-t border-sidebar-border bg-popover pb-[calc(env(safe-area-inset-bottom)+0.5rem)] shadow-2xl transition-transform duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none',
            mobileNavOpen ? 'translate-y-0' : 'translate-y-full',
          )}
        >
          <div className="mx-auto mt-2.5 h-1 w-9 rounded-full bg-border" aria-hidden />
          {moreItems.length > 0 && (
          <div className="grid grid-cols-3 gap-1 p-3">
            {moreItems.map((item) => {
              const active = leafActive(item.href, pathname, channel);
              return (
                <Link
                  key={item.label}
                  href={withWeek(item.href)}
                  onClick={() => setMobileNavOpen(false)}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'flex flex-col items-center gap-1.5 rounded-xl px-2 py-3 text-center text-[11px] font-medium leading-tight transition-colors active:scale-95',
                    active ? 'bg-primary/10 text-primary' : 'text-foreground hover:bg-muted',
                  )}
                >
                  <item.icon className="size-5 shrink-0" />
                  <span>{item.label}</span>
                </Link>
              );
            })}
          </div>
          )}
          <div className={cn('px-3 py-3', moreItems.length > 0 && 'border-t border-border')}>
            <div className="mb-2 px-1">
              <div className="truncate text-[13px] font-medium text-foreground">{user?.name || 'Signed in'}</div>
              {user?.email && <div className="truncate text-[11px] text-muted-foreground">{user.email}</div>}
            </div>
            <button
              onClick={() => {
                setMobileNavOpen(false);
                setSignOutOpen(true);
              }}
              className="flex w-full items-center gap-2 rounded-lg px-1 py-2 text-left text-[13px] text-foreground transition-colors hover:bg-muted active:scale-[0.99]"
            >
              <LogOut className="size-4 text-muted-foreground" /> Sign out
            </button>
          </div>
        </div>
      </div>
    </div>
    {signOutOpen && (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center p-4"
        role="dialog"
        aria-modal="true"
        aria-labelledby="signout-title"
        onKeyDown={(e) => {
          if (e.key === 'Escape') setSignOutOpen(false);
        }}
      >
        <button
          type="button"
          aria-label="Cancel sign out"
          onClick={() => setSignOutOpen(false)}
          className="absolute inset-0 cursor-default bg-foreground/30 backdrop-blur-[1px]"
        />
        <div className="relative z-10 w-full max-w-xs overflow-hidden rounded-xl border border-border bg-popover shadow-xl">
          <div className="flex flex-col gap-1 px-5 pt-5">
            <h2 id="signout-title" className="font-heading text-base font-semibold text-foreground">
              Sign out of Coop?
            </h2>
            <p className="text-sm text-muted-foreground">You&apos;ll need to sign in again to get back in.</p>
          </div>
          <div className="mt-4 flex justify-end gap-2 border-t border-border bg-muted/40 px-4 py-3">
            <button
              type="button"
              autoFocus
              onClick={() => setSignOutOpen(false)}
              className="rounded-lg px-3 py-1.5 text-[13px] font-medium text-foreground transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => signOut({callbackUrl: '/signin'})}
              className="inline-flex items-center gap-1.5 rounded-lg bg-destructive/10 px-3 py-1.5 text-[13px] font-medium text-destructive transition-colors hover:bg-destructive/20 focus-visible:ring-2 focus-visible:ring-destructive/40 focus-visible:outline-none"
            >
              <LogOut className="size-3.5" /> Sign out
            </button>
          </div>
        </div>
      </div>
    )}
    </CoopChatProvider>
    </UploadQueueProvider>
    </PlaybookProvider>
  );
}
