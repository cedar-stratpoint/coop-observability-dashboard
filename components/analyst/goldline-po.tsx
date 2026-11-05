'use client';

// Goldline · one purchase order (F12), laid out like Nichido's paper PURCHASE ORDER FORM:
// No., TO, FROM (Beauty Consultant, Store, Code, Date, Module), then QTY | DESCRIPTION
// grouped by product line with the shades under each line. The admin section sits to the
// right on screen: item code, price, amount, the owner's decision from the Restock run
// (F11) and its remark, and the received qty and date. The PO doesn't decide anything: its
// lines shipped when it was made, and lines rejected on the run show struck through.
// Printing gives the paper layout in two columns, without prices or rejected lines.

import {Fragment, useMemo, useState, useTransition} from 'react';
import Link from 'next/link';
import {useRouter} from 'next/navigation';
import {Loader2, Printer, Save} from 'lucide-react';
import type {PoLine, PurchaseOrder, RejectedLine} from '@/src/goldline-po-data';
import {groupByProductLine, receiveError} from '@/src/goldline-po';
import {receivePoLinesAction, setPoModuleAction} from '@/app/stock/actions';
import {Button} from '@/components/ui/button';
import {Card, CardContent} from '@/components/ui/card';
import {fmtDay, peso, ToneChip} from '@/components/analyst/goldline-ops-shared';
import {money, PoStatusChip} from '@/components/analyst/goldline-po-shared';
import {cn} from '@/lib/utils';

export type PoViewData = PurchaseOrder & {company: string | null; canEdit: boolean};

type Draft = {qty: string; date: string};
type Row = ({kind: 'line'} & PoLine) | ({kind: 'rejected'} & RejectedLine);

const RECEIVE_ERROR: Record<NonNullable<ReturnType<typeof receiveError>>, string> = {
  bad_qty: 'Received is a whole number, 0 or more.',
  over_qty: 'Received can’t be more than was sent.',
  bad_date: 'The date is between the day it was sent and today.',
};
// The owner's decision on the Restock run, as the PO's Line column shows it.
const DECISION_CHIP = {
  approved: {label: 'Approved', tone: 'var(--status-good)'},
  edited: {label: 'Edited', tone: 'var(--status-warn)'},
  rejected: {label: 'Rejected', tone: 'var(--status-crit)'},
} as const;
const draftOf = (l: PoLine): Draft => ({qty: l.receivedQty == null ? '' : String(l.receivedQty), date: l.receivedOn ?? ''});

