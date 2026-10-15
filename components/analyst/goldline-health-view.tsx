'use client';

import {useMemo, useState} from 'react';
import Link from 'next/link';
import {Upload} from 'lucide-react';
import type {FormTimeliness, StoreHealth} from '@/src/goldline-movement';
import {metricValueClass, Metric} from '@/components/analyst/metric';
import {SegmentedControl} from '@/components/analyst/segmented-control';
import {Card, CardContent} from '@/components/ui/card';
import {buttonVariants} from '@/components/ui/button';
import {cn} from '@/lib/utils';
import {compactPeso, fmtRange, ToneChip} from '@/components/analyst/goldline-ops-shared';
import {GL_TILES_MOBILE} from '@/src/goldline-ui';

// Goldline store & stock health (plan §04 "Business Health", redefined for data Goldline
// actually has — no orders/CAC, so no QRR). One score per store for the current form
// period, from in-stock rate, days of cover, dead stock and whether the form came in on
// time; the company score is the average of stores that have a count.

export type HealthRow = {storeCode: string; storeName: string | null; health: StoreHealth};

const scoreTone = (s: number | null) => (s == null ? null : s >= 80 ? 'var(--status-good)' : s >= 60 ? 'var(--status-warn)' : 'var(--status-crit)');
const FORM: Record<FormTimeliness, {label: string; tone: string | null}> = {
  on_time: {label: 'On time', tone: 'var(--status-good)'},
  late: {label: 'Late', tone: 'var(--status-warn)'},
  missing: {label: 'Missing', tone: 'var(--status-crit)'},
};
const pct = (f: number | null) => (f == null ? '—' : `${Math.round(f * 100)}%`);
const days = (d: number | null) => (d == null ? '—' : Number.isFinite(d) ? `${Math.round(d)}d` : 'no sales');

