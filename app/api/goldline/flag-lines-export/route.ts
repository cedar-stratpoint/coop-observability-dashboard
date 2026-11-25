import {getDataContext} from '@/src/active-context';
import {flagLines} from '@/src/goldline-flag-lines-data';
import {EXPORT_HEAD, exportRow, filterLines, parseFlagFilter} from '@/src/goldline-flag-lines';
import {toCsv} from '@/src/csv';

// Every flag the Flags page's query matches, as a CSV (NICH-43 §4: "export all SKUs that need
// flagging per store"): pick a store for one store's file, or every store sorted by store.
// Active company, and only the caller's stores.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  const ctx = await getDataContext();
  if (!ctx || !ctx.companyId) return new Response('Not authorized for this company.', {status: 403});
  const sp = new URL(req.url).searchParams;
  const f = parseFlagFilter({store: sp.get('store'), month: sp.get('month'), source: sp.get('source'), status: sp.get('status'), q: sp.get('q')});
  let lines;
  try {
    lines = filterLines((await flagLines(ctx.companyId, Array.isArray(ctx.storeScope) ? ctx.storeScope : null)).lines, f);
  } catch (err) {
    console.error('flag-lines-export', err);
    return new Response('Could not build the file. Please try again.', {status: 500});
  }
  const name = ['flags', f.store ? `store-${f.store.replace(/[^\w-]+/g, '_')}` : 'all-stores', f.month ?? null, f.open === 'all' ? 'with-closed' : null].filter(Boolean).join('-');
  return new Response(`﻿${toCsv([EXPORT_HEAD, ...lines.map(exportRow)])}\n`, {
    headers: {'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${name}.csv"`, 'cache-control': 'no-store'},
  });
}