export function GoldlinePurchaseOrder({data}: {data: PoViewData}) {
  const router = useRouter();
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const groups = useMemo(
    () => groupByProductLine<Row>([...data.lines.map((l) => ({kind: 'line' as const, ...l})), ...data.rejected.map((r) => ({kind: 'rejected' as const, ...r}))]),
    [data.lines, data.rejected],
  );
  const date = data.date;

  // Received edits that differ from what's saved, with any input problem per line.
  const changes = useMemo(() => {
    const out: Array<{line: PoLine; qty: number | null; date: string | null; problem: string | null}> = [];
    for (const l of data.lines) {
      const d = drafts[l.id];
      if (!d) continue;
      const saved = draftOf(l);
      if (d.qty === saved.qty && d.date === saved.date) continue;
      if (d.qty.trim() === '') {
        if (l.receivedQty != null) out.push({line: l, qty: null, date: null, problem: null});
        continue;
      }
      const qty = Number(d.qty);
      const err = receiveError({qty: l.qty, shippedOn: l.shippedOn}, Number.isFinite(qty) ? qty : -1, d.date || null, data.today);
      out.push({line: l, qty, date: d.date, problem: err ? RECEIVE_ERROR[err] : null});
    }
    return out;
  }, [drafts, data.lines, data.today]);
  const problems = changes.filter((c) => c.problem);

  const run = (fn: () => Promise<{ok: true} | {ok: false; error: string}>, ok: string, done?: () => void) => {
    setError(null);
    setNotice(null);
    start(async () => {
      const res = await fn();
      if (!res.ok) return setError(res.error);
      setNotice(ok);
      done?.();
      router.refresh();
    });
  };
  const saveReceived = () => {
    if (problems.length) return setError(problems[0].problem);
    run(
      () => receivePoLinesAction({company: data.company, lines: changes.map((c) => ({id: c.line.id, qty: c.qty, date: c.qty == null ? null : c.date}))}),
      `Saved what was received on ${changes.length} ${changes.length === 1 ? 'line' : 'lines'}. It counts as delivered in the form vs. sales check.`,
      () => setDrafts({}),
    );
  };
  const setDraft = (l: PoLine, patch: Partial<Draft>) =>
    setDrafts((d) => {
      const cur = d[l.id] ?? draftOf(l);
      const next = {...cur, ...patch};
      // Typing a qty on a line with no date yet fills today, the usual case.
      if (patch.qty !== undefined && patch.qty !== '' && !next.date) next.date = data.today;
      return {...d, [l.id]: next};
    });

  return (
    <div className="mx-auto flex max-w-7xl min-w-0 flex-col gap-5 px-4 py-6 *:min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <nav aria-label="Breadcrumb" className="flex items-baseline gap-2 text-sm text-muted-foreground">
          <Link href={`/stock/orders?month=${data.date.slice(0, 7)}`} className="underline-offset-4 hover:text-foreground hover:underline">
            Orders
          </Link>
          <span aria-hidden>/</span>
          <Link href={`/stock/orders/date/${data.date}`} className="underline-offset-4 hover:text-foreground hover:underline">
            {fmtDay(data.date)}
          </Link>
          <span aria-hidden>/</span>
          <span className="font-mono text-foreground">{data.number}</span>
        </nav>
        <div className="flex flex-wrap items-center gap-2">
          <Link href={`/stock/restock?store=${encodeURIComponent(data.storeCode)}`} className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
            Decisions on the Restock run
          </Link>
          <Button size="sm" variant="outline" onClick={() => window.print()}>
            <Printer className="size-4" /> Print
          </Button>
        </div>
      </div>

      {(error || notice) && (
        <p role={error ? 'alert' : 'status'} className={cn('text-sm print:hidden', error ? 'text-destructive' : 'text-muted-foreground')}>
          {error ?? notice}
        </p>
      )}

      <Card className="py-0 print:hidden">
        <CardContent className="flex flex-col gap-5 p-5 sm:p-6">
          <FormHeader data={data} date={date} pending={pending} onModule={(module) => run(() => setPoModuleAction({company: data.company, id: data.id, module}), 'Module saved.')} />

          <div className="-mx-5 overflow-x-auto sm:-mx-6">
            <table className="w-full min-w-[60rem] border-collapse text-sm tabular-nums">
              <thead>
                <tr className="border-y border-foreground/70 text-left text-[11px] tracking-wide whitespace-nowrap uppercase">
                  <th className="w-14 py-2 pr-3 pl-5 text-center font-semibold sm:pl-6">Qty.</th>
                  <th className="py-2 pr-3 font-semibold">Description</th>
                  <th className={cn(ADMIN, 'pl-3 font-medium text-muted-foreground')}>Item code</th>
                  <th className={cn(ADMIN, 'text-right font-medium text-muted-foreground')}>Price</th>
                  <th className={cn(ADMIN, 'text-right font-medium text-muted-foreground')}>Amount</th>
                  <th className={cn(ADMIN, 'font-medium text-muted-foreground')}>Line</th>
                  <th className={cn(ADMIN, 'font-medium text-muted-foreground')}>Remarks</th>
                  <th className={cn(ADMIN, 'font-medium text-muted-foreground')}>Received</th>
                  <th className={cn(ADMIN, 'pr-5 font-medium text-muted-foreground sm:pr-6')}>Date</th>
                </tr>
              </thead>
              <tbody>
                {groups.map((g) => (
                  <Fragment key={g.line}>
                    <tr>
                      <td />
                      <td className="pt-3 pr-3 pb-1 font-semibold">{g.line}</td>
                      <td colSpan={7} className={cn(ADMIN_BG, 'pt-3 pb-1')} />
                    </tr>
                    {g.items.map((r) =>
                      r.kind === 'rejected' ? (
                        <RejectedRow key={r.recommendationId} line={r} />
                      ) : (
                        <LineRow key={r.id} line={r} canEdit={data.canEdit} pending={pending} draft={drafts[r.id] ?? draftOf(r)} today={data.today} onDraft={(patch) => setDraft(r, patch)} />
                      ),
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex flex-wrap items-end justify-between gap-4 border-t border-foreground/70 pt-4">
            <div className="flex flex-wrap items-center gap-3">
              {data.canEdit && data.lines.length > 0 && (
                <Button size="sm" onClick={saveReceived} disabled={pending || !changes.length}>
                  {pending ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />} Save received{changes.length ? ` (${changes.length})` : ''}
                </Button>
              )}
              <p className="max-w-[60ch] text-xs text-muted-foreground text-pretty">
                Received qty counts as delivered in that month&apos;s form vs. sales check and on the Inventory board, in place of the form&apos;s Delivery column.
              </p>
            </div>
            <p className="text-sm">
              Approved total <span className="ml-2 font-heading text-lg font-semibold tabular-nums">{peso(data.approvedTotal)}</span>
            </p>
          </div>
        </CardContent>
      </Card>

      <PrintForm data={data} date={date} />
    </div>
  );
}

// The admin section: tinted so the paper form's own columns read on their own.
const ADMIN_BG = 'bg-muted/45';
const ADMIN = cn(ADMIN_BG, 'py-2 pr-3');
const CELL = cn(ADMIN_BG, 'py-2 pr-3 align-middle');
const INPUT =
  'h-7 rounded-md border border-border bg-background px-2 text-sm text-foreground tabular-nums outline-none transition-colors hover:border-foreground/25 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40 disabled:opacity-50';

function FormHeader({data, date, pending, onModule}: {data: PoViewData; date: string; pending: boolean; onModule: (m: string | null) => void}) {
  const [module, setModule] = useState(data.module ?? '');
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 border-b-2 border-foreground pb-2">
        <span className="font-mono text-xs font-semibold tracking-[0.14em]">NICHIDO COSMETICS</span>
        <h1 className="font-heading text-lg font-bold tracking-[0.06em]">PURCHASE ORDER FORM</h1>
        <span className="flex items-baseline gap-2 font-mono text-sm">
          No. <span className="text-lg font-semibold text-primary">{data.number}</span>
        </span>
      </div>
      <dl className="grid grid-cols-[3.5rem_minmax(0,1fr)] items-end gap-x-3 gap-y-3 text-sm">
        <dt className="pb-1 font-mono text-xs font-semibold tracking-wide">TO</dt>
        <dd className="border-b border-foreground/60 pb-1">Nichido warehouse</dd>
        <dt className="pb-5 font-mono text-xs font-semibold tracking-wide">FROM</dt>
        <dd className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-[1.6fr_1.4fr_0.7fr_0.8fr_1fr]">
          <Field label="Beauty Consultant" value={data.consultant ?? <span className="text-muted-foreground">Not on file</span>} />
          <Field label="Store" value={data.storeName ?? `Store ${data.storeCode}`} />
          <Field label="Code" value={<span className="font-mono">{data.storeCode}</span>} />
          <Field label="Date" value={fmtDay(date)} />
          <Field
            label="Module"
            value={
              data.canEdit ? (
                <input
                  id="po-module"
                  aria-label="Module"
                  value={module}
                  maxLength={80}
                  disabled={pending}
                  onChange={(e) => setModule(e.target.value)}
                  onBlur={() => module.trim() !== (data.module ?? '') && onModule(module.trim() || null)}
                  onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
                  placeholder="Add"
                  className="w-full bg-transparent outline-none placeholder:text-muted-foreground/70 focus-visible:text-foreground"
                />
              ) : (
                data.module ?? ''
              )
            }
          />
        </dd>
      </dl>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <PoStatusChip status={data.status} />
        <span>Restock run {data.cycle}</span>
        {data.createdBy && <span>Made by {data.createdBy}</span>}
      </div>
    </div>
  );
}

function Field({label, value}: {label: string; value: React.ReactNode}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="truncate border-b border-foreground/60 pb-1 font-medium">{value}</div>
      <div className="text-center text-[11px] text-muted-foreground">{label}</div>
    </div>
  );
}

function LineRow({
  line: l,
  canEdit,
  pending,
  draft,
  today,
  onDraft,
}: {
  line: PoLine;
  canEdit: boolean;
  pending: boolean;
  draft: Draft;
  today: string;
  onDraft: (patch: Partial<Draft>) => void;
}) {
  const d = DECISION_CHIP[l.decision];
  return (
    <tr className="border-b border-border/60">
      <td className="py-2 pr-3 pl-5 text-center align-middle font-mono text-base font-semibold text-primary sm:pl-6">{l.qty}</td>
      <td className="py-2 pr-3 pl-4 align-middle">
        <span className="text-muted-foreground" aria-hidden>
          -{' '}
        </span>
        {l.shade}
      </td>
      <td className={cn(CELL, 'pl-3 font-mono text-xs text-muted-foreground')}>{l.itemCode}</td>
      <td className={cn(CELL, 'text-right')}>{money(l.unitPrice)}</td>
      <td className={cn(CELL, 'text-right')}>{money(l.amount)}</td>
      <td className={cn(CELL, 'whitespace-nowrap')}>
        <span className="inline-flex items-center gap-1.5" title={l.shippedOn ? `Sent ${fmtDay(l.shippedOn)}, due ${fmtDay(l.arrivesOn)}` : undefined}>
          <ToneChip tone={d.tone}>{d.label}</ToneChip>
          {l.decision === 'edited' && l.suggested != null && <span className="text-xs text-muted-foreground line-through">{l.suggested}</span>}
        </span>
      </td>
      <td className={cn(CELL, 'max-w-[24ch] text-xs text-muted-foreground')}>{l.remark ? <span className="italic">{l.remark}</span> : null}</td>
      <td className={cn(CELL, 'whitespace-nowrap')}>
        {canEdit ? (
          <span className="inline-flex items-center gap-1.5">
            <input
              id={`po-rcv-qty-${l.id}`}
              aria-label={`Received qty, ${l.name}`}
              inputMode="numeric"
              value={draft.qty}
              disabled={pending}
              onChange={(e) => onDraft({qty: e.target.value.replace(/[^\d]/g, '')})}
              placeholder="qty"
              className={cn(INPUT, 'w-14 text-right')}
            />
            {l.short > 0 && draft.qty === String(l.receivedQty) && <span className="text-xs font-medium text-[var(--status-warn)]">{l.short} short</span>}
          </span>
        ) : l.receivedQty != null ? (
          <span>
            {l.receivedQty}
            {l.short > 0 && <span className="ml-1.5 text-xs font-medium text-[var(--status-warn)]">{l.short} short</span>}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">On the way</span>
        )}
      </td>
      <td className={cn(CELL, 'pr-5 whitespace-nowrap sm:pr-6')}>
        {canEdit ? (
          <input
            id={`po-rcv-date-${l.id}`}
            type="date"
            aria-label={`Received date, ${l.name}`}
            value={draft.date}
            min={l.shippedOn ?? undefined}
            max={today}
            disabled={pending}
            onChange={(e) => onDraft({date: e.target.value})}
            className={INPUT}
          />
        ) : l.receivedOn ? (
          fmtDay(l.receivedOn)
        ) : (
          <span className="text-muted-foreground">·</span>
        )}
      </td>
    </tr>
  );
}

/** A line the owner rejected on the run: not ordered, shown struck through with the remark. */
function RejectedRow({line: r}: {line: RejectedLine}) {
  return (
    <tr className="border-b border-border/60 text-muted-foreground">
      <td className="py-2 pr-3 pl-5 text-center align-middle font-mono text-base line-through sm:pl-6">{r.suggested ?? ''}</td>
      <td className="py-2 pr-3 pl-4 align-middle line-through">
        <span aria-hidden>- </span>
        {r.shade}
      </td>
      <td className={cn(CELL, 'pl-3 font-mono text-xs')}>{r.itemCode}</td>
      <td className={cn(CELL, 'text-right')}>·</td>
      <td className={cn(CELL, 'text-right')}>·</td>
      <td className={CELL}>
        <ToneChip tone={DECISION_CHIP.rejected.tone}>{DECISION_CHIP.rejected.label}</ToneChip>
      </td>
      <td className={cn(CELL, 'max-w-[24ch] text-xs')}>{r.remark ? <span className="italic">{r.remark}</span> : null}</td>
      <td className={CELL}>·</td>
      <td className={cn(CELL, 'pr-5 sm:pr-6')}>·</td>
    </tr>
  );
}

/** The paper layout for printing: two QTY | DESCRIPTION columns, received beside each line. */
function PrintForm({data, date}: {data: PoViewData; date: string}) {
  const kept = data.lines;
  const groups = groupByProductLine(kept);
  // Split by line count so the two columns come out about even, never breaking a group.
  const total = kept.length + groups.length;
  const left: typeof groups = [];
  const right: typeof groups = [];
  let used = 0;
  for (const g of groups) {
    (used < total / 2 ? left : right).push(g);
    used += g.items.length + 1;
  }
  const col = (gs: typeof groups) => (
    <table className="w-full border-collapse text-[11pt]">
      <thead>
        <tr className="border-y border-black text-left text-[9pt] tracking-wide">
          <th className="w-12 py-1 text-center">QTY.</th>
          <th className="py-1">DESCRIPTION</th>
          <th className="w-12 py-1 text-center">RCVD</th>
        </tr>
      </thead>
      <tbody>
        {gs.map((g) => (
          <Fragment key={g.line}>
            <tr>
              <td />
              <td className="pt-2 font-bold">• {g.line}</td>
              <td />
            </tr>
            {g.items.map((l) => (
              <tr key={l.id} className="border-b border-black/20">
                <td className="py-0.5 text-center font-semibold">{l.qty}</td>
                <td className="py-0.5 pl-4">- {l.shade}</td>
                <td className="py-0.5 text-center">{l.receivedQty ?? ''}</td>
              </tr>
            ))}
          </Fragment>
        ))}
      </tbody>
    </table>
  );
  return (
    <section aria-hidden className="po-print hidden bg-white p-6 text-black print:block">
      <div className="flex items-baseline justify-between border-b-2 border-black pb-1">
        <span className="text-[9pt] font-bold tracking-[0.14em]">NICHIDO COSMETICS</span>
        <span className="text-[14pt] font-bold tracking-[0.06em]">PURCHASE ORDER FORM</span>
        <span className="text-[11pt]">
          No. <b>{data.number}</b>
        </span>
      </div>
      <div className="mt-3 grid grid-cols-[3rem_1fr] gap-x-2 gap-y-2 text-[10pt]">
        <span className="font-bold">TO</span>
        <span className="border-b border-black">: Nichido warehouse</span>
        <span className="font-bold">FROM</span>
        <div className="grid grid-cols-[1.6fr_1.4fr_0.7fr_0.8fr_1fr] gap-x-3">
          {[
            [data.consultant ?? '', 'Beauty Consultant'],
            [data.storeName ?? `Store ${data.storeCode}`, 'Store'],
            [data.storeCode, 'Code'],
            [fmtDay(date), 'Date'],
            [data.module ?? '', 'Module'],
          ].map(([v, k]) => (
            <div key={k}>
              <div className="min-h-[1.2em] border-b border-black">{v}</div>
              <div className="text-center text-[8pt]">{k}</div>
            </div>
          ))}
        </div>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-6">
        {col(left)}
        {col(right)}
      </div>
      <div className="mt-10 grid grid-cols-3 gap-6 text-center text-[8pt]">
        <div className="border-t border-black pt-1">Prepared by</div>
        <div className="border-t border-black pt-1">Approved by</div>
        <div className="border-t border-black pt-1">Received by / date</div>
      </div>
    </section>
  );
}
