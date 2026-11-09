'use client';

import Link from 'next/link';
import {useMemo, useState, useTransition} from 'react';
import {useRouter} from 'next/navigation';
import {AlertDialog} from '@base-ui/react/alert-dialog';
import {AlertTriangle, Check, Loader2, MapPin, Pencil, Search, Store, User} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {Card, CardContent} from '@/components/ui/card';
import {cn} from '@/lib/utils';
import {toneText} from '@/src/review-confidence';
import {GL_PAGE} from '@/src/goldline-ui';
import type {StoreOption} from '@/src/goldline-data';
import type {TriageForm, TriageResult} from '@/src/goldline-triage-data';
import {fmtTriagePeriod, FLAG_LABEL, flagTone, VERSION_LABEL} from '@/src/goldline-triage-format';
import {assignFormStoreAction} from '@/app/uploads/actions';

const INVENTORY_PAGES = [1, 2, 3, 4, 5];
const TONE_VAR = {good: 'var(--status-good)', warn: 'var(--status-warn)', crit: 'var(--status-crit)', info: 'var(--primary)'} as const;
type Tone = keyof typeof TONE_VAR;

function tint(tone: Tone) {
  return {color: toneText(TONE_VAR[tone]), background: `color-mix(in oklab, ${TONE_VAR[tone]} 14%, transparent)`};
}

/**
 * One form's state, as the inbox reads it. Order (rank) and colour agree: the hard
 * blocker (no store, can't file at all) is most urgent, then missing pages, then ready,
 * then already committed. A store the OCR couldn't read — or read as a code not in the
 * registry — is the thing a human must resolve, so it sorts to the very top.
 */
type FormStatus = {rank: number; tone: Tone; label: string};
function statusOf(f: TriageForm): FormStatus {
  if (f.committed > 0 && f.needsReview === 0) return {rank: 3, tone: 'good', label: 'Committed'};
  if (!f.storeCode || f.flags.includes('store-unmatched')) return {rank: 0, tone: 'crit', label: 'Needs a store'};
  if (f.missing.length > 0) return {rank: 1, tone: 'warn', label: `Missing ${f.missing.length === 1 ? 'page' : 'pages'} ${f.missing.join(', ')}`};
  return {rank: 2, tone: 'good', label: 'Ready'};
}

/** A single store-form card: a status stripe, the store it belongs to, its period and BA,
 *  which of pages 1 to 5 came through, and one clear state. Click opens it to review. */
/** The shared inner of a form card: store line, period, BA, page coverage, version/flags.
 *  The wrapper (a Link to review, or the needs-a-store picker) is chosen by FormCard. */
