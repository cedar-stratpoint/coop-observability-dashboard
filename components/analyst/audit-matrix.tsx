'use client';

import {useMemo, useState} from 'react';
import {useRouter} from 'next/navigation';
import {Search} from 'lucide-react';
import {Card, CardContent} from '@/components/ui/card';
import {cn} from '@/lib/utils';
import {GL_PAGE, titleName} from '@/src/goldline-ui';
import {AUDIT_META, AUDIT_STATES, NEEDS_ACTION, type AuditState} from '@/src/goldline-audit';
import type {AuditResult, AuditRow} from '@/src/goldline-audit-data';
import {ink, LegKey, Mark, MatrixLegend, monthLabel, PoSourceBar, ReconTabs, StateChip, toneOf} from '@/components/analyst/audit-shared';

// Reconciliation · By store (NICH-17). One store and month: every product's three legs
// (Watsons · Inventory · PO), the state and what to do, in the notebook's two groups.

const FIELD =
  'h-9 rounded-lg border border-border bg-card px-2.5 text-sm outline-none transition-colors duration-150 [@media(hover:hover)]:hover:border-foreground/25 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40';

export function AuditMatrix({data}: {data: AuditResult}) {
  const router = useRouter();
  const [pick, setPick] = useState<AuditState | null>(null);
  const [onlyAction, setOnlyAction] = useState(true);
  const [q, setQ] = useState('');
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

  const setParam = (key: 'store' | 'month', value: string) => {
    const sp = new URLSearchParams();
    sp.set('store', key === 'store' ? value : (sel?.code ?? ''));
    sp.set('month', key === 'month' ? value : (sel?.month ?? ''));
    router.push(`/stock/audit?${sp.toString()}`);
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
              <select className={cn(FIELD, 'min-w-[16rem]')} value={sel.code} onChange={(e) => setParam('store', e.target.value)}>
                {data.stores.map((s) => (
                  <option key={s.code} value={s.code}>
                    {s.name ? `${s.code} · ${titleName(s.name)}` : s.code}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
              Month
              <select className={FIELD} value={sel.month} onChange={(e) => setParam('month', e.target.value)}>
                {data.months.map((m) => (
                  <option key={m} value={m}>
                    {monthLabel(m)}
                  </option>
                ))}
              </select>
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
                {q ? 'No product matches that search.' : 'Nothing here. Every product at this store lines up.'}
              </CardContent>
            </Card>
          ) : (
            <div className="flex flex-col gap-5">
              {active.length > 0 && <Group title="Active" hint="On the PO form" rows={active} />}
              {inactive.length > 0 && <Group title="Inactive" hint="Not on the PO form" rows={inactive} />}
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            Inventory counts as yes only with stock on hand; a counted zero is a no. This page flags only. Retiring a product is a separate step and keeps its history.
          </p>
        </>
      )}
    </div>
  );
}

const STATE_PAGE = 12;

function Group({title, hint, rows}: {title: string; hint: string; rows: AuditRow[]}) {
  const states = AUDIT_STATES.filter((st) => rows.some((r) => r.state === st));
  return (
    <Card className="gap-0 overflow-hidden py-0">
      <div className="flex items-baseline gap-2 border-b border-border px-4 py-3">
        <h3 className="font-heading text-base font-semibold">{title}</h3>
        <span className="text-xs text-muted-foreground">{hint}</span>
        <span className="ml-auto text-xs text-muted-foreground tabular-nums">{rows.length} products</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[40rem] text-sm">
          <thead>
            <tr className="text-left text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
              <th className="py-2 pr-3 pl-4 font-medium">Product</th>
              <th className="w-28 px-2 py-2 text-center font-medium">Watsons</th>
              <th className="w-28 px-2 py-2 text-center font-medium">Inventory</th>
              <th className="w-20 px-2 py-2 text-center font-medium">PO</th>
            </tr>
          </thead>
          {states.map((st) => (
            <StateRows key={st} state={st} rows={rows.filter((r) => r.state === st)} />
          ))}
        </table>
      </div>
    </Card>
  );
}

/** One state's rows under a header that carries the state, who acts, and the step, once. */
function StateRows({state, rows}: {state: AuditState; rows: AuditRow[]}) {
  const [all, setAll] = useState(false);
  const m = AUDIT_META[state];
  const c = toneOf(state);
  const shown = all ? rows : rows.slice(0, STATE_PAGE);
  return (
    <tbody>
      <tr>
        <td colSpan={4} className="border-t border-border px-4 pt-4 pb-2.5">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <StateChip state={state} />
            <span className="font-heading text-sm font-semibold tabular-nums">{rows.length}</span>
            <span className="text-xs text-muted-foreground">
              {m.owner !== 'None' && <span className="font-medium" style={{color: ink(c)}}>{m.owner} · </span>}
              {m.action}
            </span>
          </div>
        </td>
      </tr>
      {shown.map((r) => (
        <tr key={r.item_code} className="transition-colors duration-150 [@media(hover:hover)]:hover:bg-muted/40">
          <td className="relative py-2 pr-3 pl-4">
            <span aria-hidden className="absolute inset-y-1.5 left-0 w-[3px] rounded-r" style={{background: c, opacity: NEEDS_ACTION.has(state) ? 0.9 : 0.25}} />
            <span className="block max-w-[28rem] truncate font-medium" title={r.product ?? r.item_code}>
              {r.shade ?? r.product ?? r.item_code}
            </span>
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
        </tr>
      ))}
      {rows.length > STATE_PAGE && (
        <tr>
          <td colSpan={4} className="px-4 pt-1 pb-3">
            <button type="button" onClick={() => setAll(!all)} className="text-xs font-medium text-primary underline-offset-4 [@media(hover:hover)]:hover:underline">
              {all ? 'Show fewer' : `Show all ${rows.length}`}
            </button>
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
