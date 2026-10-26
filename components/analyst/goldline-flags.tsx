'use client';

import Link from 'next/link';
import {useMemo, useState, useTransition} from 'react';
import {useRouter} from 'next/navigation';
import {ExternalLink, RefreshCw, RotateCcw, Trash2} from 'lucide-react';
import type {AdjustmentReason, AdjustmentRow, FlagRow, FlagsData} from '@/src/goldline-flags-data';
import type {FlagCause} from '@/src/goldline-checks';
import {addAdjustmentAction, closeFlagAction, deleteAdjustmentAction, logLossAction, reopenFlagAction, runChecksAction, type FlagActionResult} from '@/app/flags/actions';
import {Card, CardContent} from '@/components/ui/card';
import {Button} from '@/components/ui/button';
import {NativeSelect} from '@/components/ui/native-select';
import {Pagination} from '@/components/analyst/pagination';
import {GL_SCROLL_ROW_MOBILE, GL_TILES_MOBILE} from '@/src/goldline-ui';
import {cn} from '@/lib/utils';

// The flag queue (F7): what the checks found on the forms, one cause each, plus the
// adjustments (F5) that explain stock which left without a sale. A flag means check,
// not proof: it closes with a remark, the cause can change, and a sales gap that turns
// out to be a real loss is logged as an adjustment so the next month starts right.

type Tab = 'open' | 'closed' | 'adjustments';
const PAGE_SIZE = 12;
const n = (v: unknown) => (typeof v === 'number' ? Math.round(v * 10) / 10 : Number(v) || 0).toLocaleString('en-US');