function CardBody({form, s}: {form: TriageForm; s: FormStatus}) {
  const dupPages = new Set(form.duplicates.map((d) => d.page));
  const unreadable = !form.storeCode;
  const extraFlags = form.flags.filter((fl) => fl !== 'unknown-store' && fl !== 'store-unmatched' && fl !== 'incomplete');
  return (
    <>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className={cn('truncate font-heading text-[15px] font-semibold tracking-tight', unreadable && 'text-[color:var(--status-crit)]')}>
            {form.storeName ?? (form.storeCode ? `Store ${form.storeCode}` : 'Store not readable')}
            {form.storeName && form.storeCode ? <span className="font-mono text-xs font-normal text-muted-foreground"> · {form.storeCode}</span> : null}
          </div>
          <div className="mt-1 truncate font-mono text-[11.5px] text-muted-foreground tabular-nums">{fmtTriagePeriod(form.periodStart, form.periodEnd)}</div>
        </div>
        <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-semibold" style={tint(s.tone)}>
          <span aria-hidden className="size-1.5 rounded-full" style={{background: TONE_VAR[s.tone]}} />
          {s.label}
        </span>
      </div>

      {form.consultant ? (
        <div className="flex items-center gap-1.5 truncate text-xs text-muted-foreground">
          <User className="size-3 shrink-0 opacity-70" /> {form.consultant}
        </div>
      ) : null}

      {/* Page coverage: 5 cells, filled = present, dashed = missing, ring = duplicate. */}
      <div className="flex items-center gap-1.5" aria-label="Page coverage">
        {INVENTORY_PAGES.map((p) => {
          const present = form.present.includes(p);
          const dup = dupPages.has(p);
          return (
            <span
              key={p}
              title={`Page ${p}${dup ? ' (duplicate)' : present ? '' : ' (missing)'}`}
              className="flex h-7 min-w-0 flex-1 items-center justify-center rounded-md font-mono text-[11px] font-medium tabular-nums"
              style={
                dup
                  ? {...tint('crit'), boxShadow: `inset 0 0 0 1.5px ${TONE_VAR.crit}`}
                  : present
                    ? {background: 'color-mix(in oklab, var(--status-good) 16%, transparent)', color: toneText(TONE_VAR.good)}
                    : {color: 'var(--muted-foreground)', boxShadow: 'inset 0 0 0 1px var(--border)', opacity: 0.6}
              }
            >
              {p}
            </span>
          );
        })}
      </div>

      {(VERSION_LABEL[form.version] || extraFlags.length > 0) && (
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span className="rounded-full bg-muted px-2 py-0.5 text-[10.5px] font-medium text-muted-foreground">{VERSION_LABEL[form.version]}</span>
          {extraFlags.map((fl) => (
            <span key={fl} className="inline-flex items-center rounded-full px-2 py-0.5 text-[10.5px] font-medium" style={tint(flagTone(fl))}>
              {FLAG_LABEL[fl] ?? fl}
            </span>
          ))}
        </div>
      )}
    </>
  );
}

/** The single-tap store picker for a "needs a store" form: search the registry and pick;
 *  the chosen store is stamped onto the form's pages so it leaves "needs a store". */
function StorePicker({company, form, stores}: {company: string; form: TriageForm; stores: StoreOption[]}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const matches = useMemo(() => {
    const t = q.trim().toLowerCase();
    return stores.filter((s) => !t || s.code.toLowerCase().includes(t) || s.name.toLowerCase().includes(t)).slice(0, 8);
  }, [q, stores]);
  const pick = (code: string) =>
    start(async () => {
      setErr(null);
      const res = await assignFormStoreAction({company, uploadIds: form.uploadIds, storeCode: code});
      if (res.ok) {
        setOpen(false);
        router.refresh();
      } else setErr(res.error);
    });

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="group inline-flex items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-semibold transition-[transform,box-shadow,border-color] duration-150 ease-out hover:-translate-y-0.5 hover:border-[color:var(--status-crit)] hover:shadow-md active:translate-y-0 active:scale-[0.99] focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-[color:var(--status-crit)]/35 motion-reduce:transition-none motion-reduce:hover:translate-y-0"
        style={{...tint('crit'), borderColor: 'color-mix(in oklab, var(--status-crit) 28%, transparent)'}}
      >
        <MapPin className="size-3.5 transition-transform duration-150 ease-out group-hover:-rotate-6 motion-reduce:transition-none" /> Confirm store
      </button>
    );
  }
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-background p-2.5">
      <div className="flex items-center gap-2 rounded-md border border-border px-2">
        <Search className="size-3.5 shrink-0 text-muted-foreground" />
        {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search store by name or code…"
          className="h-8 w-full bg-transparent text-sm outline-none"
        />
      </div>
      <div className="flex max-h-44 flex-col gap-0.5 overflow-y-auto">
        {matches.length === 0 ? (
          <span className="px-2 py-1.5 text-xs text-muted-foreground">No store matches that.</span>
        ) : (
          matches.map((st) => (
            <button
              key={st.code}
              type="button"
              disabled={pending}
              onClick={() => pick(st.code)}
              className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted disabled:opacity-60"
            >
              <span className="min-w-0 truncate">
                {st.name} <span className="font-mono text-xs text-muted-foreground">· {st.code}</span>
              </span>
              {pending ? <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" /> : <Check className="size-3.5 shrink-0 text-muted-foreground opacity-0" />}
            </button>
          ))
        )}
      </div>
      {err && <span className="px-1 text-xs text-[color:var(--status-crit)]">{err}</span>}
      <button type="button" onClick={() => setOpen(false)} className="self-start px-1 text-xs text-muted-foreground hover:text-foreground">
        Cancel
      </button>
    </div>
  );
}

