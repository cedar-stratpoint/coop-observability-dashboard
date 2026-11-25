import {getDataContext} from '@/src/active-context';
import {auditExport} from '@/src/goldline-audit-data';
import {WHY_LABEL} from '@/src/goldline-audit';
import {toCsv} from '@/src/csv';

// The reconcile table as a CSV: every line the page's query matches (not just the page
// shown), for the active company and only the caller's stores. Streamed, because every
// store's lines can run past the platform's response size limit.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const CHUNK = 1000;
const HEAD = ['Store code', 'Store', 'Item code', 'Product', 'Recommendation', 'Watsons', 'Inventory', 'PO', 'Units sold', 'On hand', 'Not known because', 'Either'];
const LETTER = {yes: 'Y', no: 'X', unknown: '?'} as const;

export async function GET(req: Request): Promise<Response> {
  const ctx = await getDataContext();
  if (!ctx || !ctx.companyId) return new Response('Not authorized for this company.', {status: 403});
  const sp = new URL(req.url).searchParams;
  const get = (k: string) => sp.get(k);
  let out: Awaited<ReturnType<typeof auditExport>>;
  try {
    out = await auditExport(ctx.companyId, {store: get('store'), month: get('month'), state: get('state'), why: get('why'), q: get('q'), sort: get('sort'), dir: get('dir')}, ctx.storeScope ?? null);
  } catch (err) {
    console.error('audit-export', err);
    return new Response('Could not build the file. Please try again.', {status: 500});
  }
  if (!out) return new Response('Nothing to export.', {status: 404});

  const {rows, month, code} = out;
  const enc = new TextEncoder();
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    start(ctrl) {
      ctrl.enqueue(enc.encode(`﻿${toCsv([HEAD])}\n`));
    },
    pull(ctrl) {
      if (i >= rows.length) return ctrl.close();
      const part = rows.slice(i, i + CHUNK).map((r) => [
        r.store,
        r.storeName ?? '',
        r.item_code,
        r.product ?? '',
        r.reco,
        LETTER[r.watsons],
        LETTER[r.inventory],
        LETTER[r.po],
        r.units ?? '',
        r.onHand ?? '',
        r.why.map((w) => WHY_LABEL[w]).join('; '),
        r.between.join(' or '),
      ]);
      i += CHUNK;
      ctrl.enqueue(enc.encode(`${toCsv(part)}\n`));
    },
  });
  const safe = code.replace(/[^\w-]+/g, '_').slice(0, 40);
  return new Response(body, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="reconcile-${safe}-${month}.csv"`,
      'cache-control': 'no-store',
    },
  });
}
