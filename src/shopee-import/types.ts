// The Shopee import pipeline's shared shapes. Plain data, no I/O. See knowledge/tasks/2026-10-22-shopee-import-data-engineering-plan.md.

/** One PH day of shop figures from a Sales Overview export. Money in pesos, counts whole. */
export interface DayFigures {
  day: string; // YYYY-MM-DD, PH calendar day
  salesPlaced: number;
  salesConfirmed: number;
  ordersPlaced: number;
  ordersConfirmed: number;
  unitsPlaced: number;
  unitsConfirmed: number;
  buyersPlaced: number | null;
  buyersConfirmed: number | null;
  visitors: number | null;
}

export interface ParsedSalesOverview {
  /** The week (or span) the file says it covers, from its summary row. */
  periodFrom: string;
  periodTo: string;
  /** The file's own totals, to check the daily rows against. */
  summary: {salesPlaced: number; salesConfirmed: number};
  days: DayFigures[];
}

export type ReportType = 'sales_overview' | 'product_overview' | 'traffic' | 'sku_detail' | 'ads';

export interface GateFailure {
  code: string;
  message: string;
}
