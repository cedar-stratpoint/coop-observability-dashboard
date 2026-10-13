import type {ForecastStatus} from './pos-forecast-compute';

// Status pill styles shared by the Stratpoint (Offline) and BoxMe (Online)
// inventory tables and the BoxMe detail card. Plain module (no 'use client') so
// server components can read the values, not a client reference.
export const STATUS: Record<ForecastStatus, {label: string; dot: string; text: string; bg: string}> = {
  healthy: {label: 'Healthy', dot: 'bg-emerald-500', text: 'text-emerald-600 dark:text-emerald-400', bg: 'bg-emerald-500/10'},
  low: {label: 'Low', dot: 'bg-amber-500', text: 'text-amber-600 dark:text-amber-400', bg: 'bg-amber-500/10'},
  out: {label: 'Out', dot: 'bg-red-500', text: 'text-red-600 dark:text-red-400', bg: 'bg-red-500/10'},
};
