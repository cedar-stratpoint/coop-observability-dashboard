'use client';

import {useMemo, useState, useTransition} from 'react';
import {useRouter} from 'next/navigation';
import {ArrowDown, ArrowUp, Search} from 'lucide-react';
import type {SalesSummary, StoreRollup} from '@/src/goldline-analytics';
import type {StoreScope} from '@/src/goldline-ref-data';
import {setStoreScopeAction} from '@/app/stores/actions';
import {NativeSelect} from '@/components/ui/native-select';
import {Card, CardContent, CardHeader, CardTitle} from '@/components/ui/card';
import {Pagination} from '@/components/analyst/pagination';
import {cn} from '@/lib/utils';
import {GL_PAGE, GL_TILES_MOBILE, titleName} from '@/src/goldline-ui';

// Store leaderboard for the active company: sales rolled up per store (from sales),
// searchable and sortable, with each store's scope (F2, S2): in scope when it sold in
// the latest 3 loaded months, unless an admin switches it always in or always out.
// The restock (P3) only suggests for stores in scope.

const PAGE_SIZE = 25;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtMonth = (iso: string) => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;
type ScopeFilter = 'all' | 'in' | 'out';
const peso = (n: number) => `₱${Math.round(n).toLocaleString()}`;
type SortKey = 'gross' | 'units' | 'net' | 'name';

