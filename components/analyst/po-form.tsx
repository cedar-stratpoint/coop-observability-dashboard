'use client';

import {useMemo, useRef, useState, useTransition} from 'react';
import Link from 'next/link';
import {useRouter} from 'next/navigation';
import {AlertTriangle, CheckCircle2, FileSpreadsheet, FileText, Loader2, Search, UploadCloud} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {Card, CardContent} from '@/components/ui/card';
import {cn} from '@/lib/utils';
import {GL_PAGE} from '@/src/goldline-ui';
import type {PoFormProduct, PoFormRow, PoFormView} from '@/src/goldline-po-form-data';
import {activatePoFormAction, discardPoFormDraftAction, setPoFormItemAction} from '@/app/stock/actions';
import {ink, ReconTabs, tint} from '@/components/analyst/audit-shared';

// The PO form page (NICH-17, PO leg). Upload Nichido's PURCHASE ORDER FORM (xlsx or
// pdf); it's read into a draft; the admin reviews what was read (and what changes against
// the current form), fixes any product by hand, then makes it the PO form. The active
// form decides which products are active in the reconciliation and in restock.

const FIELD =
  'h-9 rounded-lg border border-border bg-card px-2.5 text-sm outline-none transition-colors duration-150 [@media(hover:hover)]:hover:border-foreground/25 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40';

type Filter = 'all' | 'on' | 'off' | 'changes';

const titleCase = (s: string) => s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
const fmtDate = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('en-US', {month: 'short', day: 'numeric', year: 'numeric'}) : null);