/** Rough check: the read store name shares no meaningful word with the chosen store, so
 *  it's probably a different store wrongly grouped under the same code (e.g. "SM Sta Maria"
 *  read under code 5300 = "DS STA ROSA 2"). Used only to hint, never to decide. */
function looksDifferent(readName: string | null, storeName: string): boolean {
  const words = (s: string) => new Set((s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length >= 3));
  const a = words(readName ?? '');
  if (a.size === 0) return false;
  const b = words(storeName);
  for (const w of a) if (b.has(w)) return false;
  return true;
}

/** Confirm or change the store for a whole group at once. Coop suggests the registry store
 *  for the group's code; the user keeps it or picks another and ticks which forms to point
 *  at it — so a wrongly-grouped form (a different store read under the same code) can be
 *  left out instead of mis-stamped. Reuses the per-form assign action, applied in bulk. */
function GroupStoreDialog({company, group, stores, onClose}: {company: string; group: {code: string; name: string | null; forms: TriageForm[]}; stores: StoreOption[]; onClose: () => void}) {
  const router = useRouter();
  const [q, setQ] = useState('');
  const suggested = useMemo(() => stores.find((s) => s.code === group.code) ?? null, [stores, group.code]);
  const [picked, setPicked] = useState<StoreOption | null>(suggested);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(group.forms.map((f) => f.key)));
  const [pending, setPending] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const matches = useMemo(() => {
    const t = q.trim().toLowerCase();
    return stores.filter((s) => !t || s.code.toLowerCase().includes(t) || s.name.toLowerCase().includes(t)).slice(0, 6);
  }, [q, stores]);
  const toggle = (key: string) =>
    setSelected((s) => {
      const n = new Set(s);
      n.has(key) ? n.delete(key) : n.add(key);
      return n;
    });
  async function apply() {
    if (!picked) return setErr('Pick a store first.');
    const forms = group.forms.filter((f) => selected.has(f.key));
    if (!forms.length) return setErr('Tick at least one form.');
    setPending(true);
    setErr(null);
    const results = await Promise.all(forms.map((f) => assignFormStoreAction({company, uploadIds: f.uploadIds, storeCode: picked.code})));
    setPending(false);
    const bad = results.find((r) => !r.ok);
    if (bad && !bad.ok) return setErr(bad.error);
    onClose();
    router.refresh();
  }

  return (
    <AlertDialog.Root open onOpenChange={(o) => (o ? null : onClose())}>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="fixed inset-0 z-50 bg-black/45 transition-opacity duration-150 ease-out data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
        <AlertDialog.Popup className="fixed top-1/2 left-1/2 z-50 flex w-[min(32rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 rounded-xl border border-border bg-popover p-5 text-popover-foreground shadow-xl outline-none transition-[opacity,transform] duration-150 ease-out data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0">
          <div className="flex items-start gap-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-full bg-primary/10 text-primary">
              <Store className="size-4" aria-hidden />
            </span>
            <div className="flex min-w-0 flex-col gap-0.5">
              <AlertDialog.Title className="font-heading text-base font-semibold">Confirm the store for this group</AlertDialog.Title>
              <AlertDialog.Description className="text-sm text-muted-foreground">
                Point the ticked forms to one store. Coop suggests the registry match for code {group.code}.
              </AlertDialog.Description>
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2 rounded-md border border-border px-2">
              <Search className="size-3.5 shrink-0 text-muted-foreground" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search store by name or code…" className="h-8 w-full bg-transparent text-sm outline-none" />
            </div>
            <div className="flex max-h-32 flex-col gap-0.5 overflow-y-auto">
              {matches.length === 0 ? (
                <span className="px-2 py-1.5 text-xs text-muted-foreground">No store matches that.</span>
              ) : (
                matches.map((st) => {
                  const on = picked?.code === st.code;
                  return (
                    <button
                      key={st.code}
                      type="button"
                      onClick={() => setPicked(st)}
                      className={cn('flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors', on ? 'bg-primary/10' : 'hover:bg-muted')}
                    >
                      <span className="min-w-0 truncate">
                        {st.name} <span className="font-mono text-xs text-muted-foreground">· {st.code}</span>
                        {suggested?.code === st.code && <span className="ml-1.5 rounded bg-muted px-1 py-0.5 text-[10px] font-medium text-muted-foreground">suggested</span>}
                      </span>
                      {on && <Check className="size-3.5 shrink-0 text-primary" />}
                    </button>
                  );
                })
              )}
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">Apply to these forms</span>
            <ul className="flex max-h-44 flex-col divide-y divide-border overflow-y-auto rounded-lg border border-border">
              {group.forms.map((f) => {
                const on = selected.has(f.key);
                const diff = picked ? looksDifferent(f.storeName, picked.name) : false;
                return (
                  <li key={f.key}>
                    <button type="button" onClick={() => toggle(f.key)} className="flex w-full items-center gap-2.5 px-2.5 py-2 text-left transition-colors hover:bg-muted/50">
                      <span className={cn('grid size-4 shrink-0 place-items-center rounded border', on ? 'border-primary bg-primary text-primary-foreground' : 'border-border')}>
                        {on && <Check className="size-3" />}
                      </span>
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-sm">{f.storeName ?? (f.storeCode ? `Store ${f.storeCode}` : 'Store not readable')}</span>
                        <span className="truncate font-mono text-[11px] text-muted-foreground tabular-nums">
                          {fmtTriagePeriod(f.periodStart, f.periodEnd)}{f.consultant ? ` · ${f.consultant}` : ''}
                        </span>
                      </span>
                      {diff && (
                        <span className="inline-flex shrink-0 items-center gap-1 text-[11px]" style={{color: toneText('var(--status-warn)')}}>
                          <AlertTriangle className="size-3" /> looks different
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>

          {err && <span role="alert" className="text-xs text-[color:var(--status-crit)]">{err}</span>}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="min-w-0 truncate text-xs text-muted-foreground">
              {picked ? <>Pointing to <span className="font-medium text-foreground">{picked.name}</span></> : 'Pick a store'}
            </span>
            <div className="flex gap-2">
              <AlertDialog.Close render={<Button variant="ghost" size="sm" />}>Cancel</AlertDialog.Close>
              <Button size="sm" onClick={apply} disabled={pending || !picked || selected.size === 0}>
                {pending ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
                Apply to {selected.size} {selected.size === 1 ? 'form' : 'forms'}
              </Button>
            </div>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

function FormCard({form, stores, canEdit, company}: {form: TriageForm; stores: StoreOption[]; canEdit: boolean; company: string}) {
  const s = statusOf(form);
  const needsStore = s.rank === 0;
  const href = form.batchId ? `/uploads/batch/${form.batchId}` : form.uploadIds[0] ? `/uploads/${form.uploadIds[0]}` : '#';

  // A "needs a store" form the user can fix gets the inline picker (not a link), so the
  // whole form is filed with one tap instead of opening the batch to type a store.
  if (needsStore && canEdit && stores.length > 0) {
    return (
      <div className="flex flex-col gap-3.5 rounded-xl border border-border bg-card p-4 shadow-sm">
        <CardBody form={form} s={s} />
        <StorePicker company={company} form={form} stores={stores} />
      </div>
    );
  }
  return (
    <Link
      href={href}
      className="group flex flex-col gap-3.5 rounded-xl border border-border bg-card p-4 shadow-sm transition-all hover:-translate-y-0.5 hover:border-foreground/20 hover:shadow-md focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/40"
    >
      <CardBody form={form} s={s} />
      <span className="self-end whitespace-nowrap text-[11px] font-medium text-[color:var(--primary)] opacity-0 transition-opacity group-hover:opacity-100">Review →</span>
    </Link>
  );
}

export function TriageBoard({
  data,
  company,
  scan,
  stores = [],
  canEdit = false,
  embedded = false,
}: {
  data: TriageResult;
  company: string;
  scan?: string;
  stores?: StoreOption[];
  canEdit?: boolean;
  embedded?: boolean;
}) {
  const {needsStore, groups, singles, counts, storeCount, n} = useMemo(() => {
    const withStatus = data.forms.map((f) => ({f, s: statusOf(f)}));
    const counts = {ready: 0, needsStore: 0, incomplete: 0, committed: 0};
    for (const {s} of withStatus) {
      if (s.rank === 0) counts.needsStore++;
      else if (s.rank === 1) counts.incomplete++;
      else if (s.rank === 2) counts.ready++;
      else counts.committed++;
    }

    // A form with no readable store can't be grouped (it isn't a store yet) and is the most
    // urgent thing, so those stay as individual cards up top. Everything else groups by
    // store code — same code is the same store, so a store's periods sit together instead
    // of scattering as look-alike tiles. Different codes stay apart (different branches).
    const byPeriodDesc = (a: {f: TriageForm}, b: {f: TriageForm}) => (b.f.periodStart ?? '').localeCompare(a.f.periodStart ?? '');
    const needsStore = withStatus.filter((w) => w.s.rank === 0).sort(byPeriodDesc).map((w) => w.f);

    const byStore = new Map<string, Array<{f: TriageForm; s: FormStatus}>>();
    for (const w of withStatus) {
      if (w.s.rank === 0 || !w.f.storeCode) continue;
      const list = byStore.get(w.f.storeCode) ?? [];
      list.push(w);
      byStore.set(w.f.storeCode, list);
    }
    const all = [...byStore.entries()].map(([code, items]) => {
      items.sort(byPeriodDesc);
      return {
        code,
        name: items.find((i) => i.f.storeName)?.f.storeName ?? null,
        forms: items.map((i) => i.f),
        minRank: Math.min(...items.map((i) => i.s.rank)),
        latest: items[0].f.periodStart ?? '',
      };
    });
    // Stores that need you (lowest rank) first, then most-recent activity, then code.
    const order = (a: (typeof all)[number], b: (typeof all)[number]) =>
      a.minRank - b.minRank || b.latest.localeCompare(a.latest) || a.code.localeCompare(b.code, undefined, {numeric: true});
    const groups = all.filter((g) => g.forms.length > 1).sort(order);
    const singles = all
      .filter((g) => g.forms.length === 1)
      .sort(order)
      .map((g) => g.forms[0]);

    const storeCount = byStore.size;
    return {needsStore, groups, singles, counts, storeCount, n: withStatus.length};
  }, [data.forms]);

  // The registry's canonical name for a code, so a group reads by its real store name
  // (e.g. "DS STA ROSA 2") instead of whatever one form's scan happened to say.
  const storeByCode = useMemo(() => new Map(stores.map((s) => [s.code, s.name])), [stores]);
  const [editGroup, setEditGroup] = useState<{code: string; name: string | null; forms: TriageForm[]} | null>(null);

  // One jump-and-filter pill per section, in the same order they appear below, so the whole
  // scan's stores read at a glance and a deep-down store is one tap away instead of a long
  // scroll. Keys: 'needs-store', a store code, or 'singles'.
  const [storeFilter, setStoreFilter] = useState<string | null>(null);
  const sections = useMemo(() => {
    const list: Array<{key: string; label: string; count: number; tone?: Tone}> = [];
    if (needsStore.length > 0) list.push({key: 'needs-store', label: 'Needs a store', count: needsStore.length, tone: 'crit'});
    for (const g of groups) list.push({key: g.code, label: storeByCode.get(g.code) ?? g.name ?? `Store ${g.code}`, count: g.forms.length});
    if (singles.length > 0) list.push({key: 'singles', label: 'One-off stores', count: singles.length});
    return list;
  }, [needsStore, groups, singles, storeByCode]);
  // Ignore a filter whose section no longer exists (data changed under it) so nothing blanks out.
  const activeFilter = storeFilter && sections.some((s) => s.key === storeFilter) ? storeFilter : null;

  const t = data.totals;

  const summaryLine =
    n > 0 ? (
      <p className="text-[15px] text-muted-foreground">
        <span className="font-semibold text-foreground">{n}</span> {n === 1 ? 'form' : 'forms'} across{' '}
        <span className="font-semibold text-foreground">{storeCount}</span> {storeCount === 1 ? 'store' : 'stores'}
        {scan ? ' in this scan, sorted so the ones that need you come first.' : ', sorted so the ones that need you come first.'}
      </p>
    ) : (
      <p className="text-sm text-muted-foreground">
        {scan ? 'No store forms in this scan yet. Its pages may still be reading, or they were sales sheets and blanks.' : 'Uploaded pages, sorted into store forms. Open a card to review and commit its counts.'}
      </p>
    );
  const pills = n > 0 && (
    <div className="flex flex-wrap items-center gap-2">
      {counts.needsStore > 0 && <StatBadge tone="crit" n={counts.needsStore} label="need a store" />}
      {counts.incomplete > 0 && <StatBadge tone="warn" n={counts.incomplete} label="incomplete" />}
      {counts.ready > 0 && <StatBadge tone="good" n={counts.ready} label="ready" />}
      {counts.committed > 0 && <StatBadge tone="good" muted n={counts.committed} label="committed" />}
      {t.sales > 0 && <span className="text-xs text-muted-foreground">· {t.sales} sales {t.sales === 1 ? 'sheet' : 'sheets'} set aside</span>}
      {t.unplaceable > 0 && <span className="text-xs text-[color:var(--status-warn)]">· {t.unplaceable} to place by hand</span>}
    </div>
  );

  return (
    <div className={embedded ? 'flex flex-col gap-6' : GL_PAGE}>
      {embedded ? (
        <div className="flex flex-col gap-3">
          {summaryLine}
          {pills}
        </div>
      ) : (
        <header className="flex flex-col gap-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h1 className="font-heading text-xl font-semibold tracking-tight">{scan ? 'Forms in this scan' : 'All forms'}</h1>
              <div className="mt-1">{summaryLine}</div>
            </div>
            <Link
              href="/uploads"
              className="h-9 shrink-0 rounded-md border border-border bg-background px-3 text-sm leading-9 transition-colors hover:border-foreground/25"
            >
              All uploads
            </Link>
          </div>
          {pills}
        </header>
      )}

      {data.mock && (
        <div className="rounded-lg border border-dashed border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          Sample view. These are example forms from the September scan; connect the database to see real uploads.
        </div>
      )}

      {n === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-1 px-6 py-14 text-center">
            <p className="font-heading text-sm font-semibold">No scanned forms yet</p>
            <p className="max-w-sm text-sm text-muted-foreground">
              Upload an inventory scan from the Uploads page. Each page is read, oriented, and sorted into its store form here.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="flex flex-col gap-7">
          {sections.length > 1 && (
            <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filter forms by store">
              <StorePill active={!activeFilter} onClick={() => setStoreFilter(null)}>
                All <span className="tabular-nums opacity-70">{n}</span>
              </StorePill>
              {sections.map((s) => (
                <StorePill key={s.key} active={activeFilter === s.key} tone={s.tone} onClick={() => setStoreFilter(activeFilter === s.key ? null : s.key)}>
                  <span className="max-w-[12rem] truncate">{s.label}</span>
                  <span className="tabular-nums opacity-70">{s.count}</span>
                </StorePill>
              ))}
            </div>
          )}

          {needsStore.length > 0 && (!activeFilter || activeFilter === 'needs-store') && (
            <section className="flex flex-col gap-3">
              <GroupHeading title="Needs a store" count={needsStore.length} tone="crit" />
              <FormGrid>
                {needsStore.map((f) => (
                  <FormCard key={f.key} form={f} stores={stores} canEdit={canEdit} company={company} />
                ))}
              </FormGrid>
            </section>
          )}

          {groups.map((g) => {
            if (activeFilter && activeFilter !== g.code) return null;
            const registryName = storeByCode.get(g.code);
            return (
              <section key={g.code} className="flex flex-col gap-3">
                <GroupHeading
                  title={registryName ?? g.name ?? `Store ${g.code}`}
                  code={g.code}
                  count={g.forms.length}
                  countLabel="forms"
                  linked={Boolean(registryName)}
                  onEditStore={canEdit && stores.length > 0 ? () => setEditGroup(g) : undefined}
                />
                <FormGrid>
                  {g.forms.map((f) => (
                    <FormCard key={f.key} form={f} stores={stores} canEdit={canEdit} company={company} />
                  ))}
                </FormGrid>
              </section>
            );
          })}

          {singles.length > 0 && (!activeFilter || activeFilter === 'singles') && (
            <section className="flex flex-col gap-3">
              {(activeFilter === 'singles' || needsStore.length > 0 || groups.length > 0) && <GroupHeading title="One-off stores" count={singles.length} />}
              <FormGrid>
                {singles.map((f) => (
                  <FormCard key={f.key} form={f} stores={stores} canEdit={canEdit} company={company} />
                ))}
              </FormGrid>
            </section>
          )}
        </div>
      )}

      {data.parked.length > 0 && (
        <section className="flex flex-col gap-3">
          <div className="flex items-baseline justify-between gap-3 border-b border-border pb-1.5">
            <h2 className="font-heading text-sm font-semibold tracking-tight">Set aside</h2>
            <span className="text-xs text-muted-foreground tabular-nums">{data.parked.length}</span>
          </div>
          <Card>
            <CardContent className="flex flex-col gap-4 py-4">
              {PARKED_GROUPS.map(({kind, label, hint}) => {
                const pages = data.parked
                  .filter((p) => p.kind === kind)
                  .map((p) => ({uploadId: p.uploadId, filename: p.filename, n: parkedPageNo(p.filename)}))
                  .sort((a, b) => (a.n ?? Number.MAX_SAFE_INTEGER) - (b.n ?? Number.MAX_SAFE_INTEGER));
                if (!pages.length) return null;
                return (
                  <div key={kind} className="flex flex-col gap-2">
                    <div className="flex items-baseline gap-2">
                      <span className="text-sm font-medium text-foreground">{label}</span>
                      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
                      <span className="ml-auto text-xs text-muted-foreground tabular-nums">{pages.length}</span>
                    </div>
                    <div className="flex flex-wrap gap-1.5" aria-label={`${label} pages`}>
                      {pages.map((p) => (
                        <span
                          key={p.uploadId}
                          title={p.n ? `Page ${p.n}` : p.filename || 'Scanned page'}
                          aria-label={p.n ? `Page ${p.n}` : p.filename || 'Scanned page'}
                          className="inline-flex min-w-[1.75rem] items-center justify-center rounded-md border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-xs text-muted-foreground tabular-nums"
                        >
                          {p.n ?? '·'}
                        </span>
                      ))}
                    </div>
                  </div>
                );
              })}
            </CardContent>
          </Card>
        </section>
      )}

      {editGroup && <GroupStoreDialog company={company} group={editGroup} stores={stores} onClose={() => setEditGroup(null)} />}
    </div>
  );
}

function FormGrid({children}: {children: React.ReactNode}) {
  // A touch more room between cards (and a little extra vertically between rows) so a dense
  // 4-up grid breathes.
  return <div className="grid grid-cols-1 items-start gap-x-4 gap-y-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">{children}</div>;
}

// The set-aside page (sales sheet, blank back, or a page we couldn't place) grouped by reason,
// so a 98-page scan's tail reads as "14 sales reports, 14 blanks" instead of a wall of near-
// identical filenames (Hick's Law: fewer things to scan). Order is most-expected first.
const PARKED_GROUPS: Array<{kind: 'sales' | 'blank' | 'unplaceable'; label: string; hint?: string}> = [
  {kind: 'sales', label: 'Sales reports', hint: 'out of scope'},
  {kind: 'blank', label: 'Blank pages'},
  {kind: 'unplaceable', label: 'Needs placing'},
];

/** The page number from a split page's filename ("(page 7 of 98)" or "__page_7_of_98__"). */
function parkedPageNo(filename: string): number | null {
  const m = /page[\s_]+(\d+)[\s_]+of/i.exec(filename);
  return m ? Number(m[1]) : null;
}

/** A store (or triage bucket) heading above its cards: the store name once, its code, and
 *  how many forms sit under it — so repeated periods of one store read as one store. */
function GroupHeading({title, code, count, countLabel = 'form', tone, onEditStore, linked}: {title: string; code?: string; count: number; countLabel?: string; tone?: Tone; onEditStore?: () => void; linked?: boolean}) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-border pb-1.5">
      <h3 className="flex min-w-0 items-baseline gap-2">
        <span
          className={cn('truncate font-heading text-sm font-semibold tracking-tight', tone === 'crit' && 'text-[color:var(--status-crit)]')}
        >
          {title}
        </span>
        {code && <span className="shrink-0 font-mono text-xs font-normal text-muted-foreground">· {code}</span>}
      </h3>
      <div className="flex shrink-0 items-center gap-3">
        <span className="text-xs text-muted-foreground tabular-nums">
          {count} {count === 1 ? countLabel.replace(/s$/, '') : countLabel.endsWith('s') ? countLabel : `${countLabel}s`}
        </span>
        {onEditStore &&
          (linked ? (
            <button
              type="button"
              onClick={onEditStore}
              className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <Pencil className="size-3" /> Change store
            </button>
          ) : (
            <button
              type="button"
              onClick={onEditStore}
              className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-semibold transition-colors"
              style={tint('crit')}
            >
              <MapPin className="size-3" /> Confirm store
            </button>
          ))}
      </div>
    </div>
  );
}

/** A jump-and-filter pill for one store section above the board: tapping it shows only that
 *  store's forms, tapping again (or "All") clears. Mirrors the uploader's Show chips so the
 *  two scan views read alike; the "Needs a store" pill is tinted so it reads as urgent. */
function StorePill({active, tone, onClick, children}: {active: boolean; tone?: Tone; onClick: () => void; children: React.ReactNode}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'inline-flex max-w-full items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors',
        tone === 'crit'
          ? active
            ? 'border-[color:var(--status-crit)] bg-[color:var(--status-crit)]/15 text-[color:var(--status-crit)]'
            : 'border-[color:var(--status-crit)]/40 bg-[color:var(--status-crit)]/5 text-[color:var(--status-crit)] hover:bg-[color:var(--status-crit)]/12'
          : active
            ? 'border-primary bg-primary/15 text-foreground'
            : 'border-border bg-background text-muted-foreground hover:border-foreground/30 hover:text-foreground',
      )}
    >
      {children}
    </button>
  );
}

function StatBadge({tone, n, label, muted}: {tone: Tone; n: number; label: string; muted?: boolean}) {
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium"
      style={muted ? {color: 'var(--muted-foreground)', background: 'var(--muted)'} : tint(tone)}
    >
      <span aria-hidden className="size-1.5 rounded-full" style={{background: muted ? 'var(--muted-foreground)' : TONE_VAR[tone]}} />
      <span className="font-semibold tabular-nums">{n}</span> {label}
    </span>
  );
}
