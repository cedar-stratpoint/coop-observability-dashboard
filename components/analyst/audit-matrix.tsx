'use client';

import {useMemo, useState} from 'react';
import {useRouter} from 'next/navigation';
import Link from 'next/link';
import {ChevronRight, Search} from 'lucide-react';
import {Card, CardContent} from '@/components/ui/card';
import {cn} from '@/lib/utils';
import {NativeSelect} from '@/components/ui/native-select';
import {GL_PAGE, titleName} from '@/src/goldline-ui';
import {AUDIT_META, AUDIT_STATES, NEEDS_ACTION, type AuditState} from '@/src/goldline-audit';
import type {AuditResult, AuditRow} from '@/src/goldline-audit-data';
import {ink, LegKey, Mark, MatrixLegend, monthLabel, Pager, PoSourceBar, ReconTabs, StateChip, toneOf, URGENCY} from '@/components/analyst/audit-shared';

// Reconciliation · By store (NICH-17). One store and month: every product's three legs
// (Watsons · Inventory · PO), the state and what to do, in the notebook's two groups.

const FIELD =
  'h-9 rounded-lg border border-border bg-card px-2.5 text-sm outline-none transition-colors duration-150 [@media(hover:hover)]:hover:border-foreground/25 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40';

// The store / month pickers: NativeSelect draws an inset chevron (the browser's own arrow sits
// flush against the right edge), sized to match FIELD.
const SELECT = 'h-9 rounded-lg bg-card pr-9 pl-3 duration-150';

export function AuditMatrix({data}: {data: AuditResult}) {
  const router = useRouter();
  const [pick, setPick] = useState<AuditState | null>(null);
  const [onlyAction, setOnlyAction] = useState(true);
  const [q, setQ] = useState('');
  const [side, setSide] = useState<'active' | 'inactive'>('active');
  const sel = data.selected;

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return data.rows.filter(
      (r) =>
        (pick ? r.state === pick : !onlyAction || NEEDS_ACTION.has(r.state)) &&
        (!needle || r.item_code.toLowerCase().includes(needle) || (r.product ?? '').toLowerCase().includes(needle)),
    );
  }, [data.rows, pick, onlyAction, q]);
  const active = rows.filter((r) => r.onPo);
  const inactive = rows.filter((r) => !r.onPo);
  // Active and Inactive are tabs, not two stacked tables, so Inactive is one click away
  // instead of a long scroll. Picking a state opens the tab it belongs to.
  const view = pick ? (AUDIT_META[pick].legs.po ? 'active' : 'inactive') : side;

  const setParam = (key: 'store' | 'month', value: string) => {
    const sp = new URLSearchParams();
    sp.set('store', key === 'store' ? value : (sel?.code ?? ''));
    sp.set('month', key === 'month' ? value : (sel?.month ?? ''));
    // A store or month is a filter on this page, not a step: replace, so Back leaves Reconcile.
    router.replace(`/stock/audit?${sp.toString()}`, {scroll: false});
  };
  const query = sel ? `month=${sel.month}` : undefined;

  return (
    <div className={GL_PAGE}>
      <header className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="max-w-2xl">
            <p className="font-mono text-[11px] tracking-[0.14em] text-muted-foreground uppercase">Reconciliation</p>
            <h1 className="mt-1 font-heading text-2xl font-semibold tracking-tight">Watsons, inventory and PO, side by side</h1>
            <p className="mt-1.5 text-sm text-muted-foreground">
              For one store and month, each product gets a yes or no on three legs and the step that follows. The PO form decides what is active.
            </p>
          </div>
          <ReconTabs query={query} />
        </div>
        <PoSourceBar po={data.po} />
      </header>

      {data.mock && (
        <div className="rounded-lg border border-dashed border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          Sample view. Example rows for one store; connect the database to see real counts.
        </div>
      )}

      {!sel ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-1 px-6 py-14 text-center">
            <p className="font-heading text-sm font-semibold">No counts to reconcile yet</p>
            <p className="max-w-sm text-sm text-muted-foreground">Commit an inventory form first. Its products are then checked against Watsons sales and the PO form here.</p>
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
              Store
              <NativeSelect wrapperClassName="min-w-[16rem]" className={SELECT} value={sel.code} onChange={(e) => setParam('store', e.target.value)}>
                {data.stores.map((s) => (
                  <option key={s.code} value={s.code}>
                    {s.name ? `${s.code} · ${titleName(s.name)}` : s.code}
                  </option>
                ))}
              </NativeSelect>
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
              Month
              <NativeSelect className={SELECT} value={sel.month} onChange={(e) => setParam('month', e.target.value)}>
                {data.months.map((m) => (
                  <option key={m} value={m}>
                    {monthLabel(m)}
                  </option>
                ))}
              </NativeSelect>
            </label>
            <div className="ml-auto text-right">
              <p className="font-heading text-3xl leading-none font-semibold tabular-nums">{data.summary.needsAction}</p>
              <p className="mt-1 text-xs text-muted-foreground">of {data.summary.total} products need a step</p>
            </div>
          </div>

          <div className="flex flex-col gap-3">
            <LegKey />
            <MatrixLegend summary={data.summary} active={pick} onPick={setPick} unit="products" />
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a product or code" aria-label="Find a product" className={cn(FIELD, 'w-64 pl-8')} />
            </div>
            {pick ? (
              <button type="button" onClick={() => setPick(null)} className="text-sm font-medium text-primary underline-offset-4 [@media(hover:hover)]:hover:underline">
                Showing {AUDIT_META[pick].label} only · Clear
              </button>
            ) : (
              <label className="flex items-center gap-2 text-sm text-muted-foreground">
                <input type="checkbox" checked={onlyAction} onChange={(e) => setOnlyAction(e.target.checked)} className="size-4 rounded border-border accent-[var(--primary)]" />
                Only products that need a step
              </label>
            )}
          </div>

          {rows.length === 0 ? (
            <Card>
              <CardContent className="px-6 py-12 text-center text-sm text-muted-foreground">
                {q ? 'No product matches that search.' : pick ? `No products are at “${AUDIT_META[pick].label}” at this store.` : 'Nothing here. Every product at this store lines up.'}
              </CardContent>
            </Card>
          ) : (
            <Group
              key={`${view}|${pick ?? ''}|${q}|${onlyAction}`}
              view={view}
              counts={{active: active.length, inactive: inactive.length}}
              onView={(v) => {
                setPick(null);
                setSide(v);
              }}
              rows={view === 'active' ? active : inactive}
              store={sel.code}
            />
          )}
          <p className="text-xs text-muted-foreground">
            Inventory counts as yes only with stock on hand; a counted zero is a no. This page flags only. Retiring a product is a separate step and keeps its history.
          </p>
        </>
      )}
    </div>
  );
}

