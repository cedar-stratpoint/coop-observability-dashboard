'use client';

import {useEffect, useMemo, useState} from 'react';
import {useRouter} from 'next/navigation';
import {AlertDialog} from '@base-ui/react/alert-dialog';
import {AlertTriangle, Check, CheckCheck, CircleSlash, Loader2, X} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {cn} from '@/lib/utils';
import {commitAllAction, planCommitAllAction, type BulkCommitForm} from '@/app/uploads/actions';
import {draftKey, parseDraft} from '@/src/review-draft';
import {fmtTriagePeriod} from '@/src/goldline-triage-format';
import type {TriageForm} from '@/src/goldline-triage-data';

// "Commit all" for a grouped upload (Nov 25). One button on the scan's Per store view;
// the confirm says exactly what will happen before anything is written:
// - Ready: committed as read, with the store and period each form's review would use.
// - Unchecked rows: forms with low-confidence rows nobody has looked at. Left out unless
//   the box is ticked (the single-form commit makes you resolve them first).
// - Skipped: anything a single commit would refuse (no store, still reading, page twice,
//   mixed stores), plus a form with edits saved in this browser, so a bulk commit never
//   throws away someone's fixes. Those open on their own.
// Forms commit one at a time, so the progress is real and one failure leaves the rest.

type Row = BulkCommitForm & {label: string; draft: boolean};
type Result = {batchId: string; ok: boolean; committed: number; error?: string};

const TONE = {good: 'var(--status-good)', warn: 'var(--status-warn)', crit: 'var(--status-crit)'} as const;
const tint = (t: keyof typeof TONE, pct = 12) => `color-mix(in oklab, ${TONE[t]} ${pct}%, transparent)`;
const ink = (t: keyof typeof TONE) => `color-mix(in oklab, ${TONE[t]} 72%, var(--foreground))`;

function hasDraft(batchId: string): boolean {
  try {
    const d = parseDraft(window.localStorage.getItem(draftKey(batchId)));
    return Boolean(d && Object.keys(d.pages).length);
  } catch {
    return false;
  }
}

