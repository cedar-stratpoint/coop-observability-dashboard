'use client';

// The stat tiles, charts and tables Ask Coop draws inside an answer (F7). Contract: src/chat/block-types.ts.
// A block carries server-bound data; this file only presents it. Every chart has a table twin (every row, including
// categories folded into "Other"), and a block whose source failed a check shows a "Not reliable" badge (icon + words).
import {useState} from 'react';
import dynamic from 'next/dynamic';
import {ChevronRight, FlaskConical, TriangleAlert} from 'lucide-react';
import type {ChartBlock, ChatBlock, KpiBlock, TableBlock} from '@/src/chat/block-types';
import type {MetricRow, ResultColumn} from '@/src/chat/result-types';
import {cn} from '@/lib/utils';
import {downloadCsv} from '../../src/csv';
import {copyList, csvRows, formatCategory, formatValue} from './chat-blocks-format';

// Recharts is an async chunk (same pattern as charts-lazy.tsx); the skeleton holds the height so there is no layout jump.
const ChartView = dynamic(() => import('./chat-charts').then((m) => m.ChartView), {
  ssr: false,
  loading: () => <div className="h-[200px] w-full animate-pulse rounded-lg bg-muted/40" aria-hidden />,
});

const FOCUS = 'outline-none focus-visible:ring-2 focus-visible:ring-ring/50';

export function ReliabilityBadge() {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-[color-mix(in_oklab,var(--status-warn)_45%,transparent)] bg-[color-mix(in_oklab,var(--status-warn)_12%,transparent)] px-2 py-0.5 text-[11px] font-medium text-foreground">
      <TriangleAlert className="size-3" style={{color: 'var(--status-warn)'}} aria-hidden />
      Not reliable
    </span>
  );
}

/** Explore only: the "Exploratory" chip and a collapsed "Show SQL" disclosure. The SQL is shown exactly as it ran; it is text, never HTML. */
export function ExploratoryBar({sql}: {sql: string | null | undefined}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="inline-flex w-fit shrink-0 items-center gap-1 rounded-full border border-border bg-muted px-2 py-0.5 text-[11px] font-medium text-foreground">
        <FlaskConical className="size-3" aria-hidden />
        Exploratory, not a registered metric
      </span>
      {sql && (
        <details className="group text-[11px] text-muted-foreground">
          <summary className={cn('inline-flex cursor-pointer list-none items-center gap-1 rounded-md py-0.5 hover:text-foreground [&::-webkit-details-marker]:hidden', FOCUS)}>
            <ChevronRight className="size-3 transition-transform group-open:rotate-90 motion-reduce:transition-none" aria-hidden />
            Show SQL
          </summary>
          <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/60 p-2 font-mono text-[11px] leading-snug text-foreground">{sql}</pre>
        </details>
      )}
    </div>
  );
}

/** A collapsed "Notes (n)" disclosure. Native <details>: keyboard and screen-reader friendly with no state. */
function Notes({notes}: {notes: string[]}) {
  if (notes.length === 0) return null;
  return (
    <details className="group text-[11px] text-muted-foreground">
      <summary className={cn('inline-flex cursor-pointer list-none items-center gap-1 rounded-md py-0.5 hover:text-foreground [&::-webkit-details-marker]:hidden', FOCUS)}>
        <ChevronRight className="size-3 transition-transform group-open:rotate-90 motion-reduce:transition-none" aria-hidden />
        Notes ({notes.length})
      </summary>
      <ul className="mt-1 list-disc space-y-1 pl-5 leading-snug">
        {notes.map((n, i) => (
          <li key={i}>{n}</li>
        ))}
      </ul>
    </details>
  );
}

