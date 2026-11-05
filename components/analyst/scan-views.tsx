'use client';

import Link from 'next/link';
import {useMemo, useState} from 'react';
import {useRouter} from 'next/navigation';
import {Trash2} from 'lucide-react';
import {toneText} from '@/src/review-confidence';
import {scanPageLabel} from '@/src/upload-batch';
import type {UploadRow} from '@/src/goldline-data';
import type {TriageResult} from '@/src/goldline-triage-data';
import {Button} from '@/components/ui/button';
import {FileTypeBadge} from '@/components/analyst/file-type-badge';
import {DeleteUploadDialog} from '@/components/analyst/delete-upload-dialog';
import {KIND_LABEL, StatusPill, fmtWhen} from '@/components/analyst/uploads-view';

const TONE = {good: 'var(--status-good)', warn: 'var(--status-warn)', crit: 'var(--status-crit)'} as const;
function tint(t: keyof typeof TONE) {
  return {color: toneText(TONE[t]), background: `color-mix(in oklab, ${TONE[t]} 14%, transparent)`};
}

/** The scan's pages as a plain list — "Page 10 of 98", in page order, each opening its
 *  review. The raw filename is a quiet sub-line, not the headline. */
export function ScanFileList({files, canEdit, company}: {files: UploadRow[]; canEdit: boolean; company: string}) {
  const router = useRouter();
  const [deleteTarget, setDeleteTarget] = useState<UploadRow | null>(null);
  const rows = useMemo(
    () => [...files].sort((a, b) => scanPageLabel(a.filename).index - scanPageLabel(b.filename).index || a.filename.localeCompare(b.filename)),
    [files],
  );

  if (rows.length === 0) {
    return <p className="py-10 text-center text-sm text-muted-foreground">No files in this scan.</p>;
  }

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <ul role="list" className="flex flex-col divide-y divide-border">
        {rows.map((u) => {
          const label = scanPageLabel(u.filename);
          return (
            <li key={u.id} className="relative flex items-center gap-3 px-4 py-3.5 transition-colors hover:bg-muted/40">
              <FileTypeBadge filename={u.filename} />
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <Link
                  href={`/uploads/${u.id}`}
                  className="truncate font-medium outline-none after:absolute after:inset-0 after:content-[''] focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset"
                  title={u.filename}
                >
                  {label.title}
                </Link>
                {label.sub && <span className="truncate font-mono text-[11px] text-muted-foreground">{label.sub}</span>}
                <span className="truncate text-xs text-muted-foreground">
                  {KIND_LABEL[u.kind] ?? 'File'} · {fmtWhen(u.created_at)}
                </span>
              </div>
              <StatusPill status={u.status} />
              {canEdit && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Delete ${label.title}`}
                  className="relative z-10 shrink-0 text-muted-foreground hover:text-destructive"
                  onClick={() => setDeleteTarget(u)}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              )}
            </li>
          );
        })}
      </ul>
      <DeleteUploadDialog
        company={company}
        upload={deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onDeleted={() => {
          setDeleteTarget(null);
          router.refresh();
        }}
      />
    </div>
  );
}

type BaGroup = {name: string; forms: number; stores: number; needsStore: number; incomplete: number; ready: number; committed: number};

/** One card per Beauty Assistant: how many forms and stores are theirs in this scan, and
 *  what still needs doing. Opens that BA's forms (the store view, filtered). */
export function BaCards({data, source}: {data: TriageResult; source: string}) {
  const groups = useMemo(() => {
    const by = new Map<string, BaGroup>();
    for (const f of data.forms) {
      const name = f.consultant?.trim() || 'No BA on the form';
      const g = by.get(name) ?? {name, forms: 0, stores: 0, needsStore: 0, incomplete: 0, ready: 0, committed: 0};
      g.forms++;
      const done = f.committed > 0 && f.needsReview === 0;
      if (done) g.committed++;
      else if (!f.storeCode || f.flags.includes('store-unmatched')) g.needsStore++;
      else if (f.missing.length > 0) g.incomplete++;
      else g.ready++;
      by.set(name, g);
    }
    for (const g of by.values()) {
      g.stores = new Set(data.forms.filter((f) => (f.consultant?.trim() || 'No BA on the form') === g.name).map((f) => f.storeCode).filter(Boolean)).size;
    }
    // BAs who still need you first, then by form count.
    return [...by.values()].sort((a, b) => b.needsStore + b.incomplete - (a.needsStore + a.incomplete) || b.forms - a.forms);
  }, [data.forms]);

  if (groups.length === 0) {
    return <p className="py-10 text-center text-sm text-muted-foreground">No forms with a BA in this scan yet.</p>;
  }

  return (
    <div className="grid grid-cols-1 items-start gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {groups.map((g) => {
        const attention = g.needsStore + g.incomplete;
        const stripe = g.needsStore > 0 ? TONE.crit : g.incomplete > 0 ? TONE.warn : TONE.good;
        return (
          <Link
            key={g.name}
            href={`/uploads/scan/${encodeURIComponent(source)}?view=store&ba=${encodeURIComponent(g.name)}`}
            className="group relative block overflow-hidden rounded-xl border border-border bg-card shadow-sm transition-all hover:border-foreground/25 hover:shadow-md focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/40"
          >
            <span aria-hidden className="absolute inset-x-0 top-0 h-[3px]" style={{background: stripe}} />
            <div className="flex flex-col gap-3 p-4 pt-[18px]">
              <div className="min-w-0">
                <div className="truncate font-heading text-sm font-semibold tracking-tight">{g.name}</div>
                <div className="mt-0.5 font-mono text-[11.5px] text-muted-foreground tabular-nums">
                  {g.forms} {g.forms === 1 ? 'form' : 'forms'} · {g.stores} {g.stores === 1 ? 'store' : 'stores'}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                {g.needsStore > 0 && <Pill tone="crit" n={g.needsStore} label="need a store" />}
                {g.incomplete > 0 && <Pill tone="warn" n={g.incomplete} label="incomplete" />}
                {g.ready > 0 && <Pill tone="good" n={g.ready} label="ready" />}
                {g.committed > 0 && (
                  <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground tabular-nums">{g.committed} done</span>
                )}
              </div>
              <span className="self-end text-[11px] font-medium text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">
                {attention > 0 ? 'Open forms →' : 'View forms →'}
              </span>
            </div>
          </Link>
        );
      })}
    </div>
  );
}

function Pill({tone, n, label}: {tone: keyof typeof TONE; n: number; label: string}) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium tabular-nums" style={tint(tone)}>
      <span className="font-semibold">{n}</span> {label}
    </span>
  );
}
