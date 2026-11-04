'use client';

import Link from 'next/link';
import {useMemo} from 'react';
import {Card, CardContent} from '@/components/ui/card';
import {cn} from '@/lib/utils';
import {toneText} from '@/src/review-confidence';
import {GL_PAGE} from '@/src/goldline-ui';
import type {TriageForm, TriageResult} from '@/src/goldline-triage-data';
import {
  fmtTriagePeriod,
  FLAG_LABEL,
  flagTone,
  periodHeading,
  periodSortKey,
  VERSION_COLOR,
  VERSION_LABEL,
} from '@/src/goldline-triage-format';

const INVENTORY_PAGES = [1, 2, 3, 4, 5];
const TONE_VAR = {good: 'var(--status-good)', warn: 'var(--status-warn)', crit: 'var(--status-crit)', info: 'var(--primary)'} as const;

function chip(tone: keyof typeof TONE_VAR) {
  return {color: toneText(TONE_VAR[tone]), background: `color-mix(in oklab, ${TONE_VAR[tone]} 14%, transparent)`};
}

/** A single store-day form card. */
function FormCard({form}: {form: TriageForm}) {
  const dupPages = new Set(form.duplicates.map((d) => d.page));
  const done = form.committed > 0 && form.needsReview === 0;
  const href = form.batchId ? `/uploads/batch/${form.batchId}` : form.uploadIds[0] ? `/uploads/${form.uploadIds[0]}` : '#';

  return (
    <Link
      href={href}
      className="group block rounded-xl border border-border bg-card p-4 shadow-sm transition-all hover:border-foreground/25 hover:shadow-md focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/40"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate font-heading text-sm font-semibold tracking-tight">{form.consultant ?? 'Unknown consultant'}</div>
          <div className="mt-0.5 truncate text-xs text-muted-foreground">
            {form.storeName ?? (form.storeCode ? `Store ${form.storeCode}` : 'Store not matched')}
            {form.storeName && form.storeCode ? <span className="tabular-nums"> · {form.storeCode}</span> : null}
          </div>
        </div>
        <span
          className="shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold"
          style={{color: '#fff', background: VERSION_COLOR[form.version]}}
        >
          {VERSION_LABEL[form.version]}
        </span>
      </div>

      {/* Page coverage: 5 cells, filled = present, hollow = missing, ring = duplicate */}
      <div className="mt-3.5 flex items-center gap-1.5" aria-label="Page coverage">
        {INVENTORY_PAGES.map((p) => {
          const present = form.present.includes(p);
          const dup = dupPages.has(p);
          return (
            <span
              key={p}
              title={`Page ${p}${dup ? ' (duplicate)' : present ? '' : ' (missing)'}`}
              className={cn(
                'flex h-6 min-w-0 flex-1 items-center justify-center rounded-md text-[10px] font-medium tabular-nums',
                present ? 'text-foreground' : 'text-muted-foreground/60',
              )}
              style={
                dup
                  ? {...chip('crit'), boxShadow: `inset 0 0 0 1.5px ${TONE_VAR.crit}`}
                  : present
                    ? {background: 'color-mix(in oklab, var(--status-good) 16%, transparent)', color: toneText(TONE_VAR.good)}
                    : {background: 'var(--muted)', boxShadow: 'inset 0 0 0 1px var(--border)'}
              }
            >
              {p}
            </span>
          );
        })}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        {done ? (
          <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium" style={chip('good')}>
            Committed
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium tabular-nums" style={chip(form.missing.length ? 'warn' : 'good')}>
            {form.present.length} of 5 pages
          </span>
        )}
        {form.flags.map((fl) => (
          <span key={fl} className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium" style={chip(flagTone(fl))}>
            {FLAG_LABEL[fl] ?? fl}
          </span>
        ))}
      </div>
    </Link>
  );
}

export function TriageBoard({data, company}: {data: TriageResult; company: string}) {
  const groups = useMemo(() => {
    const by = new Map<string, {heading: string; sort: string; forms: TriageForm[]}>();
    for (const f of data.forms) {
      const sort = periodSortKey(f.periodStart, f.periodEnd);
      const g = by.get(sort) ?? {heading: periodHeading(f.periodStart, f.periodEnd), sort, forms: []};
      g.forms.push(f);
      by.set(sort, g);
    }
    // Latest period first; a form with no readable period (sort key '9999') always
    // sinks to the bottom rather than floating to the top in a descending sort.
    const list = [...by.values()];
    for (const g of list) {
      g.forms.sort((a, b) => (a.storeCode ?? 'zzz').localeCompare(b.storeCode ?? 'zzz') || a.version.localeCompare(b.version));
    }
    return list.sort((a, b) => {
      const aNo = a.sort === '9999';
      const bNo = b.sort === '9999';
      if (aNo !== bNo) return aNo ? 1 : -1;
      return b.sort.localeCompare(a.sort);
    });
  }, [data.forms]);

  const t = data.totals;

  return (
    <div className={GL_PAGE}>
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="font-heading text-xl font-semibold tracking-tight">Scan triage</h1>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Uploaded pages, sorted into store forms by period and version. Open a card to review and commit its counts.
            </p>
          </div>
          <Link
            href="/uploads"
            className="h-9 shrink-0 rounded-md border border-border bg-background px-3 text-sm leading-9 transition-colors hover:border-foreground/25"
          >
            All uploads
          </Link>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground tabular-nums">
          <span><span className="font-medium text-foreground">{t.forms}</span> forms</span>
          <span><span className="font-medium text-foreground">{t.inventoryPages}</span> inventory pages</span>
          {t.sales > 0 && <span>{t.sales} sales {t.sales === 1 ? 'report' : 'reports'} set aside</span>}
          {t.blank > 0 && <span>{t.blank} blank dropped</span>}
          {t.unplaceable > 0 && <span className="text-amber-700 dark:text-amber-300">{t.unplaceable} to place by hand</span>}
        </div>
      </header>

      {data.mock && (
        <div className="rounded-lg border border-dashed border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          Sample view. These are example forms from the September scan; connect the database to see real uploads.
        </div>
      )}

      {data.forms.length === 0 ? (
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
          {groups.map((g) => (
            <section key={g.sort} className="flex flex-col gap-3">
              <div className="flex items-baseline justify-between gap-3 border-b border-border pb-1.5">
                <h2 className="font-heading text-sm font-semibold tracking-tight">{g.heading}</h2>
                <span className="text-xs text-muted-foreground tabular-nums">{g.forms.length} {g.forms.length === 1 ? 'form' : 'forms'}</span>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {g.forms.map((f) => (
                  <FormCard key={f.key} form={f} />
                ))}
              </div>
            </section>
          ))}
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
