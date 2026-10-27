'use client';

import {useEffect, useState} from 'react';
import Link from 'next/link';
import {AlertTriangle, ArrowRight, CircleSlash, FileWarning, LayoutGrid, PackageX, Rows3, Upload} from 'lucide-react';
import type {Action, ActionKind, Severity} from '@/src/goldline-actions';
import {Card, CardContent} from '@/components/ui/card';
import {buttonVariants} from '@/components/ui/button';
import {cn} from '@/lib/utils';
import {fmtRange, StorePicker, ToneChip} from '@/components/analyst/goldline-ops-shared';
import {GL_PAGE} from '@/src/goldline-ui';

// Action Feed (plan §07h): a prioritized, severity-coded to-do list across stores —
// reorders, anomalies, dead stock, missing counts — each one tap from its fix.
// Ranked by severity, then by the pesos at stake (src/goldline-actions.ts).

export type FeedAction = Action & {storeCode: string; storeName: string | null};

const KIND: Record<ActionKind, {label: string; Icon: typeof AlertTriangle}> = {
  gap: {label: 'Missing count', Icon: FileWarning},
  reorder: {label: 'Reorder', Icon: PackageX},
  anomaly: {label: 'Anomaly', Icon: AlertTriangle},
  dead: {label: 'Dead stock', Icon: CircleSlash},
};
const TONE: Record<Severity, string> = {critical: 'var(--status-crit)', warn: 'var(--status-warn)', info: 'var(--muted-foreground)'};
type Filter = 'all' | ActionKind;
type View = 'tiles' | 'table';
const VIEW_KEY = 'coop.actions.view';