export function CommitAllDialog({
  company,
  forms,
  storeNames,
  notListed,
}: {
  company: string;
  forms: TriageForm[];
  /** The registry's name per store code, so a form reads by its real store name. */
  storeNames: Map<string, string | null>;
  /** Forms with pages to commit that this can't take (no store yet, or pages shared with another form). */
  notListed: number;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [plan, setPlan] = useState<Row[] | 'loading' | {error: string}>('loading');
  const [includeFlagged, setIncludeFlagged] = useState(false);
  const [phase, setPhase] = useState<'confirm' | 'committing' | 'done'>('confirm');
  const [results, setResults] = useState<Result[]>([]);

  const labels = useMemo(
    () => new Map(forms.map((f) => [f.batchId ?? '', (f.storeCode && storeNames.get(f.storeCode)) || f.storeName || (f.storeCode ? `Store ${f.storeCode}` : 'No store')])),
    [forms, storeNames],
  );
  const ids = useMemo(() => forms.map((f) => f.batchId).filter((x): x is string => Boolean(x)), [forms]);

  useEffect(() => {
    if (!open) return;
    setPhase('confirm');
    setResults([]);
    setIncludeFlagged(false);
    setPlan('loading');
    let live = true;
    planCommitAllAction({company, batchIds: ids})
      .then((r) => {
        if (!live) return;
        if (!r.ok) return setPlan({error: r.error});
        setPlan(r.forms.map((f) => ({...f, label: labels.get(f.batchId) ?? `Store ${f.storeCode}`, draft: hasDraft(f.batchId)})));
      })
      .catch(() => live && setPlan({error: 'Could not read these forms. Please try again.'}));
    return () => {
      live = false;
    };
  }, [open, company, ids, labels]);

  const rows = Array.isArray(plan) ? plan : [];
  const ready = rows.filter((r) => !r.draft && r.verdict.state === 'ready');
  const flagged = rows.filter((r) => !r.draft && r.verdict.state === 'flagged');
  const skipped = rows.filter((r) => r.draft || r.verdict.state === 'blocked');
  const going = includeFlagged ? [...ready, ...flagged] : ready;
  const goingRows = going.reduce((n, r) => n + r.rows, 0);
  const flaggedRows = flagged.reduce((n, r) => n + (r.verdict.state === 'flagged' ? r.verdict.rows : 0), 0);
  const done = results.length;
  const okCount = results.filter((r) => r.ok).length;
  const okRows = results.reduce((n, r) => n + r.committed, 0);

  async function commit() {
    setPhase('committing');
    const out: Result[] = [];
    for (const f of going) {
      const r = await commitAllAction({company, batchIds: [f.batchId], includeFlagged}).catch(() => ({ok: false as const, error: 'Could not reach the server.'}));
      out.push(r.ok ? (r.results[0] ?? {batchId: f.batchId, ok: false, committed: 0, error: 'Not committed.'}) : {batchId: f.batchId, ok: false, committed: 0, error: r.error});
      setResults([...out]);
    }
    setPhase('done');
    router.refresh();
  }

  const close = () => {
    if (phase === 'committing') return; // never abandon a commit in flight
    setOpen(false);
  };

  return (
    <AlertDialog.Root open={open} onOpenChange={(o) => (o ? setOpen(true) : close())}>
      <AlertDialog.Trigger
        render={
          <Button size="sm" className="shrink-0 gap-1.5 transition-transform duration-150 ease-out active:scale-[0.97]">
            <CheckCheck className="size-4" /> Commit all
          </Button>
        }
      />
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="fixed inset-0 z-50 bg-black/45 transition-opacity duration-150 ease-out data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
        <AlertDialog.Popup className="fixed top-1/2 left-1/2 z-50 flex max-h-[min(44rem,calc(100dvh-2rem))] w-[min(34rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col rounded-2xl border border-border bg-popover text-popover-foreground shadow-xl outline-none transition-[opacity,transform] duration-200 ease-out data-[ending-style]:scale-[0.97] data-[ending-style]:opacity-0 data-[starting-style]:scale-[0.97] data-[starting-style]:opacity-0">
          {phase === 'confirm' ? (
            <>
              <div className="flex items-start gap-3 px-6 pt-6">
                <span className="grid size-10 shrink-0 place-items-center rounded-full" style={{background: tint('good', 14), color: ink('good')}}>
                  <CheckCheck className="size-5" aria-hidden />
                </span>
                <div className="flex min-w-0 flex-col gap-1">
                  <AlertDialog.Title className="font-heading text-lg font-semibold tracking-tight">
                    {Array.isArray(plan) ? `Commit ${going.length} ${going.length === 1 ? 'form' : 'forms'}?` : 'Commit all forms?'}
                  </AlertDialog.Title>
                  <AlertDialog.Description className="text-sm text-muted-foreground">
                    Each form&apos;s counts go into Inventory as read, with the store and period shown. Inventory and Reconcile use them right away.
                  </AlertDialog.Description>
                </div>
              </div>

              <div className="mt-5 flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto overscroll-contain px-6 pb-2">
                {plan === 'loading' ? (
                  <p className="inline-flex items-center gap-2 py-6 text-sm text-muted-foreground">
                    <Loader2 className="size-4 animate-spin" aria-hidden /> Checking every form in this upload…
                  </p>
                ) : 'error' in plan ? (
                  <p role="alert" className="py-6 text-sm text-destructive">{plan.error}</p>
                ) : (
                  <>
                    {ready.length > 0 && (
                      <Section title="Ready" count={ready.length} tone="good">
                        {ready.map((r) => (
                          <FormLine key={r.batchId} row={r} icon={<Check className="size-3.5" />} tone="good" note={`${r.pages} ${r.pages === 1 ? 'page' : 'pages'} · ${r.rows} rows`} />
                        ))}
                      </Section>
                    )}

                    {flagged.length > 0 && (
                      <Section title="Rows nobody has checked" count={flagged.length} tone="warn">
                        <label className="mb-1 flex cursor-pointer items-start gap-2.5 rounded-xl border px-3 py-2.5 text-sm transition-colors duration-150 [@media(hover:hover)]:hover:bg-muted/60" style={includeFlagged ? {borderColor: tint('warn', 55), background: tint('warn', 8)} : undefined}>
                          <input type="checkbox" checked={includeFlagged} onChange={(e) => setIncludeFlagged(e.target.checked)} className="mt-0.5 size-4 accent-[var(--status-warn)]" />
                          <span>
                            Also commit these {flagged.length} {flagged.length === 1 ? 'form' : 'forms'} without checking their <strong className="tabular-nums">{flaggedRows}</strong> low-confidence rows
                            <span className="block text-xs text-muted-foreground">Left unticked, open each form to check them first.</span>
                          </span>
                        </label>
                        {flagged.map((r) => (
                          <FormLine
                            key={r.batchId}
                            row={r}
                            icon={<AlertTriangle className="size-3.5" />}
                            tone="warn"
                            dim={!includeFlagged}
                            note={`${r.verdict.state === 'flagged' ? r.verdict.rows : 0} low-confidence rows · ${r.rows} rows`}
                          />
                        ))}
                      </Section>
                    )}

                    {skipped.length > 0 && (
                      <Section title="Skipped" count={skipped.length} tone={null}>
                        {skipped.map((r) => (
                          <FormLine
                            key={r.batchId}
                            row={r}
                            icon={<CircleSlash className="size-3.5" />}
                            tone={null}
                            note={r.draft ? 'Has edits saved in this browser. Open it to commit them.' : r.verdict.state === 'blocked' ? r.verdict.reason : ''}
                          />
                        ))}
                      </Section>
                    )}

                    {rows.length === 0 && <p className="py-6 text-sm text-muted-foreground">No forms in this upload are waiting to be committed.</p>}
                    {notListed > 0 && (
                      <p className="text-xs text-muted-foreground">
                        {notListed} more {notListed === 1 ? 'form isn’t' : 'forms aren’t'} listed: {notListed === 1 ? 'it needs' : 'they need'} a store first, or {notListed === 1 ? 'its' : 'their'} pages are mixed with another form. Open {notListed === 1 ? 'it' : 'those'} from the board.
                      </p>
                    )}
                  </>
                )}
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3 border-t px-6 py-4">
                <p className="text-xs text-muted-foreground tabular-nums">{going.length > 0 ? `${goingRows.toLocaleString('en-US')} rows across ${new Set(going.map((g) => g.storeCode)).size} ${new Set(going.map((g) => g.storeCode)).size === 1 ? 'store' : 'stores'}` : ''}</p>
                <div className="flex gap-2">
                  <AlertDialog.Close render={<Button variant="ghost" />}>Cancel</AlertDialog.Close>
                  <Button onClick={commit} disabled={going.length === 0} className="gap-1.5 transition-transform duration-150 ease-out active:scale-[0.97]">
                    <CheckCheck className="size-4" /> Commit {going.length} {going.length === 1 ? 'form' : 'forms'}
                  </Button>
                </div>
              </div>
            </>
          ) : (
            <div className="flex flex-col gap-5 p-6">
              <div className="flex items-center gap-3">
                <span className="grid size-10 shrink-0 place-items-center rounded-full" style={{background: tint(phase === 'done' && okCount < done ? 'warn' : 'good', 14), color: ink(phase === 'done' && okCount < done ? 'warn' : 'good')}}>
                  {phase === 'committing' ? <Loader2 className="size-5 animate-spin" aria-hidden /> : okCount < done ? <AlertTriangle className="size-5" aria-hidden /> : <Check className="size-5" aria-hidden />}
                </span>
                <div className="flex flex-col gap-0.5">
                  <AlertDialog.Title className="font-heading text-lg font-semibold tracking-tight">
                    {phase === 'committing' ? `Committing form ${Math.min(done + 1, going.length)} of ${going.length}` : `Committed ${okCount} of ${going.length} ${going.length === 1 ? 'form' : 'forms'}`}
                  </AlertDialog.Title>
                  <p className="text-sm text-muted-foreground tabular-nums" aria-live="polite">
                    {okRows.toLocaleString('en-US')} rows written{phase === 'committing' ? ' so far' : ''}
                  </p>
                </div>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                <div className="h-full rounded-full bg-[var(--status-good)] transition-[width] duration-300 ease-out" style={{width: `${going.length ? (done / going.length) * 100 : 0}%`}} />
              </div>
              {results.some((r) => !r.ok) && (
                <ul className="flex max-h-48 flex-col gap-1.5 overflow-y-auto text-sm">
                  {results
                    .filter((r) => !r.ok)
                    .map((r) => {
                      const f = going.find((g) => g.batchId === r.batchId);
                      return (
                        <li key={r.batchId} className="flex gap-2 rounded-lg px-3 py-2" style={{background: tint('crit', 8)}}>
                          <X className="mt-0.5 size-3.5 shrink-0" style={{color: ink('crit')}} aria-hidden />
                          <span>
                            <span className="font-medium">{f?.label}</span> <span className="text-muted-foreground">{f ? fmtTriagePeriod(f.periodStart, f.periodEnd) : ''}</span>
                            <span className="block text-xs text-muted-foreground">{r.error}</span>
                          </span>
                        </li>
                      );
                    })}
                </ul>
              )}
              {phase === 'done' && (
                <div className="flex justify-end">
                  <AlertDialog.Close render={<Button />}>Done</AlertDialog.Close>
                </div>
              )}
            </div>
          )}
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

function Section({title, count, tone, children}: {title: string; count: number; tone: keyof typeof TONE | null; children: React.ReactNode}) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="flex items-baseline gap-2 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
        <span style={tone ? {color: ink(tone)} : undefined}>{title}</span>
        <span className="tabular-nums">{count}</span>
      </h3>
      <ul className="flex flex-col gap-1">{children}</ul>
    </section>
  );
}

function FormLine({row, icon, tone, note, dim}: {row: Row; icon: React.ReactNode; tone: keyof typeof TONE | null; note: string; dim?: boolean}) {
  return (
    <li className={cn('grid grid-cols-[1.5rem_minmax(0,1fr)] items-start gap-x-2.5 rounded-xl px-2 py-2 transition-opacity duration-150', dim && 'opacity-55')}>
      <span className="mt-0.5 grid size-6 place-items-center rounded-full" style={tone ? {background: tint(tone, 14), color: ink(tone)} : undefined}>
        <span className={tone ? undefined : 'text-muted-foreground'}>{icon}</span>
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-sm font-medium">{row.label}</span>
          {row.storeCode && <span className="shrink-0 font-mono text-xs text-muted-foreground">{row.storeCode}</span>}
        </span>
        <span className="text-xs text-muted-foreground">
          {row.periodStart ? fmtTriagePeriod(row.periodStart, row.periodEnd) : 'No period'}
          {note ? ` · ${note}` : ''}
        </span>
      </span>
    </li>
  );
}