const PAGE = 10;

const VIEWS = {active: {title: 'Active', hint: 'On the PO form'}, inactive: {title: 'Inactive', hint: 'Not on the PO form'}} as const;

function Group({
  view,
  counts,
  onView,
  rows,
  store,
}: {
  view: 'active' | 'inactive';
  counts: Record<'active' | 'inactive', number>;
  onView: (v: 'active' | 'inactive') => void;
  rows: AuditRow[];
  store: string;
}) {
  // Same order as the choices above: most urgent first, then the bigger group.
  const count = (st: AuditState) => rows.filter((r) => r.state === st).length;
  const states = AUDIT_STATES.filter((st) => count(st) > 0).sort((a, b) => URGENCY[AUDIT_META[a].tone] - URGENCY[AUDIT_META[b].tone] || count(b) - count(a));
  return (
    <Card className="gap-0 overflow-hidden py-0">
      <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
        <div role="tablist" aria-label="Active or inactive products" className="inline-flex rounded-lg bg-muted p-1">
          {(['active', 'inactive'] as const).map((v) => (
            <button
              key={v}
              role="tab"
              type="button"
              aria-selected={view === v}
              onClick={() => onView(v)}
              className={cn(
                'inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition-[color,background-color,box-shadow] duration-150',
                view === v ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground [@media(hover:hover)]:hover:text-foreground',
              )}
            >
              {VIEWS[v].title}
              <span className={cn('rounded-full px-1.5 text-xs tabular-nums', view === v ? 'bg-muted' : 'bg-transparent')}>{counts[v]}</span>
            </button>
          ))}
        </div>
        <span className="text-xs text-muted-foreground">{VIEWS[view].hint}</span>
      </div>
      {rows.length === 0 ? (
        <p className="px-4 py-12 text-center text-sm text-muted-foreground">
          No {VIEWS[view].title.toLowerCase()} products to show here{counts[view === 'active' ? 'inactive' : 'active'] ? `. ${VIEWS[view === 'active' ? 'inactive' : 'active'].title} has ${counts[view === 'active' ? 'inactive' : 'active']}.` : '.'}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[40rem] text-sm">
            <thead>
              <tr className="text-left text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                <th className="py-2 pr-3 pl-4 font-medium">Product</th>
                <th className="w-28 px-2 py-2 text-center font-medium">Watsons</th>
                <th className="w-28 px-2 py-2 text-center font-medium">Inventory</th>
                <th className="w-20 px-2 py-2 text-center font-medium">PO</th>
                <th className="w-10 py-2 pr-3" aria-label="Open" />
              </tr>
            </thead>
            {states.map((st) => (
              <StateRows key={st} state={st} rows={rows.filter((r) => r.state === st)} store={store} />
            ))}
          </table>
        </div>
      )}
    </Card>
  );
}

