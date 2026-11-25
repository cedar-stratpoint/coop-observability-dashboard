'use client';

// Every flag, with where it is (NICH-43 §3, §4; Syl, Nov 25): the page and row, why, which store
// and which BA, for the BA scorecard's checks and the review flags (reader and reviewer). Filters
// live in the URL so a view can be shared; the CSV takes the same filters, so "every flag for
// store 473" is one pick and one click. Each line opens its page.

import {useMemo, useState, useTransition} from 'react';
import Link from 'next/link';
import {useRouter} from 'next/navigation';
import {ArrowLeft, Download, ExternalLink, Flag, Search} from 'lucide-react';
import {cn} from '@/lib/utils';
import {GL_PAGE} from '@/src/goldline-ui';
import {FLAG_SOURCES, SOURCE_LABEL, filterLines, pageLabel, type FlagFilter, type FlagLine} from '@/src/goldline-flag-lines';
import type {FlagLinesData} from '@/src/goldline-flag-lines-data';
import {NativeSelect} from '@/components/ui/native-select';

const PAGE = 50;
const FIELD =
  'h-9 rounded-lg border border-border bg-card px-2.5 text-sm outline-none transition-colors duration-150 [@media(hover:hover)]:hover:border-foreground/25 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40';

const monthName = (m: string) => {
  const [y, mo] = m.split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1, 1)).toLocaleDateString('en-US', {month: 'short', year: 'numeric', timeZone: 'UTC'});
};

function toQuery(f: FlagFilter): string {
  const sp = new URLSearchParams();
  if (f.store) sp.set('store', f.store);
  if (f.month) sp.set('month', f.month);
  if (f.source) sp.set('source', f.source);
  if (f.open === 'all') sp.set('status', 'all');
  if (f.q) sp.set('q', f.q);
  return sp.toString();
}

export function FlagLines({data, initial}: {data: FlagLinesData; initial: FlagFilter}) {
  const router = useRouter();
  const [, start] = useTransition();
  const [f, setF] = useState<FlagFilter>(initial);
  const [page, setPage] = useState(0);
  const set = (next: Partial<FlagFilter>) => {
    const v = {...f, ...next};
    setF(v);
    setPage(0);
    const q = toQuery(v);
    start(() => router.replace(`/flags/review${q ? `?${q}` : ''}`, {scroll: false}));
  };
  const hits = useMemo(() => filterLines(data.lines, f), [data.lines, f]);
  const pages = Math.max(1, Math.ceil(hits.length / PAGE));
  const at = Math.min(page, pages - 1);
  const shown = hits.slice(at * PAGE, at * PAGE + PAGE);
  const stores = new Set(hits.map((l) => l.storeCode ?? '')).size;
  const q = toQuery(f);

  return (
    <div className={GL_PAGE}>
      <header className="flex flex-col gap-3">
        <Link href="/flags" className="inline-flex w-fit items-center gap-1.5 text-xs text-muted-foreground transition-colors duration-150 [@media(hover:hover)]:hover:text-foreground">
          <ArrowLeft aria-hidden className="size-3.5" /> Flags by BA
        </Link>
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="max-w-2xl">
            <h1 className="font-heading text-xl font-semibold tracking-tight">Every flag, page and row</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Coop&apos;s checks and the review flags from the reader and reviewers, each with the scan page and row it is on, why, the store and the BA. Review flags never count against the BA.
            </p>
          </div>
          {data.configured && hits.length > 0 && (
            <a
              href={`/api/goldline/flag-lines-export${q ? `?${q}` : ''}`}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border bg-card px-3 text-sm font-medium transition-[transform,border-color] duration-150 ease-out active:scale-[0.97] [@media(hover:hover)]:hover:border-foreground/25"
            >
              <Download aria-hidden className="size-4" /> CSV{f.store ? ` · Store ${f.store}` : ''}
            </a>
          )}
        </div>
      </header>

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">
          Store
          <NativeSelect value={f.store ?? 'all'} onChange={(e) => set({store: e.target.value === 'all' ? null : e.target.value})} className="min-w-44">
            <option value="all">Every store</option>
            {data.stores.map((s) => (
              <option key={s.code} value={s.code}>
                {s.code}
                {s.name ? ` · ${s.name}` : ''}
              </option>
            ))}
          </NativeSelect>
        </label>
        <label className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">
          Month
          <NativeSelect value={f.month ?? 'all'} onChange={(e) => set({month: e.target.value === 'all' ? null : e.target.value})}>
            <option value="all">Every month</option>
            {data.months.map((m) => (
              <option key={m} value={m}>
                {monthName(m)}
              </option>
            ))}
          </NativeSelect>
        </label>
        <label className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">
          From
          <NativeSelect value={f.source ?? 'all'} onChange={(e) => set({source: e.target.value === 'all' ? null : (e.target.value as FlagFilter['source'])})}>
            <option value="all">Checks and review flags</option>
            {FLAG_SOURCES.map((s) => (
              <option key={s} value={s}>
                {SOURCE_LABEL[s]}
              </option>
            ))}
          </NativeSelect>
        </label>
        <label className="flex flex-col gap-1.5 text-xs font-medium text-muted-foreground">
          Status
          <NativeSelect value={f.open} onChange={(e) => set({open: e.target.value === 'all' ? 'all' : 'open'})}>
            <option value="open">Open</option>
            <option value="all">Open and closed</option>
          </NativeSelect>
        </label>
        <div className="relative ml-auto">
          <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <input value={f.q} maxLength={80} onChange={(e) => set({q: e.target.value})} placeholder="Product, BA or file" aria-label="Search flags" className={cn(FIELD, 'w-56 pl-8')} />
        </div>
      </div>

      <section className="overflow-hidden rounded-xl border border-border bg-card">
        <div className="flex flex-wrap items-baseline gap-x-2 border-b border-border px-4 py-3 text-sm">
          <span className="font-heading font-semibold tabular-nums">{hits.length.toLocaleString('en-US')}</span>
          <span className="text-muted-foreground">
            {hits.length === 1 ? 'flag' : 'flags'} across {stores} {stores === 1 ? 'store' : 'stores'}
          </span>
        </div>
        {!data.configured ? (
          <p className="px-4 py-12 text-center text-sm text-muted-foreground">Connect the database to see flags.</p>
        ) : shown.length === 0 ? (
          <p className="px-4 py-12 text-center text-sm text-muted-foreground">No flags match. Try every store, every month, or open and closed.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[60rem] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                  <th className="py-2 pr-3 pl-4 font-medium">Where</th>
                  <th className="py-2 pr-3 font-medium">Row</th>
                  <th className="py-2 pr-3 font-medium">Why</th>
                  <th className="py-2 pr-3 font-medium">Store</th>
                  <th className="py-2 pr-3 font-medium">BA</th>
                  <th className="py-2 pr-3 font-medium">Month</th>
                  <th className="w-10 py-2 pr-3" aria-label="Open" />
                </tr>
              </thead>
              <tbody>
                {shown.map((l) => (
                  <Line key={l.key} l={l} />
                ))}
              </tbody>
            </table>
          </div>
        )}
        {pages > 1 && (
          <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
            <span className="tabular-nums">
              {at * PAGE + 1} to {Math.min(hits.length, at * PAGE + PAGE)} of {hits.length}
            </span>
            <span className="flex gap-2">
              <button type="button" disabled={at === 0} onClick={() => setPage(at - 1)} className={cn(FIELD, 'h-8 disabled:opacity-40')}>
                Previous
              </button>
              <button type="button" disabled={at >= pages - 1} onClick={() => setPage(at + 1)} className={cn(FIELD, 'h-8 disabled:opacity-40')}>
                Next
              </button>
            </span>
          </div>
        )}
      </section>
    </div>
  );
}