export function GoldlineHealthView({rows, period, canEdit}: {rows: HealthRow[]; period: {start: string; end: string} | null; canEdit: boolean}) {
  const [sort, setSort] = useState<'worst' | 'store'>('worst');
  const scored = rows.filter((r) => r.health.score != null);
  const score = scored.length ? Math.round(scored.reduce((a, r) => a + (r.health.score as number), 0) / scored.length) : null;
  const tone = scoreTone(score);
  const onTime = rows.filter((r) => r.health.form === 'on_time').length;
  const deadValue = rows.reduce((a, r) => a + r.health.deadStockValue, 0);
  const stockValue = rows.reduce((a, r) => a + r.health.stockValue, 0);
  const inStock = scored.length ? scored.reduce((a, r) => a + (r.health.inStockRate ?? 0), 0) / scored.length : null;
  const covers = scored.map((r) => r.health.medianCoverDays).filter((d): d is number => d != null && Number.isFinite(d)).sort((a, b) => a - b);
  const cover = covers.length ? covers[Math.floor(covers.length / 2)] : null;

  const ordered = useMemo(
    () =>
      [...rows].sort((a, b) =>
        sort === 'store'
          ? a.storeCode.localeCompare(b.storeCode, undefined, {numeric: true})
          : (a.health.score ?? -1) - (b.health.score ?? -1) || a.storeCode.localeCompare(b.storeCode, undefined, {numeric: true}),
      ),
    [rows, sort],
  );

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-6">
      <header className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="font-heading text-2xl font-semibold tracking-tight">Store health</h1>
          <p className="font-mono text-xs text-muted-foreground">
            {period ? `form period ${fmtRange(period.start, period.end)} · stock, cover and on-time forms` : 'no counts yet'}
          </p>
        </div>
        <div className="h-0.5 w-24 rounded-full bg-gradient-to-r from-primary to-transparent" aria-hidden />
      </header>

      {!period ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 px-6 py-12 text-center">
            <h2 className="font-heading text-base font-semibold">No counts yet</h2>
            <p className="max-w-md text-sm text-muted-foreground">
              Health is scored from each store&apos;s committed inventory count. Commit a store&apos;s form to see its score here.
            </p>
            {canEdit && (
              <Link href="/uploads" className={cn(buttonVariants({size: 'sm'}), 'mt-1')}>
                <Upload className="size-4" /> Upload a scan
              </Link>
            )}
          </CardContent>
        </Card>
      ) : (
        <>
          <section aria-label="Company health" className="grid gap-4 lg:grid-cols-[minmax(14rem,18rem)_1fr]">
            <Card
              className="justify-center"
              style={tone ? {borderColor: `color-mix(in oklab, ${tone} 35%, transparent)`, background: `color-mix(in oklab, ${tone} 6%, var(--card))`} : undefined}
            >
              <CardContent className="flex flex-col gap-1">
                <span className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Health score</span>
                <span className={cn(metricValueClass, 'text-6xl')} style={tone ? {color: tone} : undefined}>
                  {score ?? '—'}
                </span>
                <span className="text-xs text-muted-foreground">
                  {scored.length
                    ? `average of ${scored.length} ${scored.length === 1 ? 'store' : 'stores'} with a count this period`
                    : 'no store has a count this period'}
                </span>
              </CardContent>
            </Card>
            <div className={cn("grid grid-cols-2 gap-4", GL_TILES_MOBILE)}>
              <Metric label="In stock" value={pct(inStock)} sub="of counted items have stock" />
              <Metric label="Typical cover" value={days(cover)} sub={cover == null ? 'needs two counts' : 'median days of stock'} />
              <Metric label="Dead stock" value={compactPeso(deadValue)} sub={stockValue ? `${pct(deadValue / stockValue)} of stock value` : 'no movement data yet'} />
              <Metric label="Forms on time" value={`${onTime}/${rows.length}`} sub="committed within 3 days of period end" />
            </div>
          </section>

          <Card className="py-0">
            <CardContent className="flex flex-col gap-3 px-0 pt-4 pb-3">
              <div className="flex items-center justify-between gap-2 px-4">
                <span className="text-sm font-medium">Stores ({rows.length})</span>
                <SegmentedControl<'worst' | 'store'>
                  ariaLabel="Sort stores"
                  value={sort}
                  onChange={setSort}
                  options={[
                    {value: 'worst', label: 'Needs attention first'},
                    {value: 'store', label: 'By store'},
                  ]}
                />
              </div>
              {/* Phones: one card per store (the table is too wide to read). */}
              <ul role="list" className="flex flex-col divide-y divide-border border-t border-border md:hidden">
                {ordered.map(({storeCode, storeName, health: h}) => (
                  <li key={storeCode} className="relative flex flex-col gap-2 px-4 py-3">
                    <div className="flex items-start justify-between gap-2">
                      <Link
                        href={`/stock?store=${encodeURIComponent(storeCode)}`}
                        className="font-medium outline-none after:absolute after:inset-0 after:content-[''] focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset"
                      >
                        {storeName ? `${storeCode} · ${storeName}` : `Store ${storeCode}`}
                      </Link>
                      <span className="flex shrink-0 items-center gap-1.5">
                        {h.score == null ? <span className="text-xs text-muted-foreground">no count</span> : <ToneChip tone={scoreTone(h.score)}>{h.score}</ToneChip>}
                        <ToneChip tone={FORM[h.form].tone}>{FORM[h.form].label}</ToneChip>
                      </span>
                    </div>
                    <dl className="grid grid-cols-4 gap-x-3 text-xs">
                      {[
                        ['In stock', pct(h.inStockRate)],
                        ['Cover', days(h.medianCoverDays)],
                        ['Dead stock', h.deadStockValue ? compactPeso(h.deadStockValue) : '—'],
                        ['Low · out', h.score == null ? '—' : `${h.low - h.out} · ${h.out}`],
                      ].map(([k, v]) => (
                        <div key={k} className="flex flex-col">
                          <dt className="text-[10.5px] text-muted-foreground">{k}</dt>
                          <dd className="font-mono tabular-nums">{v}</dd>
                        </div>
                      ))}
                    </dl>
                  </li>
                ))}
              </ul>
              <div className="overflow-x-auto max-md:hidden">
                <table className="w-full border-collapse text-sm">
                  <thead>
                    <tr className="border-y border-border bg-muted/40 text-left text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                      <th className="py-2 pr-3 pl-4 font-medium">Store</th>
                      <th className="py-2 pr-3 text-right font-medium">Score</th>
                      <th className="py-2 pr-3 text-right font-medium">In stock</th>
                      <th className="py-2 pr-3 text-right font-medium">Cover</th>
                      <th className="py-2 pr-3 text-right font-medium">Dead stock</th>
                      <th className="py-2 pr-3 text-right font-medium">Low · Out</th>
                      <th className="py-2 pr-4 text-right font-medium">Form</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ordered.map(({storeCode, storeName, health: h}) => (
                      <tr key={storeCode} className="border-b border-border/60 last:border-b-0 hover:bg-muted/30">
                        <td className="py-2 pr-3 pl-4">
                          <Link href={`/stock?store=${encodeURIComponent(storeCode)}`} className="font-medium underline-offset-4 hover:underline">
                            {storeName ? `${storeCode} · ${storeName}` : `Store ${storeCode}`}
                          </Link>
                        </td>
                        <td className="py-2 pr-3 text-right">
                          {h.score == null ? (
                            <span className="text-xs text-muted-foreground">no count</span>
                          ) : (
                            <ToneChip tone={scoreTone(h.score)}>{h.score}</ToneChip>
                          )}
                        </td>
                        <td className="py-2 pr-3 text-right font-mono text-xs tabular-nums">{pct(h.inStockRate)}</td>
                        <td className="py-2 pr-3 text-right font-mono text-xs tabular-nums">{days(h.medianCoverDays)}</td>
                        <td className="py-2 pr-3 text-right font-mono text-xs tabular-nums">{h.deadStockValue ? compactPeso(h.deadStockValue) : '—'}</td>
                        <td className="py-2 pr-3 text-right font-mono text-xs tabular-nums">{h.score == null ? '—' : `${h.low - h.out} · ${h.out}`}</td>
                        <td className="py-2 pr-4 text-right">
                          <ToneChip tone={FORM[h.form].tone}>{FORM[h.form].label}</ToneChip>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>

          <p className="text-xs leading-relaxed text-muted-foreground">
            Score out of 100: in-stock rate 40 · days of cover 25 (full marks at a cycle or more) · stock that&apos;s moving 15 · form
            committed within 3 days of the period end 20 (late counts half). Cover and dead stock need two counts; until then they score
            neutral so a new store isn&apos;t penalised. A store with no count for the period has no score.
          </p>
        </>
      )}
    </div>
  );
}
