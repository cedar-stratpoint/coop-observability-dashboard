'use client';

import {useMemo, useState} from 'react';
import {ArrowDown, ArrowUp, Search, Store} from 'lucide-react';
import type {SalesSummary, StoreRollup} from '@/src/goldline-analytics';
import {Card, CardContent, CardHeader, CardTitle} from '@/components/ui/card';
import {Pagination} from '@/components/analyst/pagination';
import {cn} from '@/lib/utils';
import {GL_TILES_MOBILE} from '@/src/goldline-ui';

// Store leaderboard for the active company: sales rolled up per store (from gl_sales),
// searchable and sortable. Derived entirely from props the server already scoped by
// company_id — no fetching here.

const PAGE_SIZE = 12;
const peso = (n: number) => `₱${Math.round(n).toLocaleString()}`;

type SortKey = 'gross' | 'units' | 'net' | 'name';

export function GoldlineStoresView({stores, summary}: {stores: StoreRollup[]; summary: SalesSummary}) {
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortKey>('gross');
  const [asc, setAsc] = useState(false);
  const [page, setPage] = useState(1);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = stores.filter(
      (s) => !q || s.name.toLowerCase().includes(q) || s.store_code.toLowerCase().includes(q),
    );
    const dir = asc ? 1 : -1;
    return [...filtered].sort((a, b) => {
      if (sort === 'name') return dir * a.name.localeCompare(b.name);
      return dir * (a[sort] - b[sort]);
    });
  }, [stores, query, sort, asc]);

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

  const Th = ({label, k, right}: {label: string; k: SortKey; right?: boolean}) => (
    <th className={cn('py-2 font-medium', right ? 'pl-3 text-right' : 'pr-3 text-left')}>
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
    <div className="mx-auto flex max-w-5xl flex-col gap-6 px-4 py-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-heading text-xl font-semibold tracking-tight">Stores</h1>
        <p className="text-sm text-muted-foreground">
          Sales by location for the current period
          {summary.periodStart && summary.periodEnd ? ` (${summary.periodStart} → ${summary.periodEnd})` : ''}.
        </p>
      </header>

      <div className={cn("grid grid-cols-2 gap-4 sm:grid-cols-4", GL_TILES_MOBILE)}>
        <Stat label="Stores" value={stores.length.toLocaleString()} />
        <Stat label="Gross sales" value={peso(summary.gross)} />
        <Stat label="Units" value={summary.units.toLocaleString()} />
        <Stat label="Net of VAT" value={peso(summary.net)} />
      </div>

      <Card>
        <CardHeader className="gap-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle>Leaderboard</CardTitle>
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
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {pageRows.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No stores yet. Upload a POS sales CSV to populate this.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b border-border text-xs text-muted-foreground">
                    <Th label="Store" k="name" />
                    <th className="py-2 pr-3 text-left font-medium">Region</th>
                    <Th label="Units" k="units" right />
                    <Th label="Gross" k="gross" right />
                    <Th label="Net of VAT" k="net" right />
                    <th className="py-2 pl-3 text-right font-medium">SKUs</th>
                  </tr>
                </thead>
                <tbody>
                  {pageRows.map((s) => (
                    <tr key={s.store_code} className="border-b border-border/60">
                      <td className="py-2.5 pr-3">
                        <span className="inline-flex items-center gap-2">
                          <Store className="size-4 shrink-0 text-muted-foreground" />
                          <span className="font-medium">{s.name}</span>
                          <span className="font-mono text-xs text-muted-foreground">#{s.store_code}</span>
                        </span>
                      </td>
                      <td className="py-2.5 pr-3 text-xs text-muted-foreground">{s.region ?? '—'}</td>
                      <td className="py-2.5 pl-3 text-right tabular-nums">{s.units.toLocaleString()}</td>
                      <td className="py-2.5 pl-3 text-right tabular-nums">{peso(s.gross)}</td>
                      <td className="py-2.5 pl-3 text-right tabular-nums">{peso(s.net)}</td>
                      <td className="py-2.5 pl-3 text-right tabular-nums text-muted-foreground">{s.skuCount}</td>
                    </tr>
                  ))}
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