function KpiRow({blocks}: {blocks: KpiBlock[]}) {
  const unreliable = blocks.some((b) => !b.reliable);
  const notes = [...new Set(blocks.flatMap((b) => b.caveats))];
  const explore = blocks.find((b) => b.exploratory);
  return (
    <div className="flex w-full flex-col gap-1.5">
      {explore && <ExploratoryBar sql={explore.sql} />}
      {unreliable && (
        <div>
          <ReliabilityBadge />
        </div>
      )}
      {/* Container query, not viewport: the drawer is ~440px wide on desktop, so tiles sit 2 x 2 there. */}
      <div className="@container">
        <ul className="grid grid-cols-2 gap-2 @xl:grid-cols-4">
          {blocks.map((b) => (
            <li key={b.id} className="min-w-0 rounded-xl border border-border bg-card px-3 py-2.5" aria-label={`${b.label}: ${formatValue(b.value, b.format)}`}>
              <div className="text-[11px] leading-snug text-muted-foreground">{b.label}</div>
              <div className="mt-0.5 break-words font-sans text-[20px] font-semibold leading-tight text-foreground [font-variant-numeric:proportional-nums]">{formatValue(b.value, b.format)}</div>
              {b.sub && <div className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{b.sub}</div>}
            </li>
          ))}
        </ul>
      </div>
      <Notes notes={notes} />
    </div>
  );
}

const isNumericColumn = (c: ResultColumn) => c.unit !== 'text' && c.unit !== 'date' && c.role !== 'category' && c.role !== 'time';

function cell(c: ResultColumn, row: MetricRow): string {
  const v = row[c.key] ?? null;
  if (c.unit === 'date') return formatCategory(v, 'date');
  return formatValue(v, c.unit);
}

