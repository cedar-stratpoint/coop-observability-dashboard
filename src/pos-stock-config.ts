// Pure parser for the stored stock forecast config (pos_settings key stock_forecast_config). Moved out of pos-stock-settings.ts
// (server-only) so the chat registry can use the very same parsing (DRY: one parse for the Inventory page and Ask Coop).
import {DEFAULT_FORECAST_CONFIG, type ForecastConfig} from './pos-forecast-compute';

export function numOr(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}
export function numMap(v: unknown): Record<string, number> {
  if (!v || typeof v !== 'object') return {};
  const out: Record<string, number> = {};
  for (const [k, raw] of Object.entries(v as Record<string, unknown>)) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) out[k] = n;
  }
  return out;
}

/** Parse the stored config blob into a ForecastConfig, defaulting each field. */
export function parseStockConfig(value: unknown): ForecastConfig {
  const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const days = Array.isArray(v.event_days)
    ? (v.event_days as unknown[]).map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6)
    : [];
  return {
    threshold: numOr(v.threshold, DEFAULT_FORECAST_CONFIG.threshold),
    thresholdOverrides: numMap(v.threshold_overrides),
    targetCoverEventDays: numOr(v.target_cover_events, DEFAULT_FORECAST_CONFIG.targetCoverEventDays),
    leadTimeDays: numOr(v.lead_time_days, DEFAULT_FORECAST_CONFIG.leadTimeDays),
    earlyWarningEvents: numOr(v.early_warning_events, DEFAULT_FORECAST_CONFIG.earlyWarningEvents),
    eventWeekdays: days.length ? days : DEFAULT_FORECAST_CONFIG.eventWeekdays,
  };
}
