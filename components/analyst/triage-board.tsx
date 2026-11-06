'use client';

import Link from 'next/link';
import {useMemo, useState, useTransition} from 'react';
import {useRouter} from 'next/navigation';
import {Check, Loader2, MapPin, Search, User} from 'lucide-react';
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
          {needsStore.length > 0 && (
            <section className="flex flex-col gap-3">
              <GroupHeading title="Needs a store" count={needsStore.length} tone="crit" />
              <FormGrid>
                {needsStore.map((f) => (
                  <FormCard key={f.key} form={f} stores={stores} canEdit={canEdit} company={company} />
                ))}
              </FormGrid>
            </section>
          )}

          {groups.map((g) => (
            <section key={g.code} className="flex flex-col gap-3">
              <GroupHeading
                title={g.name ?? `Store ${g.code}`}
                code={g.name ? g.code : undefined}
                count={g.forms.length}
                countLabel="forms"
              />
              <FormGrid>
                {g.forms.map((f) => (
                  <FormCard key={f.key} form={f} stores={stores} canEdit={canEdit} company={company} />
                ))}
              </FormGrid>
            </section>
          ))}

          {singles.length > 0 && (
            <section className="flex flex-col gap-3">
              {(needsStore.length > 0 || groups.length > 0) && <GroupHeading title="One-off stores" count={singles.length} />}
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
            <CardContent className="flex flex-col gap-1.5 py-3 text-sm">
              {data.parked.map((p) => (
                <div key={p.uploadId} className="flex items-center justify-between gap-3">
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">{p.filename || 'Scanned page'}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {p.kind === 'sales' ? 'Sales report (out of scope)' : p.kind === 'blank' ? 'Blank page' : 'Needs placing'}
                  </span>
                </div>
              ))}
            </CardContent>
          </Card>
        </section>
      )}
    </div>
  );
}

function FormGrid({children}: {children: React.ReactNode}) {
  return <div className="grid grid-cols-1 items-start gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">{children}</div>;
}

/** A store (or triage bucket) heading above its cards: the store name once, its code, and
 *  how many forms sit under it — so repeated periods of one store read as one store. */
function GroupHeading({title, code, count, countLabel = 'form', tone}: {title: string; code?: string; count: number; countLabel?: string; tone?: Tone}) {
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
      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
        {count} {count === 1 ? countLabel.replace(/s$/, '') : countLabel.endsWith('s') ? countLabel : `${countLabel}s`}
      </span>
    </div>
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