export function GoldlineActionsView({
  actions,
  stores,
  store,
  period,
  hasCounts,
  canEdit,
}: {
  actions: FeedAction[];
  stores: Array<{code: string; name: string | null}>;
  store: string | null; // null = all stores
  period: {start: string; end: string} | null;
  hasCounts: boolean;
  canEdit: boolean;
}) {
  const [filter, setFilter] = useState<Filter>('all');
  // Tiles or a table; remembered per browser (a convenience only).
  const [view, setView] = useState<View>('tiles');
  useEffect(() => {
    try {
      const v = localStorage.getItem(VIEW_KEY);
      if (v === 'tiles' || v === 'table') setView(v);
    } catch {}
  }, []);
  const pickView = (v: View) => {
    setView(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {}
  };
  const count = (k: ActionKind) => actions.filter((a) => a.kind === k).length;
  const shown = actions.filter((a) => filter === 'all' || a.kind === filter);
  const critical = actions.filter((a) => a.severity === 'critical').length;
  const chips: Array<{value: Filter; label: string; n: number}> = [
    {value: 'all', label: 'All', n: actions.length},
    {value: 'reorder', label: 'Reorder', n: count('reorder')},
    {value: 'anomaly', label: 'Anomalies', n: count('anomaly')},
    {value: 'dead', label: 'Dead stock', n: count('dead')},
    {value: 'gap', label: 'Missing counts', n: count('gap')},
  ];

  return (
    <div className={GL_PAGE}>
      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-2">
            <h1 className="font-heading text-2xl font-semibold tracking-tight">Action feed</h1>
            <div className="flex flex-wrap items-center gap-2">
              {stores.length > 1 && <StorePicker stores={stores} value={store} allLabel="All stores" />}
              <span className="font-mono text-xs text-muted-foreground">
                {period ? `${fmtRange(period.start, period.end)} · ranked by urgency, then pesos at stake` : 'no counts yet'}
              </span>
            </div>
          </div>
          {hasCounts && (
            <ToneChip tone={actions.length ? (critical ? 'var(--status-crit)' : 'var(--status-warn)') : 'var(--status-good)'}>
              {actions.length ? `${actions.length} to act on${critical ? ` · ${critical} urgent` : ''}` : 'All clear'}
            </ToneChip>
          )}
        </div>
      </header>

      {!hasCounts ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 px-6 py-12 text-center">
            <h2 className="font-heading text-base font-semibold">Nothing to rank yet</h2>
            <p className="max-w-md text-sm text-muted-foreground">
              The feed works from committed inventory counts. Once stores&apos; forms are reviewed and committed, reorders, anomalies, dead
              stock and missing counts show up here, most urgent first.
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
          <div className="flex flex-wrap items-center justify-between gap-3">
          <div role="group" aria-label="Filter actions" className="flex flex-wrap gap-2">
            {chips.map((c) => (
              <button
                key={c.value}
                type="button"
                aria-pressed={filter === c.value}
                onClick={() => setFilter(c.value)}
                disabled={c.value !== 'all' && c.n === 0}
                className={cn(
                  'inline-flex h-7 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-[background-color,border-color,transform] duration-150 ease-out active:scale-[0.97] disabled:pointer-events-none disabled:opacity-40',
                  filter === c.value ? 'border-primary bg-primary text-primary-foreground' : 'border-border hover:border-foreground/30',
                )}
              >
                {c.label} <span className="tabular-nums opacity-80">{c.n}</span>
              </button>
            ))}
          </div>
          <div role="group" aria-label="Layout" className="inline-flex rounded-lg border border-border p-0.5">
            {(
              [
                ['tiles', 'Tiles', LayoutGrid],
                ['table', 'Table', Rows3],
              ] as const
            ).map(([v, label, Icon]) => (
              <button
                key={v}
                type="button"
                aria-pressed={view === v}
                onClick={() => pickView(v)}
                className={cn(
                  'inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-[background-color,color] duration-150 ease-out',
                  view === v ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <Icon aria-hidden className="size-3.5" /> {label}
              </button>
            ))}
          </div>
          </div>

          {shown.length === 0 ? (
            <Card>
              <CardContent className="px-6 py-10 text-center text-sm text-muted-foreground">
                {actions.length === 0
                  ? 'Nothing to act on. Every counted item has stock and is moving, and every store’s form is in.'
                  : 'Nothing in this category.'}
              </CardContent>
            </Card>
          ) : (
            view === 'table' ? (
              <ActionsTable actions={shown} showStore={!store} />
            ) : (
            <ol className="grid gap-2.5 lg:grid-cols-2 2xl:grid-cols-3" aria-label="Actions, most urgent first">
              {shown.map((a) => {
                const k = KIND[a.kind];
                const tone = TONE[a.severity];
                return (
                  <li key={`${a.storeCode}-${a.id}`} className="flex">
                    <Card className={cn('relative w-full py-0', a.itemCode && 'transition-colors duration-150 hover:bg-muted/30 has-[a[data-item]:focus-visible]:bg-muted/30')}>
                      <CardContent className="flex h-full flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3.5">
                        <span
                          aria-hidden
                          className="flex size-9 shrink-0 items-center justify-center rounded-lg"
                          style={{color: `color-mix(in oklab, ${tone} 80%, var(--foreground))`, background: `color-mix(in oklab, ${tone} 13%, transparent)`}}
                        >
                          <k.Icon className="size-4" />
                        </span>
                        <div className="flex min-w-[14rem] flex-1 flex-col gap-0.5">
                          <span className="flex flex-wrap items-center gap-2">
                            <ToneChip tone={a.severity === 'info' ? null : tone}>
                              {a.severity === 'critical' ? `${k.label} · urgent` : k.label}
                            </ToneChip>
                            {!store && (
                              <span className="text-[11px] text-muted-foreground">
                                {a.storeName ? `${a.storeCode} · ${a.storeName}` : `Store ${a.storeCode}`}
                              </span>
                            )}
                          </span>
                          {a.itemCode ? (
                            // The whole card opens the product page for this store; the action button sits above it.
                            <Link
                              data-item
                              href={`/stock/${encodeURIComponent(a.itemCode)}?store=${encodeURIComponent(a.storeCode)}`}
                              className="text-sm font-medium outline-none after:absolute after:inset-0 after:rounded-[inherit] after:content-[''] focus-visible:after:ring-2 focus-visible:after:ring-ring"
                            >
                              {a.title}
                            </Link>
                          ) : (
                            <span className="text-sm font-medium">{a.title}</span>
                          )}
                          <span className="text-xs text-muted-foreground">{a.detail}</span>
                        </div>
                        <Link href={a.cta.href} className={cn(buttonVariants({variant: 'outline', size: 'sm'}), 'relative z-10 shrink-0')}>
                          {a.cta.label} <ArrowRight className="size-3.5" />
                        </Link>
                      </CardContent>
                    </Card>
                  </li>
                );
              })}
            </ol>
            )
          )}
          <p className="text-xs text-muted-foreground">
            Reorders and anomalies use movement estimated from consecutive counts (see Inventory → Forecast). An item needs two counts
            before it can be ranked on movement.
          </p>
        </>
      )}
    </div>
  );
}

/** The same feed as a table: one row per action, most urgent first. */
function ActionsTable({actions, showStore}: {actions: FeedAction[]; showStore: boolean}) {
  return (
    <Card className="py-0">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[48rem] border-collapse text-sm">
          <caption className="sr-only">Actions, most urgent first</caption>
          <thead>
            <tr className="border-b border-border/70 bg-muted/30 text-left text-xs text-muted-foreground">
              <th className="h-10 pr-3 pl-4 font-medium">Action</th>
              <th className="h-10 px-3 font-medium">Item</th>
              {showStore && <th className="h-10 px-3 font-medium">Store</th>}
              <th className="h-10 px-3 font-medium">Why</th>
              <th className="h-10 pr-4 pl-3 text-right font-medium">
                <span className="sr-only">Next step</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {actions.map((a) => {
              const k = KIND[a.kind];
              const tone = TONE[a.severity];
              return (
                <tr key={`${a.storeCode}-${a.id}`} className="border-b border-border/40 transition-colors duration-150 last:border-0 hover:bg-muted/30">
                  <td className="py-2.5 pr-3 pl-4 whitespace-nowrap">
                    <span className="inline-flex items-center gap-2">
                      <k.Icon aria-hidden className="size-4 shrink-0" style={{color: a.severity === 'info' ? 'var(--muted-foreground)' : tone}} />
                      <ToneChip tone={a.severity === 'info' ? null : tone}>{a.severity === 'critical' ? `${k.label} · urgent` : k.label}</ToneChip>
                    </span>
                  </td>
                  <td className="px-3 py-2.5 font-medium">
                    {a.itemCode ? (
                      <Link href={`/stock/${encodeURIComponent(a.itemCode)}?store=${encodeURIComponent(a.storeCode)}`} className="underline-offset-4 hover:underline">
                        {a.title}
                      </Link>
                    ) : (
                      a.title
                    )}
                  </td>
                  {showStore && <td className="px-3 py-2.5 text-xs whitespace-nowrap text-muted-foreground">{a.storeName ? `${a.storeCode} · ${a.storeName}` : `Store ${a.storeCode}`}</td>}
                  <td className="px-3 py-2.5 text-xs text-muted-foreground">{a.detail}</td>
                  <td className="py-2 pr-4 pl-3 text-right">
                    <Link href={a.cta.href} className={cn(buttonVariants({variant: 'outline', size: 'sm'}), 'whitespace-nowrap')}>
                      {a.cta.label} <ArrowRight className="size-3.5" />
                    </Link>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