export const CAUSE: Record<FlagCause, {label: string; tone: 'warn' | 'crit' | 'info'; help: string}> = {
  human_error: {label: 'Human error', tone: 'warn', help: 'A wrong number or count. Correct it.'},
  unreadable: {label: 'Unreadable', tone: 'info', help: 'Handwriting, erasures, overwrites. Type the right number.'},
  manipulation: {label: 'Manipulation', tone: 'crit', help: '0 or below. Audit the store.'},
};
const KIND: Record<string, string> = {sales_gap: 'Form vs. sales gap', row_math: 'Doesn’t add up', zero_or_below: 'At 0 or below', unreadable: 'Unclear cell'};
const REASON: Record<AdjustmentReason, string> = {pull_out: 'Pull-out', damage: 'Damage', loss: 'Loss or pilferage'};
const toneVar = (t: 'warn' | 'crit' | 'info' | 'good') => (t === 'info' ? 'var(--muted-foreground)' : `var(--status-${t})`);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtDay = (iso: string) => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}`;
const fmtMonth = (ym: string) => `${MONTHS[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;
const fmtPeriod = (a: string, b: string) => (a.slice(8) === '01' && b.slice(0, 7) === a.slice(0, 7) && Number(b.slice(8)) >= 28 ? fmtMonth(a.slice(0, 7)) : `${fmtDay(a)} to ${fmtDay(b)}`);

/** One plain sentence saying what the check saw. */
export function explain(f: FlagRow): string {
  const d = f.details;
  if (f.kind === 'row_math') {
    const sum = d.counted === d.withDelivery ? `${n(d.counted)}` : `${n(d.counted)} (${n(d.withDelivery)} with delivery)`;
    return `Ending written as ${n(d.written)}, but stockroom ${n(d.stockroom ?? 0)} + drawer ${n(d.drawer ?? 0)} + selling area ${n(d.selling_area ?? 0)} = ${sum}.`;
  }
  if (f.kind === 'zero_or_below') return `On hand is ${n(d.onHand)}. Every 0 is flagged; a real sell-out closes as dismissed.`;
  if (f.kind === 'unreadable') {
    const marks = (d.marks as Array<{field: string; mark: string; written?: string | null}> | undefined) ?? [];
    return marks.map((m) => `${m.field.replace('_', ' ')} ${m.mark}${m.written ? ` (written “${m.written}”)` : ''}`).join(' · ') || 'A cell couldn’t be read clearly.';
  }
  const gap = Number(d.gap);
  const more = gap > 0 ? `${n(gap)} more left the store than POS recorded` : `POS recorded ${n(-gap)} more than the forms show`;
  return `Form sold ${n(d.form_sold)} (start ${n(d.start)}, ending ${n(d.ending)}), POS sold ${n(d.pos_sold)}: ${more}. Allowed ${n(d.allowed)}.`;
}

function Pill({tone, children}: {tone: 'warn' | 'crit' | 'info' | 'good'; children: React.ReactNode}) {
  return (
    <span className="rounded-full px-2 py-0.5 text-xs font-medium" style={{color: toneVar(tone), background: `color-mix(in oklab, ${toneVar(tone)} 14%, transparent)`}}>
      {children}
    </span>
  );
}

export function GoldlineFlags({company, data, canEdit}: {company: string; data: FlagsData; canEdit: boolean}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [notice, setNotice] = useState<{kind: 'ok' | 'err'; text: string} | null>(null);
  const [tab, setTab] = useState<Tab>('open');
  const [cause, setCause] = useState<FlagCause | 'all'>('all');
  const [store, setStore] = useState('all');
  const [page, setPage] = useState(1);
  const [openId, setOpenId] = useState<string | null>(null);

  function act(fn: () => Promise<FlagActionResult>, okText: string, after?: () => void) {
    setNotice(null);
    start(async () => {
      const res = await fn();
      if (res.ok) {
        setNotice({kind: 'ok', text: res.note ?? okText});
        after?.();
        router.refresh();
      } else setNotice({kind: 'err', text: res.error});
    });
  }

  const open = data.flags.filter((f) => f.status === 'open');
  const closed = data.flags.filter((f) => f.status !== 'open');
  const counts = useMemo(() => {
    const c: Record<FlagCause, number> = {human_error: 0, unreadable: 0, manipulation: 0};
    for (const f of open) c[f.cause]++;
    return c;
  }, [open]);
  const list = (tab === 'open' ? open : closed).filter((f) => (cause === 'all' || f.cause === cause) && (store === 'all' || f.storeCode === store));
  const pageCount = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const rows = list.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);
  const latest = data.coverage[0];

  return (
    <div className={cn('mx-auto flex max-w-5xl flex-col gap-6 px-4 py-6', GL_TILES_MOBILE)}>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="font-heading text-xl font-semibold tracking-tight">Flags</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">
            What the checks found on the forms. A flag means check, not proof: close it with a remark, change the cause if needed, or log the missing stock as an
            adjustment.
          </p>
        </div>
        {canEdit && (
          <Button size="sm" variant="outline" disabled={pending} onClick={() => act(() => runChecksAction({company}), 'Checks ran.')}>
            <RefreshCw className={cn('size-3.5', pending && 'animate-spin motion-reduce:animate-none')} /> Run checks
          </Button>
        )}
      </header>

      <div className="grid gap-3 sm:grid-cols-3">
        {(Object.keys(CAUSE) as FlagCause[]).map((c) => (
          <button
            key={c}
            type="button"
            aria-pressed={cause === c}
            onClick={() => {
              setCause(cause === c ? 'all' : c);
              setTab('open');
              setPage(1);
            }}
            className={cn(
              'flex flex-col gap-1 rounded-xl border bg-card px-4 py-3 text-left transition-[border-color,transform] duration-150 ease-out active:scale-[0.98]',
              cause === c ? 'border-foreground/40' : 'border-border hover:border-foreground/25',
            )}
          >
            <span className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium" style={{color: toneVar(CAUSE[c].tone)}}>
                {CAUSE[c].label}
              </span>
              <span className="font-heading text-xl font-semibold tabular-nums">{counts[c]}</span>
            </span>
            <span className="text-xs text-muted-foreground">{CAUSE[c].help}</span>
          </button>
        ))}
      </div>

      {latest && (
        <p className="text-sm text-muted-foreground">
          <span className="font-medium text-foreground">Form vs. sales, {fmtMonth(latest.month)}:</span>{' '}
          {[
            latest.match && `${latest.match} match`,
            latest.flag && `${latest.flag} flagged`,
            latest.waiting_sales && `${latest.waiting_sales} waiting for that month’s POS Sales Data`,
            latest.unlinked && `${latest.unlinked} held out (Watsons SKU not linked)`,
            latest.baseline && `${latest.baseline} first counts (baseline only)`,
          ]
            .filter(Boolean)
            .join(' · ') || 'nothing counted yet'}
        </p>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className={GL_SCROLL_ROW_MOBILE}>
          <div role="group" aria-label="Show" className="flex gap-2">
            {(
              [
                ['open', 'Open', open.length],
                ['closed', 'Closed', closed.length],
                ['adjustments', 'Adjustments', data.adjustments.length],
              ] as Array<[Tab, string, number]>
            ).map(([v, label, c]) => (
              <button
                key={v}
                type="button"
                aria-pressed={tab === v}
                onClick={() => {
                  setTab(v);
                  setPage(1);
                }}
                className={cn(
                  'inline-flex h-7 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-[background-color,border-color,transform] duration-150 ease-out active:scale-[0.97]',
                  tab === v ? 'border-primary bg-primary text-primary-foreground' : 'border-border hover:border-foreground/30',
                )}
              >
                {label} <span className="tabular-nums opacity-80">{c}</span>
              </button>
            ))}
          </div>
        </div>
        {tab !== 'adjustments' && data.stores.length > 1 && (
          <NativeSelect aria-label="Store" value={store} onChange={(e) => setStore(e.target.value)}>
            <option value="all">All stores</option>
            {[...new Set(data.flags.map((f) => f.storeCode))].map((code) => (
              <option key={code} value={code}>
                {code} · {data.stores.find((s) => s.code === code)?.name ?? ''}
              </option>
            ))}
          </NativeSelect>
        )}
      </div>

      {notice && (
        <p role="status" className={cn('text-sm', notice.kind === 'ok' ? 'text-muted-foreground' : 'text-destructive')}>
          {notice.text}
        </p>
      )}

      {tab === 'adjustments' ? (
        <Adjustments company={company} data={data} canEdit={canEdit} pending={pending} act={act} />
      ) : rows.length === 0 ? (
        <Card>
          <CardContent className="px-6 py-10 text-center text-sm text-muted-foreground">
            {tab === 'open' ? (cause === 'all' && store === 'all' ? 'No open flags. Every checked form is clean.' : 'No open flags match.') : 'Nothing closed yet.'}
          </CardContent>
        </Card>
      ) : (
        <ul className="flex flex-col gap-2.5">
          {rows.map((f) => (
            <li key={f.id}>
              <FlagCard f={f} company={company} canEdit={canEdit} pending={pending} expanded={openId === f.id} onToggle={() => setOpenId(openId === f.id ? null : f.id)} act={act} />
            </li>
          ))}
        </ul>
      )}

      {tab !== 'adjustments' && <Pagination page={safePage} pageCount={pageCount} onPage={setPage} label="Flag pages" />}
    </div>
  );
}

type Act = (fn: () => Promise<FlagActionResult>, okText: string, after?: () => void) => void;

function FlagCard({f, company, canEdit, pending, expanded, onToggle, act}: {f: FlagRow; company: string; canEdit: boolean; pending: boolean; expanded: boolean; onToggle: () => void; act: Act}) {
  const c = CAUSE[f.cause];
  const isOpen = f.status === 'open';
  return (
    <Card className="py-0" style={{boxShadow: `inset 3px 0 0 ${toneVar(c.tone)}`}}>
      <CardContent className="flex flex-col gap-3 px-4 py-3.5">
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
          <div className="flex min-w-0 flex-col gap-1">
            <p className="flex flex-wrap items-center gap-2 text-xs">
              <Pill tone={c.tone}>{c.label}</Pill>
              <span className="text-muted-foreground">{KIND[f.kind] ?? f.kind}</span>
              {f.originalCause && <span className="text-muted-foreground">· was {CAUSE[f.originalCause].label.toLowerCase()}</span>}
            </p>
            <p className="text-sm font-medium">
              <span className="font-mono text-xs text-muted-foreground">{f.itemCode}</span> {f.itemName ?? ''}
            </p>
            <p className="font-mono text-[11px] text-muted-foreground">
              {f.storeCode} {f.storeName ?? ''} · {fmtPeriod(f.periodStart, f.periodEnd)}
              {f.consultant ? ` · BA ${f.consultant}` : ' · BA not on the form'}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {f.sourceUploadId && (
              <Link href={`/uploads/${f.sourceUploadId}`} className="inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-4 hover:underline">
                Form page <ExternalLink className="size-3" />
              </Link>
            )}
            {canEdit && isOpen && (
              <Button size="sm" variant={expanded ? 'secondary' : 'outline'} onClick={onToggle} aria-expanded={expanded}>
                {expanded ? 'Cancel' : 'Close'}
              </Button>
            )}
            {canEdit && !isOpen && f.status !== 'resolved' && (
              <Button size="sm" variant="ghost" disabled={pending} onClick={() => act(() => reopenFlagAction({company, id: f.id}), 'Reopened.')} aria-label="Reopen">
                <RotateCcw className="size-3.5" />
              </Button>
            )}
          </div>
        </div>
        <p className="text-sm">{explain(f)}</p>
        {!isOpen && (
          <p className="text-xs text-muted-foreground">
            <span className="font-medium text-foreground">{f.status === 'resolved' ? 'Cleared' : f.status === 'checked' ? 'Checked' : 'Dismissed'}</span>
            {f.remark ? `: ${f.remark}` : ''}
            {f.closedBy && f.closedBy !== 'coop' ? ` · ${f.closedBy}` : ''}
            {f.closedAt ? ` · ${fmtDay(f.closedAt.slice(0, 10))}` : ''}
          </p>
        )}
        {expanded && isOpen && <CloseForm f={f} company={company} pending={pending} act={act} onDone={onToggle} />}
      </CardContent>
    </Card>
  );
}

function CloseForm({f, company, pending, act, onDone}: {f: FlagRow; company: string; pending: boolean; act: Act; onDone: () => void}) {
  const lossy = f.kind === 'sales_gap' && Number(f.details.gap) > 0;
  const [how, setHow] = useState<'checked' | 'dismissed' | 'loss'>(lossy ? 'loss' : 'checked');
  const [cause, setCause] = useState<FlagCause>(f.cause);
  const [remark, setRemark] = useState('');
  const [reason, setReason] = useState<AdjustmentReason>('loss');
  const [qty, setQty] = useState(String(Math.max(1, Math.round(Number(f.details.gap) || 1))));
  const submit = () =>
    how === 'loss'
      ? act(() => logLossAction({company, id: f.id, reason, qty: Number(qty), remark}), 'Logged and closed.', onDone)
      : act(() => closeFlagAction({company, id: f.id, status: how, remark, cause}), how === 'checked' ? 'Closed as checked.' : 'Dismissed.', onDone);
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-muted/40 p-3">
      <div role="radiogroup" aria-label="How to close" className="flex flex-wrap gap-2">
        {(
          [
            ...(lossy ? [['loss', 'Log as a loss']] : []),
            ['checked', 'Checked, corrected'],
            ['dismissed', 'Dismiss, it’s fine'],
          ] as Array<['checked' | 'dismissed' | 'loss', string]>
        ).map(([v, label]) => (
          <button
            key={v}
            type="button"
            role="radio"
            aria-checked={how === v}
            onClick={() => setHow(v)}
            className={cn('h-7 rounded-full border px-3 text-xs font-medium transition-colors', how === v ? 'border-primary bg-primary text-primary-foreground' : 'border-border hover:border-foreground/30')}
          >
            {label}
          </button>
        ))}
      </div>
      {how === 'loss' ? (
        <div className="flex flex-wrap gap-2">
          <NativeSelect aria-label="What happened" value={reason} onChange={(e) => setReason(e.target.value as AdjustmentReason)}>
            {(Object.keys(REASON) as AdjustmentReason[]).map((r) => (
              <option key={r} value={r}>
                {REASON[r]}
              </option>
            ))}
          </NativeSelect>
          <input
            aria-label="Units"
            inputMode="numeric"
            value={qty}
            onChange={(e) => setQty(e.target.value.replace(/\D/g, ''))}
            className="h-8 w-24 rounded-md border border-border bg-background px-2.5 text-sm tabular-nums outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40"
          />
          <span className="self-center text-xs text-muted-foreground">units, counted in {fmtPeriod(f.periodStart, f.periodEnd)}</span>
        </div>
      ) : (
        <label className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          Cause
          <NativeSelect aria-label="Cause" value={cause} onChange={(e) => setCause(e.target.value as FlagCause)}>
            {(Object.keys(CAUSE) as FlagCause[]).map((c) => (
              <option key={c} value={c}>
                {CAUSE[c].label}
              </option>
            ))}
          </NativeSelect>
          {cause !== f.cause && <span>The check said {CAUSE[f.cause].label.toLowerCase()}; both are kept.</span>}
        </label>
      )}
      <textarea
        aria-label="Remark"
        value={remark}
        onChange={(e) => setRemark(e.target.value)}
        maxLength={500}
        rows={2}
        placeholder={how === 'dismissed' ? 'Why it’s fine, e.g. a real sell-out' : 'What you found and what was done'}
        className="w-full resize-y rounded-md border border-border bg-background px-2.5 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40"
      />
      <div className="flex justify-end">
        <Button size="sm" disabled={pending || !remark.trim() || (how === 'loss' && !Number(qty))} onClick={submit}>
          {how === 'loss' ? 'Log and close' : 'Close flag'}
        </Button>
      </div>
    </div>
  );
}

function Adjustments({company, data, canEdit, pending, act}: {company: string; data: FlagsData; canEdit: boolean; pending: boolean; act: Act}) {
  const [store, setStore] = useState(data.stores[0]?.code ?? '');
  const [item, setItem] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [reason, setReason] = useState<AdjustmentReason>('pull_out');
  const [qty, setQty] = useState('');
  const [note, setNote] = useState('');
  const ready = store && item && from && to && from <= to && Number(qty) > 0;
  const field = 'h-8 rounded-md border border-border bg-background px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40';
  return (
    <div className="flex flex-col gap-4">
      {canEdit && (
        <Card>
          <CardContent className="flex flex-col gap-3">
            <p className="text-sm font-medium">Log stock that left without a sale</p>
            <p className="text-xs text-muted-foreground">Pull-outs, damage and losses lower that month’s start, so the form vs. sales check doesn’t flag them.</p>
            <div className="flex flex-wrap gap-2">
              <NativeSelect aria-label="Store" value={store} onChange={(e) => setStore(e.target.value)}>
                {data.stores.map((s) => (
                  <option key={s.code} value={s.code}>
                    {s.code} · {s.name}
                  </option>
                ))}
              </NativeSelect>
              <NativeSelect aria-label="Item" value={item} onChange={(e) => setItem(e.target.value)} wrapperClassName="min-w-0 flex-1">
                <option value="">Pick the item…</option>
                {data.items.map((i) => (
                  <option key={i.code} value={i.code}>
                    {i.code} · {i.name}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                Cycle <input type="date" aria-label="Cycle start" value={from} onChange={(e) => setFrom(e.target.value)} className={field} />
              </label>
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                to <input type="date" aria-label="Cycle end" value={to} onChange={(e) => setTo(e.target.value)} className={field} />
              </label>
              <NativeSelect aria-label="What happened" value={reason} onChange={(e) => setReason(e.target.value as AdjustmentReason)}>
                {(Object.keys(REASON) as AdjustmentReason[]).map((r) => (
                  <option key={r} value={r}>
                    {REASON[r]}
                  </option>
                ))}
              </NativeSelect>
              <input aria-label="Units" inputMode="numeric" placeholder="Units" value={qty} onChange={(e) => setQty(e.target.value.replace(/\D/g, ''))} className={cn(field, 'w-24 tabular-nums')} />
            </div>
            <input aria-label="Note" placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} className={field} />
            <div className="flex justify-end">
              <Button
                size="sm"
                disabled={pending || !ready}
                onClick={() =>
                  act(
                    () => addAdjustmentAction({company, store, item, periodStart: from, periodEnd: to, reason, qty: Number(qty), note}),
                    'Logged. That store’s checks ran again.',
                    () => {
                      setQty('');
                      setNote('');
                    },
                  )
                }
              >
                Log adjustment
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
      {data.adjustments.length === 0 ? (
        <Card>
          <CardContent className="px-6 py-10 text-center text-sm text-muted-foreground">No adjustments logged yet.</CardContent>
        </Card>
      ) : (
        <ul className="flex flex-col gap-2">
          {data.adjustments.map((a: AdjustmentRow) => (
            <li key={a.id}>
              <Card className="py-0">
                <CardContent className="flex items-center justify-between gap-4 px-4 py-3">
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <p className="text-sm">
                      <span className="font-medium">{REASON[a.reason]}</span> · <span className="tabular-nums">{a.qty}</span> units ·{' '}
                      <span className="font-mono text-xs text-muted-foreground">{a.itemCode}</span> {a.itemName ?? ''}
                    </p>
                    <p className="font-mono text-[11px] text-muted-foreground">
                      {a.storeCode} {a.storeName ?? ''} · {fmtPeriod(a.periodStart, a.periodEnd)}
                      {a.sourceFlagId ? ' · from a flag' : ''}
                      {a.createdBy ? ` · ${a.createdBy}` : ''}
                    </p>
                    {a.note && <p className="text-xs text-muted-foreground">{a.note}</p>}
                  </div>
                  {canEdit && (
                    <Button size="sm" variant="ghost" disabled={pending} aria-label="Delete adjustment" onClick={() => act(() => deleteAdjustmentAction({company, id: a.id}), 'Deleted. That store’s checks ran again.')}>
                      <Trash2 className="size-3.5" />
                    </Button>
                  )}
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
