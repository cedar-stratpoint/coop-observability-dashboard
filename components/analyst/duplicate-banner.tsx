import Link from 'next/link';
import {COUNT_FIELDS, type CountField} from '@/src/goldline-dup-diff';
import type {DuplicateMatch} from '@/src/goldline-triage-data';

const FIELD_LABEL: Record<CountField, string> = {
  stockroom: 'Stockroom',
  drawer: 'Drawer',
  selling_area: 'Selling',
  delivery: 'Delivery',
  ending_on_hand: 'Ending',
};

const num = (v: number | null) => (v == null ? '—' : String(v));

function whenLabel(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-PH', {month: 'short', day: 'numeric', year: 'numeric'});
}

/**
 * Phase 2 — a re-upload / duplicate notice on the review page. Flag, never block: it
 * tells the reviewer this page was uploaded before and exactly which counts differ, so
 * they can decide which copy to keep. Uses the Coop --status-* tokens.
 */
export function DuplicateBanner({match}: {match: DuplicateMatch}) {
  const diff = match.diff;
  const identical = diff?.identical ?? false;
  const differing = diff?.differingItems ?? 0;
  const tone = identical ? 'var(--status-good)' : 'var(--status-warn)';
  const changed = diff ? [...diff.changed, ...diff.added, ...diff.removed] : [];

  return (
    <div
      className="rounded-xl border p-4"
      style={{borderColor: `color-mix(in oklab, ${tone} 40%, transparent)`, background: `color-mix(in oklab, ${tone} 8%, transparent)`}}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-heading text-sm font-semibold tracking-tight">
            {match.committed ? 'This page was already committed' : 'This page was already uploaded'}
          </h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            A scan of the same store, period and page came in on {whenLabel(match.createdAt)}
            {diff == null
              ? '. The counts can’t be compared yet.'
              : identical
                ? '. The counts are identical, so this is a redundant copy.'
                : `. ${differing} ${differing === 1 ? 'item differs' : 'items differ'} from that copy. Review before you commit.`}
          </p>
        </div>
        <Link
          href={`/uploads/${match.uploadId}`}
          className="h-8 shrink-0 rounded-md border border-border bg-background px-3 text-xs leading-8 transition-colors hover:border-foreground/25"
        >
          Open the earlier copy
        </Link>
      </div>

      {changed.length > 0 && (
        <details className="mt-3 group">
          <summary className="cursor-pointer text-xs font-medium text-muted-foreground transition-colors hover:text-foreground">
            Show what changed ({changed.length})
          </summary>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full min-w-[22rem] text-left text-xs">
              <thead>
                <tr className="text-muted-foreground">
                  <th className="py-1 pr-3 font-medium">Item</th>
                  {COUNT_FIELDS.map((f) => (
                    <th key={f} className="px-2 py-1 text-right font-medium tabular-nums">{FIELD_LABEL[f]}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {changed.map((row) => {
                  const byField = new Map(row.fields.map((d) => [d.field, d]));
                  return (
                    <tr key={row.item_code} className="border-t border-border/60">
                      <td className="py-1 pr-3 font-mono text-[11px]">
                        {row.item_code}
                        {row.kind !== 'changed' && <span className="ml-1 text-muted-foreground">({row.kind})</span>}
                      </td>
                      {COUNT_FIELDS.map((f) => {
                        const d = byField.get(f);
                        return (
                          <td key={f} className="px-2 py-1 text-right tabular-nums">
                            {d ? (
                              <span>
                                <span className="text-muted-foreground line-through">{num(d.from)}</span>{' '}
                                <span className="font-medium">{num(d.to)}</span>
                              </span>
                            ) : (
                              <span className="text-muted-foreground/50">·</span>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </div>
  );
}
