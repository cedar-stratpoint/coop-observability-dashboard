'use client';

import {useEffect, useMemo, useRef, useState} from 'react';
import {useRouter} from 'next/navigation';
import {AlertDialog} from '@base-ui/react/alert-dialog';
import {Combobox} from '@base-ui/react/combobox';
import {AlertTriangle, ArrowRight, Check, CheckCheck, ChevronsUpDown, CircleSlash, Loader2, MapPin, X} from 'lucide-react';
import {ToastStack, useToasts} from '@/components/analyst/toast-stack';
import {Button} from '@/components/ui/button';
import {cn} from '@/lib/utils';
import {commitAllAction, fileFormAction, planCommitAllAction, setAsideAction, type BulkCommitForm} from '@/app/uploads/actions';
import {suggestStore} from '@/src/store-suggest';
import type {StoreOption} from '@/src/goldline-data';
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
//
// Nov 25, "Commit all means everything": forms with no store get a store picker here
// (pre-filled only when the name read off the form clearly points at one store). Picked
// stores are saved first, which turns those pages into store forms, then everything commits
// in the same pass. Unchecked rows are included by default; untick to leave them for review.

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
  dropId,
  forms,
  needsStore,
  strays,
  needsDate,
  stores,
  storeNames,
  notListed,
}: {
  company: string;
  /** The upload these forms came from: the plan covers every open store form in it. */
  dropId: string | null;
  forms: TriageForm[];
  /** Forms with pages to commit but no store (none read, or one not in the store list). */
  needsStore: TriageForm[];
  /** Forms whose store and period were read (a misread year already corrected) but whose
   *  pages never became a store form, e.g. a lone page. Filed automatically on commit. */
  strays: TriageForm[];
  /** Forms with a store but no date read: they need a person to set the period. */
  needsDate: TriageForm[];
  stores: StoreOption[];
  /** The registry's name per store code, so a form reads by its real store name. */
  storeNames: Record<string, string | null>;
  /** Forms with pages to commit that this can't take (pages mixed with another form). */
  notListed: number;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [plan, setPlan] = useState<Row[] | 'loading' | {error: string}>('loading');
  const [includeFlagged, setIncludeFlagged] = useState(true);
  const [picks, setPicks] = useState<Record<string, string>>({});
  const [suggested, setSuggested] = useState<Record<string, string>>({});
  const [aside, setAside] = useState<Set<string>>(new Set());
  // What is actually committing (the confirm's forms, plus the forms a picked store creates).
  const [queue, setQueue] = useState<Row[]>([]);
  const [step, setStep] = useState<{at: number; of: number} | null>(null);
  const [phase, setPhase] = useState<'confirm' | 'committing' | 'done'>('confirm');
  const [results, setResults] = useState<Result[]>([]);

  const labels = useMemo(
    () => new Map(forms.map((f) => [f.batchId ?? '', (f.storeCode && storeNames[f.storeCode]) || f.storeName || (f.storeCode ? `Store ${f.storeCode}` : 'No store')])),
    [forms, storeNames],
  );
  const ids = useMemo(() => forms.map((f) => f.batchId).filter((x): x is string => Boolean(x)), [forms]);
  // Read when the dialog opens, not on every change: committing refreshes the page, and that
  // must not throw the dialog back to its confirm screen mid-way (Nov 25 QA).
  const latest = useRef({ids, labels, needsStore, stores});
  latest.current = {ids, labels, needsStore, stores};
  const {toasts, push, dismiss} = useToasts(8000);

  useEffect(() => {
    if (!open) return;
    const {ids, labels, needsStore, stores} = latest.current;
    setPhase('confirm');
    setResults([]);
    setQueue([]);
    setStep(null);
    setIncludeFlagged(true);
    setAside(new Set());
    const guess = Object.fromEntries(needsStore.flatMap((f) => {
      const code = f.periodStart ? suggestStore(f.storeName, stores) : null; // no date: it can't be filed anyway
      return code ? [[f.key, code]] : [];
    }));
    setSuggested(guess);
    setPicks(guess);
    setPlan('loading');
    let live = true;
    planCommitAllAction({company, batchIds: ids, dropId})
      .then((r) => {
        if (!live) return;
        if (!r.ok) return setPlan({error: r.error});
        setPlan(r.forms.map((f) => ({...f, label: labels.get(f.batchId) ?? storeNames[f.storeCode] ?? `Store ${f.storeCode}`, draft: hasDraft(f.batchId)})));
      })
      .catch(() => live && setPlan({error: 'Could not read these forms. Please try again.'}));
    return () => {
      live = false;
    };
  }, [open, company, dropId]); // eslint-disable-line react-hooks/exhaustive-deps -- read on open only (see latest)

  const rows = Array.isArray(plan) ? plan : [];
  const ready = rows.filter((r) => !r.draft && r.verdict.state === 'ready');
  const flagged = rows.filter((r) => !r.draft && r.verdict.state === 'flagged');
  // A form blocked only for lack of a store shows under Needs a store instead.
  const noStore = (r: Row) => r.verdict.state === 'blocked' && (!r.storeCode || !(r.storeCode in storeNames));
  const skipped = rows.filter((r) => r.draft || (r.verdict.state === 'blocked' && !noStore(r)));
  const going = includeFlagged ? [...ready, ...flagged] : ready;
  const goingRows = going.reduce((n, r) => n + r.rows, 0);
  const picked = needsStore.filter((f) => picks[f.key] && !aside.has(f.key) && f.periodStart && f.periodEnd);
  const asideForms = needsStore.filter((f) => aside.has(f.key));
  const total = going.length + picked.length + strays.length;
  const storeCount = new Set([...going.map((g) => g.storeCode), ...picked.map((f) => picks[f.key]), ...strays.map((f) => f.storeCode)]).size;
  const flaggedRows = flagged.reduce((n, r) => n + (r.verdict.state === 'flagged' ? r.verdict.rows : 0), 0);
  const done = results.length;
  const okCount = results.filter((r) => r.ok).length;
  const okRows = results.reduce((n, r) => n + r.committed, 0);

  async function commit() {
    setPhase('committing');
    const out: Result[] = [];
    const todo: Row[] = [...going];
    const shown: Row[] = [...going];
    if (asideForms.length) {
      // Set aside what has no store to go under (nearly blank sheets), so it leaves the queue.
      await setAsideAction({company, uploadIds: asideForms.flatMap((f) => f.uploadIds)}).catch(() => null);
    }
    // 1. File each form that will commit but isn't a store form yet: a picked store, or a
    //    stray whose store and period were read. Each becomes a store form of its own.
    const toFile = [...picked.map((f) => ({f, store: picks[f.key], picked: true})), ...strays.map((f) => ({f, store: f.storeCode ?? '', picked: false}))];
    if (toFile.length) {
      for (let i = 0; i < toFile.length; i++) {
        setStep({at: i + 1, of: toFile.length});
        const {f, store, picked: isPick} = toFile[i];
        const r = await fileFormAction({company, uploadIds: f.uploadIds, storeCode: store, periodStart: f.periodStart ?? '', periodEnd: f.periodEnd ?? '', picked: isPick}).catch(() => ({
          ok: false as const,
          error: 'Could not reach the server.',
        }));
        if (!r.ok) {
          const row: Row = {batchId: `file:${f.key}`, storeCode: store, periodStart: f.periodStart ?? '', periodEnd: f.periodEnd ?? '', pages: f.uploadIds.length, rows: 0, verdict: {state: 'blocked', reason: r.error}, label: storeNames[store] ?? `Store ${store}`, draft: false};
          shown.push(row);
          out.push({batchId: row.batchId, ok: false, committed: 0, error: r.error});
        }
      }
      setStep(null);
      // 2. Re-read the upload: the forms that now have a store join the queue.
      const before = new Map(rows.map((r) => [r.batchId, r]));
      const again = await planCommitAllAction({company, batchIds: [], dropId}).catch(() => null);
      for (const f of again && again.ok ? again.forms : []) {
        const prev = before.get(f.batchId);
        if (prev && !(prev.verdict.state === 'blocked' && prev.storeCode !== f.storeCode)) continue; // not one we just gave a store
        const row: Row = {...f, label: storeNames[f.storeCode] ?? `Store ${f.storeCode}`, draft: hasDraft(f.batchId)};
        shown.push(row);
        if (!row.draft && (f.verdict.state === 'ready' || (f.verdict.state === 'flagged' && includeFlagged))) todo.push(row);
        else out.push({batchId: f.batchId, ok: false, committed: 0, error: f.verdict.state === 'blocked' ? f.verdict.reason : row.draft ? 'Has edits saved in this browser.' : 'Has unchecked rows. Open it to check them.'});
      }
    }
    setQueue(shown);
    setResults([...out]);
    for (const f of todo) {
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
    // Leave a receipt on the page once the dialog is gone.
    if (phase === 'done' && okCount > 0) {
      push({
        kind: 'ok',
        text: `Committed ${okCount} ${okCount === 1 ? 'form' : 'forms'} · ${okRows.toLocaleString('en-US')} rows. Inventory and Reconcile have them now.`,
        action: {label: 'Open Reconcile', onClick: () => router.push(reconcileHref)},
      });
    }
  };
  // Reconcile opens on the month most of the committed forms count.
  const committedForms = queue.filter((g) => results.some((r) => r.ok && r.batchId === g.batchId));
  const months = committedForms.map((f) => f.periodStart.slice(0, 7)).filter(Boolean);
  const topMonth = months.sort((a, b) => months.filter((m) => m === b).length - months.filter((m) => m === a).length)[0];
  const reconcileHref = topMonth ? `/stock/audit?month=${topMonth}` : '/stock/audit';

  return (
    <>
    <ToastStack toasts={toasts} dismiss={dismiss} />
    <AlertDialog.Root open={open} onOpenChange={(o) => (o ? setOpen(true) : close())}>
      {forms.length + needsStore.length > 0 && (
        <AlertDialog.Trigger
          render={
            <Button size="sm" className="shrink-0 gap-1.5 transition-transform duration-150 ease-out active:scale-[0.97]">
              <CheckCheck className="size-4" /> Commit all
            </Button>
          }
        />
      )}
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
                    {Array.isArray(plan) ? `Commit ${total} ${total === 1 ? 'form' : 'forms'}?` : 'Commit all forms?'}
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
                        <li className="mb-1 list-none">
                        <label className="flex cursor-pointer items-start gap-2.5 rounded-xl border px-3 py-2.5 text-sm transition-colors duration-150 [@media(hover:hover)]:hover:bg-muted/60" style={includeFlagged ? {borderColor: tint('warn', 55), background: tint('warn', 8)} : undefined}>
                          <input type="checkbox" checked={includeFlagged} onChange={(e) => setIncludeFlagged(e.target.checked)} className="mt-0.5 size-4 accent-[var(--status-warn)]" />
                          <span>
                            Also commit these {flagged.length} {flagged.length === 1 ? 'form' : 'forms'} without checking their <strong className="tabular-nums">{flaggedRows}</strong> low-confidence rows
                            <span className="block text-xs text-muted-foreground">Untick to leave them for review on their own page.</span>
                          </span>
                        </label>
                        </li>
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

                    {strays.length > 0 && (
                      <Section title="Sorted into store forms on commit" count={strays.length} tone="good">
                        <li className="mb-1 list-none text-xs text-muted-foreground">Their store was read but their pages never became a store form (often a lone page). Coop files each under its store first.</li>
                        {strays.map((f) => (
                          <li key={f.key} className="grid grid-cols-[1.5rem_minmax(0,1fr)] items-start gap-x-2.5 rounded-xl px-2 py-2">
                            <span className="mt-0.5 grid size-6 place-items-center rounded-full" style={{background: tint('good', 14), color: ink('good')}}>
                              <Check className="size-3.5" />
                            </span>
                            <span className="flex min-w-0 flex-col">
                              <span className="flex min-w-0 items-baseline gap-2">
                                <span className="truncate text-sm font-medium">{(f.storeCode && storeNames[f.storeCode]) || f.storeName}</span>
                                <span className="shrink-0 font-mono text-xs text-muted-foreground">{f.storeCode}</span>
                              </span>
                              <span className="text-xs text-muted-foreground">
                                {fmtTriagePeriod(f.periodStart, f.periodEnd)} · {f.uploadIds.length} {f.uploadIds.length === 1 ? 'page' : 'pages'}
                                {f.flags.includes('year-reconciled') && ' · year corrected from the misread'}
                              </span>
                            </span>
                          </li>
                        ))}
                      </Section>
                    )}

                    {needsStore.length > 0 && (
                      <Section title="Needs a store" count={needsStore.length} tone="crit">
                        <li className="mb-1 list-none text-xs text-muted-foreground">
                          Pick each form&apos;s store and it commits with the rest, or set a page aside when it has nothing to file (a nearly blank sheet). Left empty, the form stays for later.
                          {Object.keys(suggested).length > 0 && ' Suggestions come from the store name read off the form, so check them.'}
                        </li>
                        {needsStore.map((f) => (
                          <li key={f.key} className="flex flex-col gap-2 rounded-xl border border-border px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between">
                            <span className="flex min-w-0 flex-col">
                              <span className="truncate text-sm font-medium" title={f.storeName ?? undefined}>
                                {f.storeName ?? 'Store not readable'}
                                {f.storeCode && <span className="ml-1.5 font-mono text-xs font-normal text-muted-foreground">read {f.storeCode}</span>}
                              </span>
                              <span className="text-xs text-muted-foreground">
                                {f.periodStart ? fmtTriagePeriod(f.periodStart, f.periodEnd) : 'No date read either'} · {f.uploadIds.length} {f.uploadIds.length === 1 ? 'page' : 'pages'}
                              </span>
                            </span>
                            <span className="flex shrink-0 items-center gap-1.5">
                              {aside.has(f.key) ? (
                                <span className="inline-flex h-9 items-center rounded-lg bg-muted px-3 text-sm text-muted-foreground sm:w-64">Set aside on commit</span>
                              ) : f.periodStart ? (
                                <StoreSelect
                                  stores={stores}
                                  value={picks[f.key] ?? ''}
                                  suggested={suggested[f.key] === picks[f.key] && Boolean(picks[f.key])}
                                  onChange={(code) => setPicks((p) => ({...p, [f.key]: code}))}
                                />
                              ) : null}
                              <button
                                type="button"
                                aria-pressed={aside.has(f.key)}
                                onClick={() =>
                                  setAside((prev) => {
                                    const next = new Set(prev);
                                    if (next.has(f.key)) next.delete(f.key);
                                    else next.add(f.key);
                                    return next;
                                  })
                                }
                                className="h-9 shrink-0 rounded-lg px-2.5 text-xs font-medium text-muted-foreground transition-[background-color,color,transform] duration-150 ease-out hover:bg-muted hover:text-foreground active:scale-[0.97]"
                              >
                                {aside.has(f.key) ? 'Undo' : 'Set aside'}
                              </button>
                            </span>
                          </li>
                        ))}
                      </Section>
                    )}

                    {needsDate.length > 0 && (
                      <Section title="Needs a date" count={needsDate.length} tone={null}>
                        {needsDate.map((f) => (
                          <li key={f.key} className="grid grid-cols-[1.5rem_minmax(0,1fr)] items-start gap-x-2.5 rounded-xl px-2 py-2">
                            <span className="mt-0.5 grid size-6 place-items-center rounded-full text-muted-foreground">
                              <CircleSlash className="size-3.5" />
                            </span>
                            <span className="flex min-w-0 flex-col">
                              <span className="flex min-w-0 items-baseline gap-2">
                                <span className="truncate text-sm font-medium">{(f.storeCode && storeNames[f.storeCode]) || f.storeName}</span>
                                <span className="shrink-0 font-mono text-xs text-muted-foreground">{f.storeCode}</span>
                              </span>
                              <span className="text-xs text-muted-foreground">No date was read off it. Open it from the board to set the period.</span>
                            </span>
                          </li>
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

                    {rows.length === 0 && needsStore.length === 0 && strays.length === 0 && <p className="py-6 text-sm text-muted-foreground">No forms in this upload are waiting to be committed.</p>}
                    {notListed > 0 && (
                      <p className="text-xs text-muted-foreground">
                        {notListed} more {notListed === 1 ? 'form isn’t' : 'forms aren’t'} listed: {notListed === 1 ? 'its' : 'their'} pages are mixed with another form. Open {notListed === 1 ? 'it' : 'those'} from the board.
                      </p>
                    )}
                  </>
                )}
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3 border-t px-6 py-4">
                <p className="text-xs text-muted-foreground tabular-nums">
                  {total > 0 ? `${total} ${total === 1 ? 'form' : 'forms'} across ${storeCount} ${storeCount === 1 ? 'store' : 'stores'}${picked.length || strays.length ? '' : ` · ${goingRows.toLocaleString('en-US')} rows`}` : ''}
                </p>
                <div className="flex gap-2">
                  <AlertDialog.Close render={<Button variant="ghost" />}>Cancel</AlertDialog.Close>
                  <Button onClick={commit} disabled={total === 0} className="gap-1.5 transition-transform duration-150 ease-out active:scale-[0.97]">
                    <CheckCheck className="size-4" /> Commit {total} {total === 1 ? 'form' : 'forms'}
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
                    {step
                      ? `Sorting into store forms · ${step.at} of ${step.of}`
                      : phase === 'committing'
                        ? `Committing form ${Math.min(done + 1, Math.max(queue.length, 1))} of ${Math.max(queue.length, total)}`
                        : `Committed ${okCount} of ${queue.length} ${queue.length === 1 ? 'form' : 'forms'}`}
                  </AlertDialog.Title>
                  <p className="text-sm text-muted-foreground tabular-nums" aria-live="polite">
                    {okRows.toLocaleString('en-US')} rows written{phase === 'committing' ? ' so far' : ''}
                  </p>
                </div>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                <div className="h-full rounded-full bg-[var(--status-good)] transition-[width] duration-300 ease-out" style={{width: `${queue.length ? (done / queue.length) * 100 : 0}%`}} />
              </div>
              {results.some((r) => !r.ok) && (
                <ul className="flex max-h-48 flex-col gap-1.5 overflow-y-auto text-sm">
                  {results
                    .filter((r) => !r.ok)
                    .map((r) => {
                      const f = queue.find((g) => g.batchId === r.batchId);
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
              {/* The receipt: every form that went in, so it's plain what was committed. */}
              {committedForms.length > 0 && (
                <ul className="flex max-h-56 flex-col gap-0.5 overflow-y-auto">
                  {committedForms.map((f) => (
                    <li key={f.batchId} className="grid grid-cols-[1.5rem_minmax(0,1fr)_auto] items-center gap-x-2.5 rounded-lg px-2 py-1.5 transition-opacity duration-200 ease-out starting:opacity-0">
                      <span className="grid size-5 place-items-center rounded-full" style={{background: tint('good', 16), color: ink('good')}}>
                        <Check className="size-3" aria-hidden />
                      </span>
                      <span className="min-w-0 truncate text-sm">
                        <span className="font-medium">{f.label}</span> <span className="text-muted-foreground">{fmtTriagePeriod(f.periodStart, f.periodEnd)}</span>
                      </span>
                      <span className="text-xs text-muted-foreground tabular-nums">{(results.find((r) => r.batchId === f.batchId)?.committed ?? 0).toLocaleString('en-US')} rows</span>
                    </li>
                  ))}
                </ul>
              )}
              {phase === 'done' && (
                <div className="flex flex-wrap justify-end gap-2">
                  {okCount > 0 && (
                    <Button
                      variant="outline"
                      className="gap-1.5 transition-transform duration-150 ease-out active:scale-[0.97]"
                      onClick={() => {
                        setOpen(false);
                        router.push(reconcileHref);
                      }}
                    >
                      Open Reconcile <ArrowRight className="size-4" />
                    </Button>
                  )}
                  <AlertDialog.Close render={<Button />}>Done</AlertDialog.Close>
                </div>
              )}
            </div>
          )}
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
    </>
  );
}

/** A compact store search for one form: the registry by name or code, with a clear. */
function StoreSelect({stores, value, suggested, onChange}: {stores: StoreOption[]; value: string; suggested: boolean; onChange: (code: string) => void}) {
  const selected = stores.find((s) => s.code === value) ?? null;
  return (
    <Combobox.Root<StoreOption>
      items={stores}
      value={selected}
      onValueChange={(v) => onChange(v?.code ?? '')}
      itemToStringLabel={(s) => `${s.name} · ${s.code}`}
      isItemEqualToValue={(a, b) => a.code === b.code}
      filter={(s, q) => {
        const h = `${s.code} ${s.name}`.toLowerCase();
        return q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => h.includes(w));
      }}
      autoHighlight
    >
      <div className="relative w-full shrink-0 sm:w-64">
        <MapPin aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Combobox.Input
          aria-label="Store for this form"
          placeholder="Pick a store"
          className={cn(
            'h-9 w-full truncate rounded-lg border bg-background pl-8 text-sm outline-none transition-[border-color,box-shadow] duration-150 placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40',
            value ? 'border-border' : 'border-dashed border-border',
            suggested ? 'pr-[6.25rem]' : 'pr-10',
          )}
        />
        <div className="absolute top-1/2 right-1 flex -translate-y-1/2 items-center">
          {suggested && <span className="mr-0.5 rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">Suggested</span>}
          {value ? (
            <Combobox.Clear aria-label="Leave this form for later" className="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
              <X className="size-3.5" />
            </Combobox.Clear>
          ) : (
            <Combobox.Trigger aria-label="Show stores" className="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
              <ChevronsUpDown className="size-3.5" />
            </Combobox.Trigger>
          )}
        </div>
      </div>
      <Combobox.Portal>
        <Combobox.Positioner sideOffset={6} align="end" className="z-[60] outline-none">
          <Combobox.Popup className="flex max-h-[min(18rem,var(--available-height))] w-[max(var(--anchor-width),18rem)] max-w-[calc(100vw-2rem)] origin-[var(--transform-origin)] flex-col overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-lg outline-none transition-[opacity,transform] duration-150 ease-out data-[ending-style]:scale-[0.98] data-[ending-style]:opacity-0 data-[starting-style]:scale-[0.98] data-[starting-style]:opacity-0">
            <Combobox.Empty className="px-4 py-5 text-center text-sm text-muted-foreground empty:hidden">No store matches. Try the code.</Combobox.Empty>
            <Combobox.List className="flex flex-col overflow-y-auto overscroll-contain p-1.5 outline-none data-[empty]:p-0">
              {(st: StoreOption) => (
                <Combobox.Item
                  key={st.code}
                  value={st}
                  className="grid cursor-default grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 rounded-lg px-2.5 py-1.5 text-sm outline-none select-none data-[highlighted]:bg-muted"
                >
                  <span className="truncate">{st.name}</span>
                  <span className="font-mono text-xs text-muted-foreground tabular-nums">{st.code}</span>
                </Combobox.Item>
              )}
            </Combobox.List>
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
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