/** One state's rows under a header that carries the state, who acts, and the step, once; 10 per page. */
function StateRows({state, rows, store}: {state: AuditState; rows: AuditRow[]; store: string}) {
  const router = useRouter();
  const [page, setPage] = useState(0);
  const m = AUDIT_META[state];
  const c = toneOf(state);
  const pages = Math.max(1, Math.ceil(rows.length / PAGE));
  const at = Math.min(page, pages - 1);
  const shown = rows.slice(at * PAGE, at * PAGE + PAGE);
  const hrefOf = (r: AuditRow) => `/stock/${encodeURIComponent(r.item_code)}?store=${encodeURIComponent(store)}`;
  return (
    <tbody>
      <tr>
        <td colSpan={5} className="border-t border-border px-4 pt-4 pb-2.5">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <StateChip state={state} />
            <span className="font-heading text-sm font-semibold tabular-nums">{rows.length}</span>
            <span className="text-xs text-muted-foreground">
              {m.owner !== 'None' && <span className="font-medium" style={{color: ink(c)}}>{m.owner === 'Admin' ? 'You' : m.owner} · </span>}
              {m.action}
            </span>
          </div>
        </td>
      </tr>
      {shown.map((r) => (
        // The row opens the product's inventory page for this store. The name is the real
        // link (keyboard, new tab); the row click is a convenience for the mouse.
        <tr
          key={r.item_code}
          onClick={() => router.push(hrefOf(r))}
          className="group/row cursor-pointer transition-colors duration-150 focus-within:bg-muted/40 [@media(hover:hover)]:hover:bg-muted/40"
        >
          <td className="py-2 pr-3 pl-4">
            <Link
              href={hrefOf(r)}
              onClick={(e) => e.stopPropagation()}
              className="block max-w-[28rem] truncate font-medium outline-none focus-visible:underline"
            >
              {r.shade ?? r.product ?? r.item_code}
            </Link>
            <span className="block max-w-[28rem] truncate text-[11px] text-muted-foreground">
              {r.shade && r.line ? `${r.line} · ` : ''}
              <span className="font-mono">{r.item_code}</span>
              {r.retired && ' · retired'}
            </span>
          </td>
          <td className="px-2 py-2">
            <Leg on={r.inWatsons} detail={r.inWatsons ? `${r.units} sold` : null} label="Watsons" />
          </td>
          <td className="px-2 py-2">
            <Leg on={r.inInventory} detail={r.onForm ? (r.onHand == null ? 'blank on form' : `${r.onHand} on hand`) : 'not on form'} label="Inventory" />
          </td>
          <td className="px-2 py-2">
            <Leg on={r.onPo} label="PO" />
          </td>
          <td className="py-2 pr-3 text-right">
            <ChevronRight
              aria-hidden
              className="ml-auto size-4 text-muted-foreground/40 transition-[transform,color] duration-150 ease-out group-hover/row:translate-x-0.5 group-hover/row:text-foreground group-focus-within/row:text-foreground"
            />
          </td>
        </tr>
      ))}
      {pages > 1 && (
        <tr>
          <td colSpan={5} className="px-4 pt-1.5 pb-3">
            <Pager page={at} pages={pages} total={rows.length} size={PAGE} onPage={setPage} label={m.label} />
          </td>
        </tr>
      )}
    </tbody>
  );
}

function Leg({on, detail, label}: {on: boolean; detail?: string | null; label: string}) {
  return (
    <span className="flex flex-col items-center gap-0.5">
      <Mark on={on} label={label} />
      {detail && <span className="text-[11px] whitespace-nowrap text-muted-foreground tabular-nums">{detail}</span>}
    </span>
  );
}