function Line({l}: {l: FlagLine}) {
  const where = pageLabel(l);
  const tone = l.source === 'check' ? 'var(--status-crit)' : 'var(--status-warn)';
  return (
    <tr className={cn('border-b border-border/60 align-top last:border-0', !l.open && 'text-muted-foreground')}>
      <td className="py-2.5 pr-3 pl-4">
        <span className="block font-medium">{where ?? 'No page'}</span>
        <span className="block max-w-[16rem] truncate text-xs text-muted-foreground" title={l.file ?? undefined}>
          {l.file ?? 'Not tied to a scan page'}
        </span>
      </td>
      <td className="py-2.5 pr-3">
        <span className="block max-w-[18rem] truncate">{l.product ?? l.itemCode ?? 'Whole page'}</span>
        {l.itemCode && <span className="block font-mono text-xs text-muted-foreground">{l.itemCode}</span>}
      </td>
      <td className="py-2.5 pr-3">
        <span className="inline-flex items-center gap-1.5 font-medium">
          <Flag aria-hidden className="size-3.5 shrink-0" style={{color: tone}} />
          {l.why}
        </span>
        <span className="block text-xs text-muted-foreground">
          {SOURCE_LABEL[l.source]}
          {l.note ? ` · ${l.note}` : ''}
          {l.open ? '' : l.source === 'check' ? ' · Resolved' : ' · Cleared'}
        </span>
      </td>
      <td className="py-2.5 pr-3">
        {l.storeCode ? (
          <>
            <span className="block font-mono text-xs">{l.storeCode}</span>
            {l.storeName && <span className="block max-w-[12rem] truncate text-xs text-muted-foreground">{l.storeName}</span>}
          </>
        ) : (
          <span className="text-xs text-muted-foreground">No store yet</span>
        )}
      </td>
      <td className="py-2.5 pr-3">{l.ba ?? <span className="text-xs text-muted-foreground">Not read</span>}</td>
      <td className="py-2.5 pr-3 tabular-nums">{l.month ? monthName(l.month) : '—'}</td>
      <td className="py-2.5 pr-3">
        {l.uploadId && (
          <Link href={`/uploads/${l.uploadId}`} aria-label={`Open ${where ?? 'the page'}`} className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 [@media(hover:hover)]:hover:bg-muted [@media(hover:hover)]:hover:text-foreground">
            <ExternalLink className="size-3.5" />
          </Link>
        )}
      </td>
    </tr>
  );
}
