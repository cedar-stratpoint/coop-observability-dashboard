// BoxMe (Online) channel of /inventory. Server component: freshness labels are
// computed here (one clock, no hydration drift); the interactive table is the
// client BoxmeInventoryTable. Mirrors the Stratpoint header so the two channels
// read as one page. Data: src/boxme-inventory-data.ts.

import Link from 'next/link';
import {AlertTriangle, ExternalLink, Globe, KeyRound, PackageX} from 'lucide-react';
import {cn} from '@/lib/utils';
import {Card, CardContent} from '@/components/ui/card';
import {fmtDate, fmtManilaWhen, syncPill, type Tone} from '@/src/boxme-format';
import {KEY_WARN_DAYS} from '@/src/boxme-inventory-compute';
import type {BoxmePageData} from '@/src/boxme-inventory-data';
import {BoxmeInventoryTable} from './boxme-inventory-table';

const TONE_DOT: Record<Tone, string> = {
  good: 'bg-emerald-500',
  warn: 'bg-amber-500',
  crit: 'bg-red-500',
  muted: 'bg-muted-foreground/50',
};

export function BoxmeInventoryView({data}: {data: BoxmePageData}) {
  const now = new Date();
  const pill = syncPill(data.sync, now);
  const hasData = data.connected && data.sync.lastGoodStartedAt != null;
  const warehouseNames = data.warehouses.map((w) => w.pickup_name || w.warehouse_code || w.pickup_id).join(', ');

  return (
    <div className="mx-auto max-w-6xl px-6 pt-8 md:px-10 max-md:px-4 max-md:pt-6">
      <header className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            <Globe className="size-3.5" /> Online inventory · BoxMe fulfilment
            {data.usingMock && <span className="text-amber-600 dark:text-amber-400">· demo data</span>}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-3">
            <h1 className="text-3xl font-semibold tracking-tight">Inventory</h1>
            <div className="inline-flex rounded-md border p-0.5">
              <Link href="/inventory" scroll={false} className="flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground">
                Stratpoint <span className="font-mono text-[9px] opacity-70">offline</span>
              </Link>
              <span aria-current="page" className="flex items-center gap-1.5 rounded bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground">
                BoxMe <span className="font-mono text-[9px] opacity-70">online</span>
              </span>
            </div>
            <span className="inline-flex items-center gap-2 rounded-full border bg-background px-2.5 py-1 text-[11px]" title={data.sync.lastRunAt ? `Last run ${fmtManilaWhen(data.sync.lastRunAt, now)} (Manila)` : undefined}>
              <span aria-hidden className={cn('size-1.5 rounded-full', TONE_DOT[pill.tone])} />
              <span className="font-medium">{pill.label}</span>
              {hasData && (
                <span className="text-muted-foreground">
                  · {data.summary.total} SKUs{warehouseNames && ` · ${warehouseNames}`}
                </span>
              )}
            </span>
          </div>
        </div>
        <a href="https://oms.boxme.asia" target="_blank" rel="noreferrer"
          className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground">
          Open BoxMe OMS <ExternalLink className="size-3.5" />
        </a>
      </header>

      <SyncBanner data={data} now={now} />

      {hasData && (
        <>
          <LedgerStrip totals={data.totals} />
          <BoxmeInventoryTable rows={data.rows} summary={data.summary} />
          <div className="mt-6 grid gap-4 md:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
            <ExpiringCard data={data} />
            <MatchCard data={data} />
          </div>
        </>
      )}
    </div>
  );
}