export function PoFormPage({data, company, canEdit}: {data: PoFormView; company: string | null; canEdit: boolean}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');

  const current = data.current;
  const isDraft = current?.status === 'draft';
  const products = useMemo(() => data.products.map((p) => (p.item_code in overrides ? {...p, onForm: overrides[p.item_code]} : p)), [data.products, overrides]);
  const onCount = products.filter((p) => p.onForm).length;
  const changed = (p: PoFormProduct) => isDraft && Boolean(data.active) && p.onForm !== p.onActive;
  const changes = products.filter(changed);

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return products.filter(
      (p) =>
        (filter === 'all' || (filter === 'on' && p.onForm) || (filter === 'off' && !p.onForm) || (filter === 'changes' && changed(p))) &&
        (!needle || p.name.toLowerCase().includes(needle) || p.item_code.toLowerCase().includes(needle) || p.line.toLowerCase().includes(needle)),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [products, filter, q, isDraft]);
  const groups = useMemo(() => {
    const m = new Map<string, PoFormProduct[]>();
    for (const p of visible) m.set(p.line, [...(m.get(p.line) ?? []), p]);
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [visible]);

  const run = (fn: () => Promise<{ok: boolean; error?: string}>, done?: string, after?: () => void) => {
    setError(null);
    setNote(null);
    start(async () => {
      const res = await fn();
      if (!res.ok) {
        setError(res.error ?? 'Something went wrong.');
        return;
      }
      if (done) setNote(done);
      after?.();
      router.refresh();
    });
  };

  const toggle = (p: PoFormProduct, on: boolean) => {
    if (!current) return;
    setOverrides((o) => ({...o, [p.item_code]: on}));
    setError(null);
    start(async () => {
      const res = await setPoFormItemAction({company, form: current.id, item: p.item_code, on});
      if (!res.ok) {
        setOverrides((o) => ({...o, [p.item_code]: !on}));
        setError(res.error);
      }
    });
  };

  return (
    <div className={GL_PAGE}>
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="max-w-2xl">
          <p className="font-mono text-[11px] tracking-[0.14em] text-muted-foreground uppercase">Reconciliation</p>
          <h1 className="mt-1 font-heading text-2xl font-semibold tracking-tight">The PO form</h1>
          <p className="mt-1.5 text-sm text-muted-foreground">
            The latest PO form decides which products are active. A product printed on it is still delivered; one that isn&apos;t is being phased out, and restock holds it.
          </p>
        </div>
        <ReconTabs />
      </header>

      {!data.configured && (
        <div className="rounded-lg border border-dashed border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">The database isn&apos;t connected on this environment.</div>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <ActiveCard active={data.active} onCount={data.active && current?.id === data.active.id ? onCount : products.filter((p) => p.onActive).length} total={products.length} />
        {canEdit ? <Dropzone company={company} onDone={(id) => router.push(`/stock/po-form?form=${id}`)} /> : <ReadOnlyNote />}
      </div>

      {(error || note) && (
        <p role={error ? 'alert' : 'status'} className={cn('rounded-lg px-3 py-2 text-sm', error ? '' : 'text-muted-foreground')} style={error ? {color: ink('var(--status-crit)'), background: tint('var(--status-crit)', 10)} : undefined}>
          {error ?? note}
        </p>
      )}

      {isDraft && current && (
        <DraftBanner
          form={current}
          onCount={onCount}
          diff={data.active ? {added: changes.filter((p) => p.onForm).length, dropped: changes.filter((p) => !p.onForm).length} : null}
          pending={pending}
          canEdit={canEdit}
          onActivate={() => run(() => activatePoFormAction({company, form: current.id}), 'This is now the PO form. Reconciliation and restock use it from now on.', () => router.replace('/stock/po-form'))}
          onDiscard={() => run(() => discardPoFormDraftAction({company, form: current.id}), 'Draft discarded.', () => router.replace('/stock/po-form'))}
          onShowChanges={() => setFilter('changes')}
        />
      )}

      {current && current.unmatched.length > 0 && <Unmatched form={current} />}

      {current ? (
        <section className="flex flex-col gap-3" aria-label="Products">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="inline-flex rounded-lg bg-muted p-1" role="group" aria-label="Show">
              {(
                [
                  ['all', `All ${products.length}`],
                  ['on', `On the form ${onCount}`],
                  ['off', `Not on it ${products.length - onCount}`],
                  ...(isDraft && data.active ? ([['changes', `Changes ${changes.length}`]] as const) : []),
                ] as Array<[Filter, string]>
              ).map(([k, label]) => (
                <button
                  key={k}
                  type="button"
                  aria-pressed={filter === k}
                  onClick={() => setFilter(k)}
                  className={cn(
                    'rounded-md px-3 py-1.5 text-sm font-medium tabular-nums transition-colors duration-150',
                    filter === k ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground [@media(hover:hover)]:hover:text-foreground',
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a product, line or code" aria-label="Find a product" className={cn(FIELD, 'w-72 pl-8')} />
            </div>
          </div>

          {groups.length === 0 ? (
            <Card>
              <CardContent className="px-6 py-12 text-center text-sm text-muted-foreground">No products here.</CardContent>
            </Card>
          ) : (
            <div className="grid gap-4 xl:grid-cols-2">
              {groups.map(([line, items]) => (
                <Card key={line} className="gap-0 overflow-hidden py-0">
                  <div className="flex items-baseline gap-2 border-b border-border bg-muted/30 px-4 py-2.5">
                    <h3 className="truncate font-heading text-sm font-semibold">{line}</h3>
                    <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">
                      {items.filter((p) => p.onForm).length} of {items.length} on the form
                    </span>
                  </div>
                  <ul>
                    {items.map((p) => (
                      <ProductLine key={p.item_code} p={p} change={changed(p) ? (p.onForm ? 'added' : 'dropped') : null} editable={canEdit && current.status !== 'superseded'} onToggle={(on) => toggle(p, on)} />
                    ))}
                  </ul>
                </Card>
              ))}
            </div>
          )}
        </section>
      ) : (
        <Card>
          <CardContent className="flex flex-col items-center gap-1 px-6 py-14 text-center">
            <p className="font-heading text-sm font-semibold">No PO form yet</p>
            <p className="max-w-sm text-sm text-muted-foreground">Upload Nichido&apos;s PURCHASE ORDER FORM above. You&apos;ll review what was read before it counts.</p>
          </CardContent>
        </Card>
      )}

      {data.forms.length > 1 && <History forms={data.forms} currentId={current?.id ?? null} />}
    </div>
  );
}

function ActiveCard({active, onCount, total}: {active: PoFormRow | null; onCount: number | null; total: number}) {
  return (
    <Card className="gap-0 py-0">
      <CardContent className="flex h-full flex-col justify-between gap-5 p-5">
        <div className="flex items-start gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl" style={{background: tint(active ? 'var(--status-good)' : 'var(--muted-foreground)'), color: ink(active ? 'var(--status-good)' : 'var(--muted-foreground)')}}>
            {active ? <CheckCircle2 className="size-5" /> : <FileSpreadsheet className="size-5" />}
          </span>
          <div className="min-w-0">
            <p className="text-xs font-medium text-muted-foreground">Current PO form</p>
            <p className="mt-0.5 truncate font-heading text-base font-semibold">{active ? active.file_name : 'None yet'}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {active ? `In use since ${fmtDate(active.activated_at)}${active.activated_by ? ` · ${active.activated_by}` : ''}` : 'Until one is in use, every product that isn’t retired counts as active.'}
            </p>
          </div>
        </div>
        {active && onCount != null && (
          <div className="flex flex-col gap-2">
            <div className="flex h-2 overflow-hidden rounded-full bg-muted">
              <span className="h-full rounded-full transition-[width] duration-300 ease-out" style={{width: `${(onCount / Math.max(1, total)) * 100}%`, background: 'var(--status-good)'}} />
            </div>
            <p className="flex justify-between text-xs text-muted-foreground tabular-nums">
              <span>
                <span className="font-heading text-sm font-semibold text-foreground">{onCount}</span> active
              </span>
              <span>
                <span className="font-heading text-sm font-semibold text-foreground">{total - onCount}</span> phasing out
              </span>
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Dropzone({company, onDone}: {company: string | null; onDone: (id: string) => void}) {
  const input = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const send = async (file: File | undefined) => {
    if (!file || busy) return;
    if (!/\.(xlsx|pdf)$/i.test(file.name)) {
      setErr('Upload the PO form as an Excel (.xlsx) or PDF file.');
      return;
    }
    setErr(null);
    setBusy(file.name);
    try {
      const body = new FormData();
      body.set('file', file);
      const res = await fetch(`/api/goldline/po-form?company=${encodeURIComponent(company ?? '')}`, {method: 'POST', body});
      const out = (await res.json().catch(() => ({}))) as {ok?: boolean; id?: string; error?: string};
      if (!res.ok || !out.id) throw new Error(out.error ?? 'The PO form could not be read.');
      onDone(out.id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'The PO form could not be read.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(false);
        void send(e.dataTransfer.files?.[0]);
      }}
      className={cn(
        'relative flex min-h-[9.5rem] flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-6 py-5 text-center transition-[border-color,background-color] duration-150',
        drag ? 'border-primary bg-accent' : 'border-border bg-card/60',
      )}
    >
      {busy ? (
        <>
          <Loader2 className="size-6 animate-spin text-primary" aria-hidden />
          <p className="text-sm font-medium">Reading {busy}</p>
          <p className="text-xs text-muted-foreground">Matching each printed line to a product. A PDF takes up to a minute.</p>
        </>
      ) : (
        <>
          <span className="flex size-10 items-center justify-center rounded-xl bg-accent text-accent-foreground">
            <UploadCloud className="size-5" aria-hidden />
          </span>
          <p className="text-sm">
            <span className="font-medium">Drop the new PO form here</span> <span className="text-muted-foreground">or</span>{' '}
            <button type="button" onClick={() => input.current?.click()} className="font-medium text-primary underline-offset-4 [@media(hover:hover)]:hover:underline">
              choose a file
            </button>
          </p>
          <p className="text-xs text-muted-foreground">Excel (.xlsx) or PDF. It opens as a draft for you to check first.</p>
          {err && (
            <p role="alert" className="mt-1 text-xs font-medium" style={{color: ink('var(--status-crit)')}}>
              {err}
            </p>
          )}
        </>
      )}
      <input ref={input} type="file" accept=".xlsx,.pdf,application/pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" className="sr-only" onChange={(e) => void send(e.target.files?.[0] ?? undefined)} />
    </div>
  );
}

function ReadOnlyNote() {
  return (
    <div className="flex items-center rounded-xl border border-border bg-muted/30 px-5 py-4 text-sm text-muted-foreground">
      Only a company-wide editor can upload a new PO form.
    </div>
  );
}

function DraftBanner({
  form,
  onCount,
  diff,
  pending,
  canEdit,
  onActivate,
  onDiscard,
  onShowChanges,
}: {
  form: PoFormRow;
  onCount: number;
  diff: {added: number; dropped: number} | null;
  pending: boolean;
  canEdit: boolean;
  onActivate: () => void;
  onDiscard: () => void;
  onShowChanges: () => void;
}) {
  const warn = 'var(--status-warn)';
  return (
    <section aria-label="Draft to review" className="flex flex-col gap-4 rounded-xl border p-5 md:flex-row md:items-center md:justify-between" style={{borderColor: tint(warn, 45), background: tint(warn, 7)}}>
      <div className="flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl" style={{background: tint(warn, 18), color: ink(warn)}}>
          {form.file_kind === 'pdf' ? <FileText className="size-5" /> : <FileSpreadsheet className="size-5" />}
        </span>
        <div>
          <p className="text-xs font-medium" style={{color: ink(warn)}}>
            Draft · not in use yet
          </p>
          <p className="font-heading text-base font-semibold">{form.file_name}</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Read <span className="font-medium text-foreground tabular-nums">{form.lines_read}</span> printed lines into <span className="font-medium text-foreground tabular-nums">{onCount}</span> products
            {form.unmatched.length > 0 && (
              <>
                , <span className="font-medium text-foreground tabular-nums">{form.unmatched.length}</span> {form.unmatched.length === 1 ? 'line' : 'lines'} to check
              </>
            )}
            .
            {diff && (
              <>
                {' '}
                Against the current form:{' '}
                <button type="button" onClick={onShowChanges} className="font-medium text-foreground underline decoration-dotted underline-offset-4">
                  {diff.added} added · {diff.dropped} dropped
                </button>
                .
              </>
            )}
          </p>
        </div>
      </div>
      {canEdit && (
        <div className="flex shrink-0 gap-2">
          <Button variant="ghost" onClick={onDiscard} disabled={pending}>
            Discard
          </Button>
          <Button onClick={onActivate} disabled={pending} className="transition-transform duration-150 ease-out active:scale-[0.97]">
            {pending ? <Loader2 className="size-4 animate-spin" /> : <CheckCircle2 className="size-4" />}
            Make this the PO form
          </Button>
        </div>
      )}
    </section>
  );
}

function Unmatched({form}: {form: PoFormRow}) {
  return (
    <Card className="gap-0 py-0">
      <CardContent className="flex flex-col gap-3 p-5">
        <div className="flex items-start gap-2.5">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" style={{color: 'var(--status-warn)'}} aria-hidden />
          <div>
            <p className="text-sm font-medium">
              {form.unmatched.length} printed {form.unmatched.length === 1 ? 'line' : 'lines'} didn&apos;t match a product
            </p>
            <p className="text-xs text-muted-foreground">A new product not in the catalog yet, or a different name. Switch the right product on below if it should count.</p>
          </div>
        </div>
        <ul className="flex flex-wrap gap-1.5">
          {form.unmatched.map((u, i) => (
            <li key={i} className="rounded-md border border-border bg-muted/40 px-2 py-1 text-xs">
              <span className="text-muted-foreground">{/^page/i.test(u.page) ? titleCase(u.page) : `Page ${u.page}`} · </span>
              {u.text}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function ProductLine({p, change, editable, onToggle}: {p: PoFormProduct; change: 'added' | 'dropped' | null; editable: boolean; onToggle: (on: boolean) => void}) {
  const good = 'var(--status-good)';
  const crit = 'var(--status-crit)';
  return (
    <li className="flex items-center gap-3 border-b border-border/60 px-4 py-2.5 last:border-0">
      <div className="min-w-0 flex-1">
        <p className={cn('flex items-center gap-2 truncate text-sm', p.onForm ? 'font-medium' : 'text-muted-foreground')}>
          <span className="truncate" title={p.name}>{p.shade}</span>
          {change && (
            <span className="shrink-0 rounded-full px-1.5 py-px text-[10px] font-semibold tracking-wide uppercase" style={{color: ink(change === 'added' ? good : crit), background: tint(change === 'added' ? good : crit)}}>
              {change === 'added' ? 'Added' : 'Dropped'}
            </span>
          )}
          {p.retired && <span className="shrink-0 rounded-full bg-muted px-1.5 py-px text-[10px] font-medium text-muted-foreground">Retired</span>}
        </p>
        <p className="truncate text-[11px] text-muted-foreground">
          <span className="font-mono">{p.item_code}</span>
          {p.onForm && <> · {p.byHand ? 'Added by hand' : p.source ? <>Read from “{p.source}”</> : null}</>}
        </p>
      </div>
      <Switch checked={p.onForm} disabled={!editable} onChange={onToggle} label={`${p.name} on the PO form`} />
    </li>
  );
}

function Switch({checked, disabled, onChange, label}: {checked: boolean; disabled?: boolean; onChange: (v: boolean) => void; label: string}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-6 w-10 shrink-0 items-center rounded-full transition-colors duration-200 ease-out focus-visible:ring-3 focus-visible:ring-ring/40 focus-visible:outline-none disabled:cursor-default disabled:opacity-60',
        checked ? 'bg-primary' : 'bg-muted-foreground/25',
      )}
    >
      <span
        aria-hidden
        className="inline-block size-5 rounded-full bg-card shadow-sm transition-transform duration-200 ease-[cubic-bezier(0.23,1,0.32,1)]"
        style={{transform: `translateX(${checked ? 18 : 2}px)`}}
      />
    </button>
  );
}

function History({forms, currentId}: {forms: PoFormRow[]; currentId: string | null}) {
  const label: Record<PoFormRow['status'], string> = {draft: 'Draft', active: 'In use', superseded: 'Replaced'};
  return (
    <section aria-label="Earlier PO forms" className="flex flex-col gap-2">
      <h2 className="font-heading text-sm font-semibold">All uploads</h2>
      <Card className="gap-0 py-0">
        <ul>
          {forms.map((f) => (
            <li key={f.id} className="border-b border-border/60 last:border-0">
              <Link
                href={`/stock/po-form?form=${f.id}`}
                className={cn('flex items-center gap-3 px-4 py-2.5 text-sm transition-colors duration-150 [@media(hover:hover)]:hover:bg-muted/40', f.id === currentId && 'bg-muted/40')}
              >
                {f.file_kind === 'pdf' ? <FileText className="size-4 text-muted-foreground" /> : <FileSpreadsheet className="size-4 text-muted-foreground" />}
                <span className="min-w-0 flex-1 truncate font-medium">{f.file_name}</span>
                <span className="text-xs text-muted-foreground">{fmtDate(f.uploaded_at)}</span>
                <span
                  className="rounded-full px-2 py-0.5 text-[11px] font-medium"
                  style={f.status === 'active' ? {color: ink('var(--status-good)'), background: tint('var(--status-good)')} : f.status === 'draft' ? {color: ink('var(--status-warn)'), background: tint('var(--status-warn)')} : undefined}
                >
                  <span className={f.status === 'superseded' ? 'text-muted-foreground' : undefined}>{label[f.status]}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </Card>
    </section>
  );
}
