// How a queued upload is described and measured — shared by the Uploads panel and the
// global progress indicator so they always say the same thing.

import {progressFor} from '@/src/upload-progress';
import {scanPosition} from '@/src/upload-batch';
import type {QueueItem} from '@/components/analyst/upload-queue';

export function itemPercent(i: QueueItem, now: number): number {
  if (i.state === 'done' || i.state === 'failed' || i.state === 'cancelled') return 100;
  if (i.state !== 'running') return 0;
  return progressFor(i.kind, i.phase, i.uploadFrac, Math.max(0, now - i.phaseAt));
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const n = (v: number) => v.toLocaleString('en-US');

/** "Sep 2026 · 37,211 rows · 301 stores (12 new)" for a saved Watsons month. */
export function watsonsLabel(i: QueueItem): string {
  const w = i.watsons;
  if (!w) return `Saved ${n(i.rowsCommitted ?? 0)} sales rows`;
  const [y, m] = w.month.start.split('-');
  const month = `${MONTHS[Number(m) - 1] ?? m} ${y}`;
  return `${month} · ${n(w.salesRows)} rows · ${n(w.stores)} stores${w.storesAdded ? ` (${n(w.storesAdded)} new)` : ''}`;
}

export function itemLabel(i: QueueItem): string {
  switch (i.state) {
    case 'queued':
      return 'Waiting…';
    case 'waiting_period':
      return 'Needs the period below';
    case 'cancelled':
      return 'Cancelled';
    case 'failed':
      return i.error ?? 'Failed';
    case 'done':
      if (i.kind === 'csv') return `Saved ${i.rowsCommitted ?? 0} sales rows`;
      if (i.kind === 'xlsx') return watsonsLabel(i);
      return i.page
        ? `Page ${i.page} · ${i.flagged ? `${i.flagged} to check` : 'nothing flagged'}`
        : 'Read — ready for review';
    case 'running':
      switch (i.phase) {
        case 'uploading':
          return `Uploading ${Math.round(i.uploadFrac * 100)}%`;
        case 'stored':
        case 'detecting':
          return 'Finding the page…';
        case 'parsing':
          return i.kind === 'xlsx' ? 'Reading the month…' : 'Reading the rows…';
        case 'reading':
          return `Reading page ${i.reading?.page ?? ''} · ${i.reading?.items ?? 0} items`;
        case 'saving':
          return i.kind === 'xlsx' ? 'Saving stores, SKUs and sales…' : 'Saving…';
        default:
          return 'Working…';
      }
  }
}

export type QueueSummary = {
  total: number; // excluding cancelled
  done: number;
  failed: number;
  running: number;
  waiting: number; // queued + waiting for period
  readyForReview: number; // PDFs read and awaiting review
  percent: number;
};

export function summarize(items: QueueItem[], now: number): QueueSummary {
  const live = items.filter((i) => i.state !== 'cancelled');
  const percent = live.length ? live.reduce((a, i) => a + itemPercent(i, now), 0) / live.length : 0;
  return {
    total: live.length,
    done: live.filter((i) => i.state === 'done').length,
    failed: live.filter((i) => i.state === 'failed').length,
    running: live.filter((i) => i.state === 'running').length,
    waiting: live.filter((i) => i.state === 'queued' || i.state === 'waiting_period').length,
    readyForReview: live.filter((i) => i.state === 'done' && i.serverStatus === 'needs_review').length,
    percent: Math.min(100, percent),
  };
}

/** One collapsed row in the queue list: either a single file, or all the pages that
 *  were split out of one multi-page PDF, so a 98-page scan is one line, not 98. */
export type QueueGroup = {
  key: string;
  /** The source PDF name ("Scan….pdf") for a split group, else the single file name. */
  source: string;
  items: QueueItem[];
  isSplit: boolean; // true when this is a multi-page PDF split into pages
  size: number; // sum of live page sizes
  done: number;
  failed: number;
  running: number;
  waiting: number;
  total: number; // live (non-cancelled)
  percent: number;
};

/**
 * Group queue items by the PDF they were split from (filename "… (page N of M).pdf"),
 * so the list shows one summarized row per source scan instead of one row per page.
 * A single file (CSV, XLSX, or a one-page PDF) is its own group of one. Order follows
 * first appearance so the list stays stable.
 */
export function groupQueueItems(items: QueueItem[], now: number): QueueGroup[] {
  const order: string[] = [];
  const buckets = new Map<string, QueueItem[]>();
  for (const it of items) {
    const src = scanPosition(it.name)?.source;
    const key = src ? `pdf:${src}` : `one:${it.id}`;
    if (!buckets.has(key)) {
      buckets.set(key, []);
      order.push(key);
    }
    buckets.get(key)!.push(it);
  }
  return order.map((key) => {
    const group = buckets.get(key)!;
    const live = group.filter((i) => i.state !== 'cancelled');
    const isSplit = key.startsWith('pdf:') && group.length > 1;
    const source = isSplit ? `${key.slice(4)}.pdf` : group[0].name;
    const percent = live.length ? live.reduce((a, i) => a + itemPercent(i, now), 0) / live.length : 0;
    return {
      key,
      source,
      items: group,
      isSplit,
      size: live.reduce((a, i) => a + i.size, 0),
      done: live.filter((i) => i.state === 'done').length,
      failed: live.filter((i) => i.state === 'failed').length,
      running: live.filter((i) => i.state === 'running').length,
      waiting: live.filter((i) => i.state === 'queued' || i.state === 'waiting_period').length,
      total: live.length,
      percent: Math.min(100, percent),
    };
  });
}

/** A short status line for a collapsed split group: "12 of 98 read · 2 flagged". */
export function groupLabel(g: QueueGroup): string {
  if (!g.isSplit) return '';
  const parts: string[] = [];
  if (g.done < g.total) parts.push(`${g.done} of ${g.total} read`);
  else parts.push(`${g.total} ${g.total === 1 ? 'page' : 'pages'} read`);
  if (g.failed) parts.push(`${g.failed} failed`);
  if (g.waiting && g.done < g.total) parts.push(`${g.waiting} waiting`);
  return parts.join(' · ');
}

/** "~1 min left" from elapsed and progress; null until there's enough signal. */
export function eta(startedAt: number | null, percent: number, now: number): string | null {
  if (!startedAt || percent < 8 || percent >= 100) return null;
  const left = ((now - startedAt) / percent) * (100 - percent);
  if (!Number.isFinite(left)) return null;
  const s = Math.round(left / 1000);
  return s < 50 ? 'under a minute left' : `~${Math.round(s / 60)} min left`;
}