export function GoldlineStoresView({
  company,
  stores,
  summary,
  scope = [],
  canEditScope = false,
}: {
  company?: string;
  stores: StoreRollup[];
  summary: SalesSummary;
  scope?: StoreScope[];
  canEditScope?: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [notice, setNotice] = useState<{ok: boolean; text: string} | null>(null);
  const [scopeFilter, setScopeFilter] = useState<ScopeFilter>('all');
  const scopeOf = useMemo(() => new Map(scope.map((s) => [s.store_code, s])), [scope]);
  const inCount = scope.filter((s) => s.in_scope).length;
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortKey>('gross');
  const [asc, setAsc] = useState(false);
  const [page, setPage] = useState(1);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = stores.filter((s) => {
      if (q && !s.name.toLowerCase().includes(q) && !s.store_code.toLowerCase().includes(q)) return false;
      if (scopeFilter === 'all' || !scope.length) return true;
      return Boolean(scopeOf.get(s.store_code)?.in_scope) === (scopeFilter === 'in');
    });
    const dir = asc ? 1 : -1;
    return [...filtered].sort((a, b) => {
      if (sort === 'name') return dir * a.name.localeCompare(b.name);
      return dir * (a[sort] - b[sort]);
    });
  }, [stores, query, sort, asc, scopeFilter, scope.length, scopeOf]);

  function changeScope(store: string, value: 'auto' | 'in' | 'out') {
    setNotice(null);
    start(async () => {
      const res = await setStoreScopeAction({company: company ?? null, store, scope: value});
      setNotice(res.ok ? {ok: true, text: value === 'auto' ? 'Back to automatic.' : value === 'in' ? 'Always in scope.' : 'Always out of scope.'} : {ok: false, text: res.error});
      router.refresh();
    });
  }

  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const pageRows = rows.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  function toggleSort(key: SortKey) {
    if (key === sort) setAsc((a) => !a);
    else {
      setSort(key);
      setAsc(key === 'name');
    }
    setPage(1);
  }

  const showRegion = stores.some((s) => s.region);
  const rankOf = useMemo(() => new Map([...stores].sort((a, b) => b.gross - a.gross).map((s, i) => [s.store_code, i + 1])), [stores]);
  const topGross = Math.max(1, ...stores.map((s) => s.gross));

  const Th = ({label, k, right}: {label: string; k: SortKey; right?: boolean}) => (
    <th aria-sort={sort === k ? (asc ? 'ascending' : 'descending') : undefined} className={cn('h-10 px-3 font-medium', right ? 'text-right' : 'text-left')}>
      <button
        type="button"
        onClick={() => toggleSort(k)}
        className={cn('inline-flex items-center gap-1 hover:text-foreground', right && 'flex-row-reverse')}
      >
        {label}
        {sort === k && (asc ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />)}
      </button>
    </th>
  );

  return (
    <div className={GL_PAGE}>
      <header className="flex flex-col gap-1">
        <h1 className="font-heading text-xl font-semibold tracking-tight">Stores</h1>
        <p className="text-sm text-muted-foreground">
          Sales by location for the current period
          {summary.periodStart && summary.periodEnd ? ` (${summary.periodStart} to ${summary.periodEnd})` : ''}.
          {scope.length > 0 && ' A store is in scope when it sold anything in the last 3 months of POS Sales Data; restock only suggests for stores in scope.'}
        </p>
      </header>

      <div className={cn("grid grid-cols-2 gap-4 sm:grid-cols-4", GL_TILES_MOBILE)}>
        <Stat label={scope.length ? 'In scope' : 'Stores'} value={scope.length ? `${inCount.toLocaleString()} of ${scope.length.toLocaleString()}` : stores.length.toLocaleString()} />
        <Stat label="Gross sales" value={peso(summary.gross)} />
        <Stat label="Units" value={summary.units.toLocaleString()} />
        <Stat label="Net of VAT" value={peso(summary.net)} />
      </div>

      <Card>
        <CardHeader className="gap-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle>Leaderboard</CardTitle>
            <div className="flex flex-wrap items-center gap-2">
            {scope.length > 0 && (
              <div role="group" aria-label="Scope" className="flex gap-1.5">
                {(
                  [
                    ['all', 'All'],
                    ['in', 'In scope'],
                    ['out', 'Out of scope'],
                  ] as Array<[ScopeFilter, string]>
                ).map(([v, label]) => (
                  <button
                    key={v}
                    type="button"
                    aria-pressed={scopeFilter === v}
                    onClick={() => {
                      setScopeFilter(v);
                      setPage(1);
                    }}
                    className={cn(
                      'h-7 rounded-full border px-3 text-xs font-medium transition-[background-color,border-color,transform] duration-150 ease-out active:scale-[0.97]',
                      scopeFilter === v ? 'border-primary bg-primary text-primary-foreground' : 'border-border hover:border-foreground/30',
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setPage(1);
                }}
                placeholder="Search store…"
                className="h-8 w-56 rounded-md border border-border bg-background pr-2 pl-7 text-sm"
              />
            </div>
            </div>
          </div>
          {notice && (
            <p role="status" className={cn('text-xs', notice.ok ? 'text-muted-foreground' : 'text-destructive')}>
              {notice.text}
            </p>
          )}
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {pageRows.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No stores yet. Upload a POS sales CSV to populate this.
            </p>
          ) : (
            <div className="-mx-(--card-spacing) overflow-x-auto">
              <table className="w-full min-w-[46rem] border-collapse text-sm">
                <thead>
                  <tr className="border-y border-border/70 bg-muted/30 text-xs text-muted-foreground">
                    <th className="h-10 w-12 pr-1 pl-(--card-spacing) text-right font-medium" title="Rank by gross sales">
                      #
                    </th>
                    <Th label="Store" k="name" />
                    {showRegion && <th className="h-10 px-3 text-left font-medium">Region</th>}
                    <Th label="Units" k="units" right />
                    <Th label="Gross" k="gross" right />
                    <Th label="Net of VAT" k="net" right />
                    <th className="h-10 px-3 text-right font-medium">SKUs</th>
                    {scope.length > 0 && <th className="h-10 pr-(--card-spacing) pl-3 text-left font-medium">Scope</th>}
                  </tr>
                </thead>
                <tbody>
                  {pageRows.map((s) => {
                    const sc = scopeOf.get(s.store_code);
                    const out = scope.length > 0 && sc != null && !sc.in_scope;
                    return (
                      <tr key={s.store_code} className={cn('border-b border-border/40 transition-colors duration-150 last:border-0 hover:bg-muted/30', out && 'text-muted-foreground')}>
                        <td className="py-2.5 pr-1 pl-(--card-spacing) text-right font-mono text-xs tabular-nums text-muted-foreground">{rankOf.get(s.store_code)}</td>
                        <td className="max-w-[22rem] px-3 py-2.5">
                          <span className="flex min-w-0 items-baseline gap-2" title={s.name}>
                            <span className={cn('truncate', !out && 'text-foreground')}>{titleName(s.name)}</span>
                            <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{s.store_code}</span>
                          </span>
                        </td>
                        {showRegion && <td className="px-3 py-2.5 text-xs text-muted-foreground">{s.region ?? '—'}</td>}
                        <td className="px-3 py-2.5 text-right tabular-nums">{s.units.toLocaleString()}</td>
                        <td className="px-3 py-2.5 text-right">
                          {/* The bar is the store's gross against the top store's: rank at a glance. */}
                          <span className="inline-flex flex-col items-end gap-1">
                            <span className={cn('font-medium tabular-nums', !out && 'text-foreground')}>{peso(s.gross)}</span>
                            <span aria-hidden className="h-[3px] w-20 overflow-hidden rounded-full bg-muted">
                              <span className="block h-full rounded-full bg-primary/55" style={{width: `${Math.max(2, (s.gross / topGross) * 100)}%`}} />
                            </span>
                          </span>
                        </td>
                        <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">{peso(s.net)}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">{s.skuCount}</td>
                        {scope.length > 0 && (
                          <td className="py-2 pr-(--card-spacing) pl-3">
                            <ScopeCell sc={sc} canEdit={canEditScope} pending={pending} onChange={(v) => changeScope(s.store_code, v)} />
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <Pagination page={safePage} pageCount={pageCount} onPage={setPage} className="pt-1" />
        </CardContent>
      </Card>
    </div>
  );
}

function Stat({label, value}: {label: string; value: string}) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-1 py-1">
        <span className="text-xs text-muted-foreground">{label}</span>
        <span className="font-heading text-lg font-semibold tabular-nums">{value}</span>
      </CardContent>
    </Card>
  );
}

function ScopeCell({sc, canEdit, pending, onChange}: {sc: StoreScope | undefined; canEdit: boolean; pending: boolean; onChange: (v: 'auto' | 'in' | 'out') => void}) {
  if (!sc) return <span className="text-xs text-muted-foreground">—</span>;
  // Only say why when it isn't the usual case (in scope, automatic): 300 rows of
  // "sold in the last 3 months" is noise.
  const why = sc.override != null ? 'set by an admin' : sc.sold_recently ? null : sc.last_sale_month ? `no sales since ${fmtMonth(sc.last_sale_month)}` : 'no sales on file';
  const status = (
    <span className="flex min-w-0 flex-col">
      <span className="inline-flex items-center gap-1.5 text-xs font-medium whitespace-nowrap">
        <span aria-hidden className="size-1.5 shrink-0 rounded-full" style={{background: sc.in_scope ? 'var(--status-good)' : 'var(--muted-foreground)'}} />
        <span className={sc.in_scope ? 'text-foreground' : 'text-muted-foreground'}>{sc.in_scope ? 'In scope' : 'Out of scope'}</span>
      </span>
      {why && <span className="pl-3 text-[11px] whitespace-nowrap text-muted-foreground">{why}</span>}
    </span>
  );
  if (!canEdit) return status;
  return (
    <span className="flex items-center justify-between gap-3">
      {status}
      <NativeSelect
        aria-label="Scope setting"
        value={sc.override == null ? 'auto' : sc.override ? 'in' : 'out'}
        disabled={pending}
        onChange={(e) => onChange(e.target.value as 'auto' | 'in' | 'out')}
        className="h-7 w-[7.5rem] border-transparent bg-transparent text-xs text-muted-foreground shadow-none hover:border-border hover:text-foreground focus-visible:text-foreground"
      >
        <option value="auto">Automatic</option>
        <option value="in">Always in</option>
        <option value="out">Always out</option>
      </NativeSelect>
    </span>
  );
}
