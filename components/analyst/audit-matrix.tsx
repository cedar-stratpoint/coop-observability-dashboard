'use client';

import {useMemo, useState} from 'react';
import {useRouter} from 'next/navigation';
import {Check, X} from 'lucide-react';
import {Card, CardContent} from '@/components/ui/card';
import {cn} from '@/lib/utils';
import {toneText} from '@/src/review-confidence';
import {GL_PAGE} from '@/src/goldline-ui';
import {AUDIT_ACTION, AUDIT_LABEL, type AuditState} from '@/src/goldline-audit';
import type {AuditResult} from '@/src/goldline-audit-data';

const TONE: Record<AuditState, string> = {matched: 'var(--status-good)', no_sales: 'var(--status-warn)', not_counted: 'var(--status-crit)'};
const chip = (s: AuditState) => ({color: toneText(TONE[s]), background: `color-mix(in oklab, ${TONE[s]} 14%, transparent)`});

const FIELD = 'h-9 rounded-md border border-border bg-background px-2.5 text-sm outline-none transition-colors hover:border-foreground/25 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40';

function monthLabel(m: string): string {
  const [y, mo] = m.split('-').map(Number);
  return `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][mo - 1]} ${y}`;
}

/** A check or x for one leg. */
function Mark({on}: {on: boolean}) {
  return on ? (
    <Check className="mx-auto size-4" style={{color: 'var(--status-good)'}} aria-label="yes" />
  ) : (
    <X className="mx-auto size-4 text-muted-foreground/50" aria-label="no" />
  );
}

export function AuditMatrix({data}: {data: AuditResult}) {
  const router = useRouter();
  const [onlyMismatches, setOnlyMismatches] = useState(true);
  const sel = data.selected;

  const rows = useMemo(
    () => (onlyMismatches ? data.rows.filter((r) => r.state !== 'matched') : data.rows),
    [data.rows, onlyMismatches],
  );

  const setParam = (key: 'store' | 'month', value: string) => {
    const sp = new URLSearchParams();
    sp.set('store', key === 'store' ? value : (sel?.code ?? ''));
    sp.set('month', key === 'month' ? value : (sel?.month ?? ''));
    router.push(`/stock/audit?${sp.toString()}`);
  };

  return (
    <div className={GL_PAGE}>
      <header className="flex flex-col gap-2">
        <div>
          <h1 className="font-heading text-xl font-semibold tracking-tight">Reconciliation audit</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Per SKU, for one store and month: counted in the inventory form, and sold in Watsons. The two shouldn&apos;t disagree.
          </p>
        </div>
      </header>

      {data.mock && (
        <div className="rounded-lg border border-dashed border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          Sample view. Example rows for one store; connect the database to audit real counts.
        </div>
      )}

      {!sel ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-1 px-6 py-14 text-center">
            <p className="font-heading text-sm font-semibold">No counts to audit yet</p>
            <p className="max-w-sm text-sm text-muted-foreground">Commit an inventory form first; its SKUs will be cross-checked against Watsons sales here.</p>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Pickers + summary */}
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div className="flex flex-wrap items-end gap-3">
              <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                Store
                <select className={FIELD} value={sel.code} onChange={(e) => setParam('store', e.target.value)}>
                  {data.stores.map((s) => (
                    <option key={s.code} value={s.code}>{s.name ? `${s.code} · ${s.name}` : s.code}</option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                Month
                <select className={FIELD} value={sel.month} onChange={(e) => setParam('month', e.target.value)}>
                  {data.months.map((m) => (
                    <option key={m} value={m}>{monthLabel(m)}</option>
                  ))}
                </select>
              </label>
            </div>
            <div className="flex flex-wrap gap-2">
              <SummaryPill state="not_counted" n={data.summary.not_counted} />
              <SummaryPill state="no_sales" n={data.summary.no_sales} />
              <SummaryPill state="matched" n={data.summary.matched} />
            </div>
          </div>

          <label className="flex w-fit items-center gap-2 text-sm text-muted-foreground">
            <input
              type="checkbox"
              checked={onlyMismatches}
              onChange={(e) => setOnlyMismatches(e.target.checked)}
              className="size-4 rounded border-border"
            />
            Show only mismatches ({data.summary.not_counted + data.summary.no_sales})
          </label>

          <Card>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[40rem] text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                      <th className="py-2.5 pr-3 pl-4">SKU</th>
                      <th className="px-2 py-2.5 text-center">In form</th>
                      <th className="px-2 py-2.5 text-center">On hand</th>
                      <th className="px-2 py-2.5 text-center">In Watsons</th>
                      <th className="px-2 py-2.5 text-center">Units sold</th>
                      <th className="px-2 py-2.5">Status</th>
                      <th className="py-2.5 pr-4 pl-2">What to do</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.length === 0 ? (
                      <tr>
                        <td colSpan={7} className="px-4 py-10 text-center text-sm text-muted-foreground">
                          {onlyMismatches ? 'No mismatches. Every counted SKU matches a Watsons sale.' : 'No SKUs to show.'}
                        </td>
                      </tr>
                    ) : (
                      rows.map((r) => (
                        <tr key={r.item_code} className="border-b border-border/60 last:border-0 hover:bg-muted/40">
                          <td className="py-2 pr-3 pl-4">
                            <span className="font-mono text-xs">{r.item_code}</span>
                            {r.product && r.product !== r.item_code && (
                              <span className="block max-w-[16rem] truncate text-xs text-muted-foreground">{r.product}</span>
                            )}
                          </td>
                          <td className="px-2 py-2"><Mark on={r.inForm} /></td>
                          <td className="px-2 py-2 text-center tabular-nums text-muted-foreground">{r.onHand ?? '—'}</td>
                          <td className="px-2 py-2"><Mark on={r.inWatsons} /></td>
                          <td className="px-2 py-2 text-center tabular-nums text-muted-foreground">{r.inWatsons ? r.units : '—'}</td>
                          <td className="px-2 py-2">
                            <span className="inline-flex rounded-full px-2 py-0.5 text-xs font-medium" style={chip(r.state)}>{AUDIT_LABEL[r.state]}</span>
                          </td>
                          <td className="py-2 pr-4 pl-2 text-xs text-muted-foreground">{r.state === 'matched' ? '' : AUDIT_ACTION[r.state]}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
          <p className="text-xs text-muted-foreground">
            The purchase-order leg isn&apos;t wired yet, so this compares the inventory form against Watsons sales only. It flags, it never retires a SKU.
          </p>
        </>
      )}
    </div>
  );
}

function SummaryPill({state, n}: {state: AuditState; n: number}) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium tabular-nums" style={chip(state)}>
      <span className="font-semibold">{n}</span> {AUDIT_LABEL[state]}
    </span>
  );
}
