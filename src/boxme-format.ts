// Display strings for the BoxMe channel. Pure and locale-free (manual month
// names, fixed Manila offset) so server and client render identical text.

import type {SyncInfo} from './boxme-inventory-compute';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MANILA_MS = 8 * 3_600_000;

/** '15 Apr 2027' from a YYYY-MM-DD date. */
export function fmtDate(date: string): string {
  const [y, m, d] = date.slice(0, 10).split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

/** '07:31 today' / '07:31 yesterday' / '07:31, 3 Oct' in Manila time. */
export function fmtManilaWhen(iso: string, now: Date): string {
  const t = new Date(Date.parse(iso) + MANILA_MS);
  const today = new Date(now.getTime() + MANILA_MS).toISOString().slice(0, 10);
  const yesterday = new Date(now.getTime() + MANILA_MS - 86_400_000).toISOString().slice(0, 10);
  const day = t.toISOString().slice(0, 10);
  const hhmm = t.toISOString().slice(11, 16);
  if (day === today) return `${hhmm} today`;
  if (day === yesterday) return `${hhmm} yesterday`;
  return `${hhmm}, ${t.getUTCDate()} ${MONTHS[t.getUTCMonth()]}`;
}

export type Tone = 'good' | 'warn' | 'crit' | 'muted';

/** Pill text + tone for the freshness indicator. Color always travels with a word. */
export function syncPill(sync: SyncInfo, now: Date): {tone: Tone; label: string} {
  switch (sync.state) {
    case 'fresh':
      return {tone: 'good', label: `Synced ${fmtManilaWhen(sync.lastGoodAt!, now)}`};
    case 'partial':
      return {tone: 'warn', label: `Synced with gaps ${fmtManilaWhen(sync.lastGoodAt!, now)}`};
    case 'stale':
      return {tone: 'warn', label: sync.lastGoodAt ? `Stale, last synced ${fmtManilaWhen(sync.lastGoodAt, now)}` : 'Stale'};
    case 'failed':
      return {tone: 'crit', label: 'Last sync failed'};
    default:
      return {tone: 'muted', label: 'Not connected'};
  }
}

/** '~23 days', 'Under a day', or null when there is no estimate. */
export function fmtLasts(lastsDays: number | null): string | null {
  if (lastsDays == null) return null;
  if (lastsDays < 1) return 'Under a day';
  const d = Math.round(lastsDays);
  return `~${d} day${d === 1 ? '' : 's'}`;
}
