'use client';

import {usePathname, useRouter} from 'next/navigation';
import {NativeSelect} from '@/components/ui/native-select';
import {cn} from '@/lib/utils';
import type {ItemMovement} from '@/src/goldline-movement';

// Small shared pieces for the Goldline stock pages (Inventory counts / forecast,
// Action Feed, Health): the store picker and the Counts | Forecast tabs.

export const fmtDay = (iso: string | null) =>
  iso ? new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', {month: 'short', day: 'numeric', timeZone: 'UTC'}) : '—';
export const fmtRange = (start: string, end: string) => `${fmtDay(start)} to ${fmtDay(end)}, ${end.slice(0, 4)}`;
export const peso = (n: number) => `₱${Math.round(n).toLocaleString('en-US')}`;
/** Movement status (Stock forecast, product page): label, tone, sort rank. */
export const MOVEMENT_STATUS: Record<ItemMovement['status'], {label: string; tone: string | null; rank: number}> = {
  out: {label: 'Out', tone: 'var(--status-crit)', rank: 0},
  reorder: {label: 'Reorder', tone: 'var(--status-warn)', rank: 1},
  watch: {label: 'Within a cycle', tone: 'var(--status-warn)', rank: 2},
  healthy: {label: 'Healthy', tone: 'var(--status-good)', rank: 3},
  no_history: {label: 'Needs 2 counts', tone: null, rank: 4},
  not_counted: {label: 'Not counted', tone: null, rank: 5},
};
export const compactPeso = (n: number) => `₱${new Intl.NumberFormat('en', {notation: 'compact', maximumFractionDigits: 1}).format(n)}`;

export function StorePicker({
  stores,
  value,
  allLabel,
  param = 'store',
}: {
  stores: Array<{code: string; name: string | null}>;
  value: string | null; // null = all stores (when allLabel is given)
  allLabel?: string;
  param?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  return (
    <NativeSelect
      aria-label="Store"
      value={value ?? ''}
      onChange={(e) => router.push(e.target.value ? `${pathname}?${param}=${encodeURIComponent(e.target.value)}` : pathname)}
    >
      {allLabel && <option value="">{allLabel}</option>}
      {stores.map((s) => (
        <option key={s.code} value={s.code}>
          {s.name ? `${s.code} · ${s.name}` : `Store ${s.code}`}
        </option>
      ))}
    </NativeSelect>
  );
}

export function ToneChip({tone, children}: {tone: string | null; children: React.ReactNode}) {
  return (
    <span
      className={cn('inline-flex h-5 items-center rounded-full px-2 text-[11px] font-medium whitespace-nowrap', !tone && 'bg-muted text-muted-foreground')}
      style={
        tone
          ? {color: `color-mix(in oklab, ${tone} 72%, var(--foreground))`, background: `color-mix(in oklab, ${tone} 14%, transparent)`}
          : undefined
      }
    >
      {children}
    </span>
  );
}
