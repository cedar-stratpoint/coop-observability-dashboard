import Link from 'next/link';
import {ArrowDownRight, ArrowUpRight, ChevronRight, FileSpreadsheet, Package, Receipt, Store, Wallet} from 'lucide-react';
import {getDataContext} from '@/src/active-context';
import {canEditData} from '@/src/company';
import {getGoldlineOverviewData, type TrendMonth} from '@/src/goldline-analytics';
import {greetingFor, type OverviewKpi} from '@/src/goldline-overview';
import {GoldlineCategories} from '@/components/analyst/goldline-categories';
import {buttonVariants} from '@/components/ui/button';
import {cn} from '@/lib/utils';
import {GL_CARD_CUE, GL_CARD_LINK, GL_PAGE} from '@/src/goldline-ui';

export const dynamic = 'force-dynamic';

const compact = (n: number) => new Intl.NumberFormat('en', {notation: 'compact', maximumFractionDigits: 1}).format(n);
const peso = (n: number) => `₱${compact(n)}`;

/** "Sep 16 – Sep 30, 2026" from two ISO dates (UTC so the day never shifts). */
function fmtWindow(start: string | null, end: string | null): string | null {
  if (!end) return null;
  const d = (s: string) => new Date(`${s}T00:00:00Z`);
  const md = (s: string) => d(s).toLocaleDateString('en-US', {month: 'short', day: '2-digit', timeZone: 'UTC'});
  const year = d(end).getUTCFullYear();
  return start && start !== end ? `${md(start)} to ${md(end)}, ${year}` : `${md(end)}, ${year}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A whole calendar month reads as "September 2026"; anything else as the date range. */
function windowLabel(start: string | null, end: string | null): string | null {
  if (!end) return null;
  const lastDay = new Date(Date.UTC(Number(end.slice(0, 4)), Number(end.slice(5, 7)), 0)).getUTCDate();
  if (start && start.slice(0, 7) === end.slice(0, 7) && start.endsWith('-01') && Number(end.slice(8, 10)) === lastDay)
    return `${FULL[Number(end.slice(5, 7)) - 1]} ${end.slice(0, 4)}`;
  return fmtWindow(start, end);
}

/** Hour 0–23 in Manila, where Goldline's stores are. */
function manilaHour(): number {
  return Number(new Intl.DateTimeFormat('en-US', {hour: 'numeric', hourCycle: 'h23', timeZone: 'Asia/Manila'}).format(new Date()));
}

// Goldline (non-Zoomy company) Overview, per plan §07a: greeting + window + stores
// live, three KPI tiles with change vs the previous period, and top categories.
// Reads sales / products / stores scoped to the active company. With no
// sales yet it keeps the same frame (greeting, pill, "—" tiles) and swaps the
// categories for an upload prompt, so the page never looks broken.
export default async function Page() {
  const ctx = await getDataContext();
  if (!ctx || !ctx.companyId) {
    return (
      <div className="mx-auto flex min-h-[50vh] max-w-md flex-col items-center justify-center gap-2 text-center">
        <h1 className="font-heading text-lg font-semibold">No company in view</h1>
        <p className="text-sm text-muted-foreground">Pick a company you belong to to see its overview.</p>
      </div>
    );
  }

  const {companyName, storesLive, overview: o, trend} = await getGoldlineOverviewData(ctx.companyId);
  const firstName = companyName.split(/\s+/)[0] || companyName;
  const window = windowLabel(o.window.start, o.window.end);
  const canEdit = canEditData(ctx.role);

  const sub = (k: OverviewKpi, fmt: (n: number) => string) => {
    if (!o.hasSales) return 'No sales yet';
    if (!o.hasPrior) return 'First period on record';
    if (!o.priorComparable) return 'No like-for-like previous period';
    if (k.deltaPct == null || k.prior == null) return 'No prior figure to compare';
    return `vs ${fmt(k.prior)} the period before`;
  };

  return (
    <div className={GL_PAGE}>
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex flex-col gap-1.5">
          <h1 className="font-heading text-3xl font-semibold tracking-tight text-balance">
            {greetingFor(manilaHour())}, {firstName}
          </h1>
          <p className="text-sm text-muted-foreground">{window ? `Watsons sales for ${window}` : 'Waiting for your first sales upload'}</p>
        </div>
        <StoresPill count={storesLive} />
      </header>

      <section aria-label="Sales this window" className="grid grid-cols-2 gap-3 sm:grid-cols-3 max-sm:[&>*:last-child]:col-span-2">
        <KpiTile href="/stores?sort=net" Icon={Wallet} label="Net sales" value={o.hasSales ? peso(o.net.current) : '—'} delta={o.net.deltaPct} sub={sub(o.net, peso)} />
        <KpiTile href="/stores?sort=units" Icon={Package} label="Units sold" value={o.hasSales ? compact(o.units.current) : '—'} delta={o.units.deltaPct} sub={sub(o.units, compact)} />
        <KpiTile href="/stores?sort=gross" Icon={Receipt} label="Gross sales" value={o.hasSales ? peso(o.gross.current) : '—'} delta={o.gross.deltaPct} sub={sub(o.gross, peso)} />
      </section>

      {o.categories.length > 0 ? (
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
          {trend.length > 0 && <TrendCard trend={trend} />}
          <GoldlineCategories categories={o.categories} unmappedSkus={o.unmappedSkus} />
        </div>
      ) : (
        <EmptySales canEdit={canEdit} hasSales={o.hasSales} />
      )}
    </div>
  );
}

/** A KPI: tinted icon, big value, the change as a small pill, and what it's compared with.
 *  The tile opens Stores ranked by the same figure. */
function KpiTile({href, Icon, label, value, delta, sub}: {href: string; Icon: typeof Wallet; label: string; value: string; delta: number | null; sub: string}) {
  const up = delta != null && delta >= 0;
  const tone = up ? 'var(--status-good)' : 'var(--status-crit)';
  return (
    <Link href={href} aria-label={`${label}: ${value}. See sales by store`} className={cn(GL_CARD_LINK, 'flex min-w-0 flex-col gap-4 rounded-xl border bg-card px-5 py-5 max-sm:gap-3 max-sm:px-4 max-sm:py-4')}>
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-2.5 text-sm font-medium">
          <span className="grid size-8 place-items-center rounded-full bg-primary/12 text-primary transition-colors duration-200 group-hover/card:bg-primary/20">
            <Icon aria-hidden className="size-4" />
          </span>
          {label}
        </span>
        {delta != null && (
          <span className="inline-flex items-center gap-0.5 rounded-full px-2 py-0.5 text-xs font-medium tabular-nums" style={{color: tone, background: `color-mix(in oklab, ${tone} 14%, transparent)`}}>
            {up ? <ArrowUpRight aria-hidden className="size-3.5" /> : <ArrowDownRight aria-hidden className="size-3.5" />}
            {up ? '+' : ''}
            {delta}%
          </span>
        )}
      </div>
      <div className="flex flex-col gap-1">
        <p className="font-heading text-3xl font-semibold tracking-tight tabular-nums max-sm:text-2xl">{value}</p>
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <p className="text-xs text-muted-foreground">{sub}</p>
          <span className={GL_CARD_CUE} aria-hidden>
            By store <ChevronRight className="size-3.5" />
          </span>
        </div>
      </div>
    </Link>
  );
}

/** Units sold per month for the last 12 months; the latest month stands out, a missing month
 *  is dashed. Each loaded month is its own link to that month's store leaderboard: hovering
 *  one lifts it out (its figure rises in, the other months fade back). */
function TrendCard({trend}: {trend: TrendMonth[]}) {
  const max = Math.max(1, ...trend.map((t) => t.units));
  const latest = trend[trend.length - 1];
  const peak = trend.reduce((a, t) => (t.units > a.units ? t : a), trend[0]);
  const avg = trend.filter((t) => t.loaded).reduce((a, t, _, arr) => a + t.units / arr.length, 0);
  const EASE = 'ease-[cubic-bezier(0.23,1,0.32,1)]';
  return (
    <section aria-labelledby="trend-title" className="flex min-w-0 flex-col gap-5 rounded-xl border bg-card px-6 py-5 max-sm:px-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="trend-title" className="font-heading text-lg font-semibold tracking-tight">
          Units sold, last 12 months
        </h2>
        <p className="text-xs text-muted-foreground tabular-nums">
          Peak {MONTHS[Number(peak.month.slice(5, 7)) - 1]} {compact(peak.units)} · monthly average {compact(avg)}
        </p>
      </div>
      <ol className="flex min-h-56 flex-1 gap-1 sm:gap-2" aria-label="Units sold per month. Pick a month to see its stores.">
        {trend.map((t, i) => {
          const isLatest = t === latest;
          const isPeak = t === peak;
          const mon = MONTHS[Number(t.month.slice(5, 7)) - 1];
          const full = `${FULL[Number(t.month.slice(5, 7)) - 1]} ${t.month.slice(0, 4)}`;
          const h = t.loaded ? Math.max(4, (t.units / max) * 100) : 18;
          const always = isLatest || isPeak;
          const column = (
            <>
              {/* Track: the bar grows from the bottom; the top 24px leaves room for the peak's figure. */}
              <span className="relative w-full flex-1">
                <span className="absolute inset-x-0 top-6 bottom-0">
                  <span
                    aria-hidden
                    className={cn(
                      'absolute inset-x-0 text-center text-[11px] tabular-nums transition-[opacity,translate,color] duration-200',
                      EASE,
                      always ? 'font-medium text-foreground' : 'translate-y-1 text-muted-foreground opacity-0 group-hover/bar:translate-y-0 group-hover/bar:text-foreground group-hover/bar:opacity-100 group-focus-visible/bar:translate-y-0 group-focus-visible/bar:opacity-100 motion-reduce:translate-y-0',
                    )}
                    style={{bottom: `calc(${h}% + 6px)`}}
                  >
                    {t.loaded ? compact(t.units) : ''}
                  </span>
                  <span
                    aria-hidden
                    className={cn(
                      'absolute inset-x-0 bottom-0 origin-bottom rounded-md transition-[background-color,box-shadow,scale] duration-200',
                      EASE,
                      !t.loaded
                        ? 'border border-dashed border-border'
                        : isLatest
                          ? 'bg-primary group-hover/bar:shadow-[0_0_0_3px_color-mix(in_oklab,var(--primary)_22%,transparent)]'
                          : 'bg-primary/30 group-hover/bar:bg-primary/70 group-hover/bar:shadow-[0_0_0_3px_color-mix(in_oklab,var(--primary)_16%,transparent)] group-focus-visible/bar:bg-primary/70',
                      t.loaded && 'group-active/bar:scale-y-[0.98] group-active/bar:duration-100 motion-reduce:group-active/bar:scale-y-100',
                      'group-focus-visible/bar:ring-2 group-focus-visible/bar:ring-ring group-focus-visible/bar:ring-offset-2 group-focus-visible/bar:ring-offset-card',
                    )}
                    style={{height: `${h}%`}}
                  />
                </span>
              </span>
              <span
                className={cn(
                  'h-8 text-center text-[11px] text-muted-foreground transition-colors duration-200',
                  isLatest && 'font-medium text-foreground',
                  t.loaded && 'group-hover/bar:text-foreground',
                )}
              >
                {mon}
                {(i === 0 || t.month.slice(5, 7) === '01') && <span className="block text-[10px] tabular-nums">{t.month.slice(0, 4)}</span>}
              </span>
            </>
          );
          return (
            <li key={t.month} className="flex min-w-0 flex-1">
              {t.loaded ? (
                <Link
                  href={`/stores?month=${t.month.slice(0, 7)}&sort=units`}
                  aria-label={`${full}: ${t.units.toLocaleString('en-US')} units. See stores for ${full}`}
                  className={cn(
                    'group/bar flex min-w-0 flex-1 flex-col items-center gap-2 outline-none transition-opacity duration-200',
                    EASE,
                    // The other months fade back while one is hovered or focused (pointer devices).
                    'pointer-fine:[ol:has(a:hover)_&:not(:hover)]:opacity-50 [ol:has(a:focus-visible)_&:not(:focus-visible)]:opacity-50',
                  )}
                >
                  {column}
                </Link>
              ) : (
                <div
                  aria-label={`${full}: not loaded`}
                  className="group/bar flex min-w-0 flex-1 flex-col items-center gap-2 transition-opacity duration-200 pointer-fine:[ol:has(a:hover)_&]:opacity-50"
                >
                  {column}
                </div>
              )}
            </li>
          );
        })}
      </ol>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-4">
        <p className="text-xs text-muted-foreground">Pick a month to see its stores.</p>
        <Link href="/stores?sort=units" className={cn(GL_CARD_CUE, 'group/card rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring')}>
          Units by store, all months <ChevronRight className="size-3.5" />
        </Link>
      </div>
    </section>
  );
}

function StoresPill({count}: {count: number}) {
  const live = count > 0;
  return (
    <Link
      href="/stores"
      className={cn(
        'group/pill inline-flex items-center gap-1.5 self-start rounded-full px-3 py-1 text-xs font-medium tabular-nums outline-none sm:self-auto',
        'ring-1 ring-transparent transition-[box-shadow,background-color,scale] duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] active:scale-[0.97] active:duration-100 focus-visible:ring-2 focus-visible:ring-ring motion-reduce:active:scale-100',
        live
          ? 'bg-[color-mix(in_oklab,var(--status-good)_14%,transparent)] hover:bg-[color-mix(in_oklab,var(--status-good)_22%,transparent)] hover:ring-[color-mix(in_oklab,var(--status-good)_35%,transparent)]'
          : 'bg-muted text-muted-foreground hover:ring-border',
      )}
      style={live ? {color: 'var(--status-good)'} : undefined}
    >
      <Store className="size-3.5" aria-hidden />
      {live ? `${count} ${count === 1 ? 'store' : 'stores'} live` : 'No stores live yet'}
      <ChevronRight className="-mr-1 size-3.5 opacity-60 transition-[translate,opacity] duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] group-hover/pill:translate-x-0.5 group-hover/pill:opacity-100 motion-reduce:group-hover/pill:translate-x-0" aria-hidden />
    </Link>
  );
}

function EmptySales({canEdit, hasSales}: {canEdit: boolean; hasSales: boolean}) {
  return (
    <div className="rounded-xl border border-dashed">
      <div className="flex flex-col items-center gap-3 px-6 py-14 text-center">
        <span className="flex size-11 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <FileSpreadsheet className="size-5" aria-hidden />
        </span>
        <div className="flex max-w-sm flex-col gap-1">
          <h2 className="font-heading text-base font-semibold">
            {hasSales ? 'No category sales in this window' : 'No sales data yet'}
          </h2>
          <p className="text-sm text-muted-foreground">
            {hasSales
              ? 'This window has no net sales to break down by product line.'
              : 'Upload your POS sales export (.csv) and this page fills in with net and gross sales, units sold, and your top product categories.'}
          </p>
        </div>
        {!hasSales &&
          (canEdit ? (
            <Link href="/uploads" className={cn(buttonVariants({size: 'sm'}), 'mt-1')}>
              Upload sales CSV
            </Link>
          ) : (
            <p className="text-xs text-muted-foreground">Ask a Company User to upload a sales export.</p>
          ))}
      </div>
    </div>
  );
}