/** Stale / failed / partial / never / key-expiry notices. Nothing when all is well. */
function SyncBanner({data, now}: {data: BoxmePageData; now: Date}) {
  const {sync} = data;
  const notes: {tone: 'warn' | 'crit' | 'muted'; icon: React.ReactNode; title: string; body: React.ReactNode}[] = [];

  if (!data.connected) {
    notes.push({
      tone: 'muted', icon: <PackageX className="size-4" />, title: 'BoxMe stock is not connected yet.',
      body: <>The BoxMe tables could not be read. Apply <code className="font-mono text-[11px]">supabase/boxme_inventory.sql</code> from zoomy-observability, then run the BoxMe sync.</>,
    });
  } else if (sync.state === 'never') {
    notes.push({
      tone: 'muted', icon: <PackageX className="size-4" />, title: 'No BoxMe sync has run yet.',
      body: 'Stock appears here after the first daily sync (07:30 Manila) or a manual run of the BoxMe stock sync workflow.',
    });
  } else if (sync.state === 'failed') {
    notes.push({
      tone: 'crit', icon: <AlertTriangle className="size-4" />, title: `The last BoxMe sync failed${sync.lastRunAt ? ` (${fmtManilaWhen(sync.lastRunAt, now)})` : ''}.`,
      body: <>{sync.lastGoodAt ? `Showing stock from ${fmtManilaWhen(sync.lastGoodAt, now)}. ` : 'No earlier stock to show. '}{sync.error && <span className="font-mono text-[11px] break-words">{sync.error}</span>}</>,
    });
  } else if (sync.state === 'stale') {
    notes.push({
      tone: 'warn', icon: <AlertTriangle className="size-4" />, title: 'BoxMe stock may be out of date.',
      body: `The daily sync has not succeeded in over a day. Showing stock from ${fmtManilaWhen(sync.lastGoodAt!, now)}.`,
    });
  } else if (sync.state === 'partial') {
    notes.push({
      tone: 'warn', icon: <AlertTriangle className="size-4" />, title: 'Part of the last sync did not finish.',
      body: <>Stock is current; some details (warehouse names or expiry lots) may be older. {sync.error && <span className="font-mono text-[11px] break-words">{sync.error}</span>}</>,
    });
  }

  if (sync.keyDaysLeft != null && sync.keyDaysLeft <= KEY_WARN_DAYS) {
    notes.push({
      tone: sync.keyDaysLeft < 0 ? 'crit' : 'warn', icon: <KeyRound className="size-4" />,
      title: sync.keyDaysLeft < 0 ? 'The BoxMe API key has expired.' : `The BoxMe API key expires in ${sync.keyDaysLeft} day${sync.keyDaysLeft === 1 ? '' : 's'}.`,
      body: 'Create a new key in BoxMe OMS (Settings, API Integration), then update BOXME_API_KEY and BOXME_KEY_EXPIRES_ON in the sync job secrets.',
    });
  }

  if (!notes.length) return null;
  return (
    <div className="mb-5 flex flex-col gap-2">
      {notes.map((n) => (
        <div key={n.title} role={n.tone === 'crit' ? 'alert' : 'status'}
          className={cn('flex items-start gap-3 rounded-lg border px-4 py-3 text-sm',
            n.tone === 'crit' && 'border-red-500/30 bg-red-500/5 text-red-700 dark:text-red-300',
            n.tone === 'warn' && 'border-amber-500/30 bg-amber-500/5 text-amber-800 dark:text-amber-200',
            n.tone === 'muted' && 'border-dashed bg-muted/40 text-muted-foreground')}>
          <span className="mt-0.5 shrink-0">{n.icon}</span>
          <div className="min-w-0">
            <p className="font-medium text-foreground">{n.title}</p>
            <p className="mt-0.5 text-[13px] opacity-90">{n.body}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

/** One hairline-divided strip of the four totals, figures in the serif face. */
function LedgerStrip({totals}: {totals: BoxmePageData['totals']}) {
  const cells = [
    {label: 'Available', value: totals.available, note: 'sellable online now'},
    {label: 'Awaiting pick', value: totals.awaiting, note: 'held for open orders'},
    {label: 'Incoming', value: totals.incoming, note: 'on inbound shipments'},
    {label: 'Damaged', value: totals.damaged, note: 'not sellable'},
  ];
  return (
    <Card className="mb-5">
      <CardContent className="grid grid-cols-2 p-0 md:grid-cols-4">
        {cells.map((c, i) => (
          <div key={c.label} className={cn('px-4 py-3.5', i % 2 === 1 && 'border-l', i >= 2 && 'max-md:border-t', i === 2 && 'md:border-l')}>
            <div className="text-[10px] font-semibold uppercase tracking-[0.09em] text-muted-foreground">{c.label}</div>
            <div className="mt-1 font-heading text-[28px] leading-none tabular-nums tracking-tight">{c.value.toLocaleString('en-US')}</div>
            <div className="mt-1 text-[11px] text-muted-foreground">{c.note}</div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function ExpiringCard({data}: {data: BoxmePageData}) {
  const lots = data.expiring.slice(0, 6);
  return (
    <Card>
      <CardContent className="p-4">
        <div className="mb-3 flex items-baseline justify-between gap-2">
          <h2 className="text-[15px] font-semibold">Expiring soon</h2>
          <span className="text-[11px] text-muted-foreground">within each product&apos;s BoxMe expiry window</span>
        </div>
        {lots.length === 0 ? (
          <p className="text-sm text-muted-foreground">No BoxMe lots expire inside their window.</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {lots.map((l) => (
              <li key={`${l.sku}-${l.warehouse_code}-${l.batch_lot}-${l.date}`}
                className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 rounded-md bg-amber-500/10 px-3 py-2 text-[13px]">
                <span className="min-w-0">
                  <span className="font-medium">{l.name}</span>
                  <span className="text-muted-foreground"> · {l.quantity.toLocaleString('en-US')} units{l.batch_lot && ` · lot ${l.batch_lot}`}</span>
                </span>
                <span className="whitespace-nowrap font-medium text-amber-700 dark:text-amber-300">
                  {fmtDate(l.date)} · {l.daysLeft < 0 ? 'expired' : `${l.daysLeft} d`}
                </span>
              </li>
            ))}
            {data.expiring.length > lots.length && (
              <li className="px-3 pt-1 text-xs text-muted-foreground">+ {data.expiring.length - lots.length} more lots</li>
            )}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function MatchCard({data}: {data: BoxmePageData}) {
  const boxmeOnly = data.rows.filter((r) => !r.inPos);
  return (
    <Card>
      <CardContent className="p-4">
        <h2 className="mb-1 text-[15px] font-semibold">Catalog match</h2>
        <p className="mb-3 text-[12px] text-muted-foreground">BoxMe SKUs are matched to POS products by SKU code.</p>
        <details className="group border-t py-2" open={data.posOnly.length > 0 && data.posOnly.length <= 4}>
          <summary className="flex cursor-pointer list-none items-center justify-between text-[13px] font-medium">
            Not stocked at BoxMe <span className="font-mono text-[11px] tabular-nums text-muted-foreground">{data.posOnly.length}</span>
          </summary>
          <ul className="mt-2 flex flex-col gap-1 text-[13px]">
            {data.posOnly.map((p) => (
              <li key={p.product_id} className="flex justify-between gap-2">
                <Link href={`/inventory/${p.product_id}`} className="truncate transition-colors hover:text-primary">{p.name}</Link>
                <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{p.office + p.event} offline</span>
              </li>
            ))}
            {data.posOnly.length === 0 && <li className="text-muted-foreground">Every active POS product is at BoxMe.</li>}
          </ul>
        </details>
        <details className="group border-t py-2" open={boxmeOnly.length > 0}>
          <summary className="flex cursor-pointer list-none items-center justify-between text-[13px] font-medium">
            Unknown to POS <span className="font-mono text-[11px] tabular-nums text-muted-foreground">{boxmeOnly.length}</span>
          </summary>
          <ul className="mt-2 flex flex-col gap-1 text-[13px]">
            {boxmeOnly.map((r) => (
              <li key={r.sku} className="flex justify-between gap-2">
                <span className="truncate">{r.name}</span>
                <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{r.sku}</span>
              </li>
            ))}
            {boxmeOnly.length === 0 && <li className="text-muted-foreground">Every BoxMe SKU matches a POS product.</li>}
          </ul>
        </details>
      </CardContent>
    </Card>
  );
}
