import Link from 'next/link';
import {FileSpreadsheet, Store} from 'lucide-react';
import {getDataContext} from '@/src/active-context';
import {canEditData} from '@/src/company';
import {getGoldlineOverviewData} from '@/src/goldline-analytics';
import {greetingFor, type OverviewKpi} from '@/src/goldline-overview';
import {Metric} from '@/components/analyst/metric';
import {GoldlineCategories} from '@/components/analyst/goldline-categories';
import {Card, CardContent} from '@/components/ui/card';
import {buttonVariants} from '@/components/ui/button';
import {cn} from '@/lib/utils';
import {GL_TILES_MOBILE} from '@/src/goldline-ui';

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

/** Hour 0–23 in Manila, where Goldline's stores are. */
function manilaHour(): number {
  return Number(new Intl.DateTimeFormat('en-US', {hour: 'numeric', hourCycle: 'h23', timeZone: 'Asia/Manila'}).format(new Date()));
}

// Goldline (non-Zoomy company) Overview, per plan §07a: greeting + window + stores
// live, three KPI tiles with change vs the previous period, and top categories.
// Reads gl_sales / gl_products / gl_stores scoped to the active company. With no
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

  const {companyName, storesLive, overview: o} = await getGoldlineOverviewData(ctx.companyId);
  const firstName = companyName.split(/\s+/)[0] || companyName;
  const window = fmtWindow(o.window.start, o.window.end);
  const canEdit = canEditData(ctx.role);

  const sub = (k: OverviewKpi) => {
    if (!o.hasSales) return 'No sales yet';
    if (!o.hasPrior) return 'First period on record';
    if (!o.priorComparable) return 'No like-for-like previous period';
    if (k.deltaPct == null) return 'No prior figure to compare';
    return 'vs previous period';
  };

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 px-4 py-6">
      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex flex-col gap-1">
            <h1 className="font-heading text-2xl font-semibold tracking-tight text-balance">
              {greetingFor(manilaHour())}, {firstName}
            </h1>
            <p className="font-mono text-xs text-muted-foreground">
              {window ? `Sales window · ${window}` : 'Waiting for your first sales upload'}
            </p>
          </div>
          <StoresPill count={storesLive} />
        </div>
        <div className="h-0.5 w-24 rounded-full bg-gradient-to-r from-primary to-transparent" aria-hidden />
      </header>

      <section aria-label="Sales this window" className={`grid gap-4 sm:grid-cols-3 max-sm:grid-cols-2 max-sm:[&>*:last-child]:col-span-2 ${GL_TILES_MOBILE}`}>
        <Metric
          label="Net sales"
          value={o.hasSales ? peso(o.net.current) : '—'}
          delta={o.net.deltaPct ?? undefined}
          sub={sub(o.net)}
        />
        <Metric
          label="Units sold"
          value={o.hasSales ? compact(o.units.current) : '—'}
          delta={o.units.deltaPct ?? undefined}
          sub={sub(o.units)}
        />
        <Metric
          label="Gross sales"
          value={o.hasSales ? peso(o.gross.current) : '—'}
          delta={o.gross.deltaPct ?? undefined}
          sub={sub(o.gross)}
        />
      </section>

      {o.categories.length > 0 ? (
        <GoldlineCategories categories={o.categories} unmappedSkus={o.unmappedSkus} />
      ) : (
        <EmptySales canEdit={canEdit} hasSales={o.hasSales} />
      )}
    </div>
  );
}

function StoresPill({count}: {count: number}) {
  const live = count > 0;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-3 py-1 font-mono text-xs font-medium tabular-nums',
        live ? 'bg-[color-mix(in_oklab,var(--status-good)_14%,transparent)]' : 'bg-muted text-muted-foreground',
      )}
      style={live ? {color: 'var(--status-good)'} : undefined}
    >
      <Store className="size-3.5" aria-hidden />
      {live ? `${count} ${count === 1 ? 'store' : 'stores'} live` : 'No stores live yet'}
    </span>
  );
}

function EmptySales({canEdit, hasSales}: {canEdit: boolean; hasSales: boolean}) {
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-3 px-6 py-12 text-center">
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
      </CardContent>
    </Card>
  );
}
