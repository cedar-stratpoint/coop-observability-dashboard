// How a queued upload is described and measured — shared by the Uploads panel and the
// global progress indicator so they always say the same thing.

import {progressFor} from '@/src/upload-progress';
import type {QueueItem} from '@/components/analyst/upload-queue';

export function itemPercent(i: QueueItem, now: number): number {
  if (i.state === 'done' || i.state === 'failed' || i.state === 'cancelled') return 100;
  if (i.state !== 'running') return 0;
  return progressFor(i.kind, i.phase, i.uploadFrac, Math.max(0, now - i.phaseAt));
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
          return 'Reading the rows…';
        case 'reading':
          return `Reading page ${i.reading?.page ?? ''} · ${i.reading?.items ?? 0} items`;
        case 'saving':
          return 'Saving…';
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

/** "~1 min left" from elapsed and progress; null until there's enough signal. */
export function eta(startedAt: number | null, percent: number, now: number): string | null {
  if (!startedAt || percent < 8 || percent >= 100) return null;
  const left = ((now - startedAt) / percent) * (100 - percent);
  if (!Number.isFinite(left)) return null;
  const s = Math.round(left / 1000);
  return s < 50 ? 'under a minute left' : `~${Math.round(s / 60)} min left`;
}