/** Compact table: numbers right-aligned in tabular numerals, sticky first column, scrolls sideways inside its own box. */
export function DataTable({columns, rows, total, label}: {columns: ResultColumn[]; rows: MetricRow[]; total: MetricRow | null; label: string}) {
  return (
    <div tabIndex={0} role="region" aria-label={`${label}, table`} className={cn('max-w-full overflow-x-auto rounded-lg border border-border', FOCUS)}>
      <table className="w-full border-collapse text-[12px]">
        <thead>
          <tr className="bg-muted text-muted-foreground">
            {columns.map((c, i) => (
              <th key={c.key} scope="col" className={cn('whitespace-nowrap px-2.5 py-1.5 font-medium', isNumericColumn(c) ? 'text-right' : 'text-left', i === 0 && 'sticky left-0 bg-muted')}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, ri) => (
            <tr key={ri} className="border-t border-border">
              {columns.map((c, i) => (
                <td key={c.key} className={cn('px-2.5 py-1.5', isNumericColumn(c) ? 'whitespace-nowrap text-right tabular-nums' : 'text-left', i === 0 && 'sticky left-0 bg-card font-medium text-foreground')}>
                  {cell(c, r)}
                </td>
              ))}
            </tr>
          ))}
          {total && (
            <tr className="border-t-2 border-border bg-muted/60 font-semibold text-foreground">
              {columns.map((c, i) => (
                <td key={c.key} className={cn('px-2.5 py-1.5', isNumericColumn(c) ? 'whitespace-nowrap text-right tabular-nums' : 'text-left', i === 0 && 'sticky left-0 bg-muted')}>
                  {i === 0 && total[c.key] == null ? 'Total' : cell(c, total)}
                </td>
              ))}
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function ViewToggle({view, onChange}: {view: 'chart' | 'table'; onChange: (v: 'chart' | 'table') => void}) {
  return (
    <div role="group" aria-label="View" className="inline-flex shrink-0 rounded-lg bg-muted p-0.5 text-[11px] font-medium">
      {(['chart', 'table'] as const).map((v) => (
        <button
          key={v}
          type="button"
          aria-pressed={view === v}
          onClick={() => onChange(v)}
          className={cn('rounded-md px-2.5 py-1 transition-colors motion-reduce:transition-none', FOCUS, view === v ? 'bg-card text-foreground' : 'text-muted-foreground hover:text-foreground')}
        >
          {v === 'chart' ? 'Chart' : 'Table'}
        </button>
      ))}
    </div>
  );
}

const ACTION_BTN = 'rounded-md border border-border px-2.5 py-1 text-[11px] font-medium text-foreground transition-colors hover:bg-muted motion-reduce:transition-none';

/** Copy and CSV for a contact table. Nothing is sent anywhere: the owner pastes or opens the file themselves. */
function ContactActions({block}: {block: TableBlock}) {
  const [done, setDone] = useState<string | null>(null);
  const copy = async (which: 'emails' | 'mobiles') => {
    try {
      await navigator.clipboard.writeText(copyList(block, which));
      setDone(which);
      setTimeout(() => setDone(null), 1500);
    } catch {
      setDone('failed');
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-1.5" aria-label="Contact list actions">
      <button type="button" className={cn(ACTION_BTN, FOCUS)} onClick={() => copy('emails')}>{done === 'emails' ? 'Copied' : 'Copy emails'}</button>
      <button type="button" className={cn(ACTION_BTN, FOCUS)} onClick={() => copy('mobiles')}>{done === 'mobiles' ? 'Copied' : 'Copy mobiles'}</button>
      <button type="button" className={cn(ACTION_BTN, FOCUS)} onClick={() => downloadCsv(block.csvName ?? 'contacts.csv', csvRows(block))}>Download CSV</button>
      {done === 'failed' && <span role="status" className="text-[11px] text-muted-foreground">Could not copy. Use Download CSV.</span>}
    </div>
  );
}

function BlockCard({block, toggle, children}: {block: TableBlock | ChartBlock; toggle?: React.ReactNode; children: React.ReactNode}) {
  const adjustments = block.kind === 'chart' ? block.chosen.adjustments : [];
  return (
    <section aria-label={block.title} className="flex w-full flex-col gap-2 rounded-2xl border border-border bg-card p-3">
      <header className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-[13px] font-semibold leading-snug text-foreground">{block.title}</h3>
          {block.basis && <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{block.basis}</p>}
        </div>
        {toggle}
      </header>
      {block.exploratory && <ExploratoryBar sql={block.sql} />}
      {!block.reliable && (
        <div>
          <ReliabilityBadge />
        </div>
      )}
      {children}
      {adjustments.map((a, i) => (
        <p key={i} className="text-[11px] leading-snug text-muted-foreground">
          {a}
        </p>
      ))}
      <Notes notes={block.caveats} />
    </section>
  );
}

function ChartCard({block}: {block: ChartBlock}) {
  const [view, setView] = useState<'chart' | 'table'>('chart');
  return (
    <BlockCard block={block} toggle={<ViewToggle view={view} onChange={setView} />}>
      {view === 'chart' ? <ChartView block={block} /> : <DataTable columns={block.twin.columns} rows={block.twin.rows} total={null} label={block.title} />}
    </BlockCard>
  );
}

/** Renders blocks in order. Adjacent stat tiles become ONE responsive row. */
export function ChatBlocks({blocks}: {blocks: ChatBlock[]}) {
  const out: React.ReactNode[] = [];
  let run: KpiBlock[] = [];
  const flush = () => {
    if (run.length) out.push(<KpiRow key={`kpi-${run[0].id}`} blocks={run} />);
    run = [];
  };
  for (const b of blocks) {
    if (b.kind === 'kpi') {
      run.push(b);
      continue;
    }
    flush();
    out.push(
      b.kind === 'chart' ? (
        <ChartCard key={b.id} block={b} />
      ) : (
        <BlockCard key={b.id} block={b}>
          {b.pii && <ContactActions block={b} />}
          <DataTable columns={b.columns} rows={b.rows} total={b.total} label={b.title} />
        </BlockCard>
      ),
    );
  }
  flush();
  return <div className="flex w-full flex-col gap-3">{out}</div>;
}
