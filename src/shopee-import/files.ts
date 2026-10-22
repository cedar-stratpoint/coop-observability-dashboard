// Finding and naming the export files. Shopee names are not uniform (dots, dashes, underscores, DD_MM_YYYY in the ads CSV), so the
// report type and the dates are read from the name by pattern, the same patterns the weekly digest run already uses
// (docs/shopee-manual-exports.md in the backend). A flat folder (the Mac's weekly drop) and a folder of weekly sub-folders both work.
import type {ReportType} from './types';

export interface Classified {
  type: ReportType | null;
  period: {from: string; to: string} | null;
}

const iso8 = (s: string): string => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;

export function classifyFile(name: string): Classified {
  const n = name.toLowerCase();
  const type: ReportType | null = /^sales_?overview/.test(n) ? 'sales_overview'
    : /^traffic_?overview/.test(n) ? 'traffic'
    : /^product_?overview/.test(n) ? 'product_overview'
    : /^parent_?sku_?detail/.test(n) ? 'sku_detail'
    : /ads.*overall.*\.csv$/.test(n) ? 'ads'
    : null;
  const ymd = /(\d{8})[-_](\d{8})/.exec(name);
  if (ymd) return {type, period: {from: iso8(ymd[1]), to: iso8(ymd[2])}};
  const dmy = /(\d{2})_(\d{2})_(\d{4})-(\d{2})_(\d{2})_(\d{4})/.exec(name);
  if (dmy) return {type, period: {from: `${dmy[3]}-${dmy[2]}-${dmy[1]}`, to: `${dmy[6]}-${dmy[5]}-${dmy[4]}`}};
  return {type, period: null};
}

/** Folders and files that are never imports: macOS litter, Excel lock files, and (by default) the weekly run's `_superseded/`. */
export function isIgnored(relativePath: string, includeSuperseded: boolean): boolean {
  const parts = relativePath.split('/');
  const base = parts[parts.length - 1];
  if (base === '.DS_Store' || base.startsWith('~$') || base.startsWith('.')) return true;
  return !includeSuperseded && parts.slice(0, -1).includes('_superseded');
}
