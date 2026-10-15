import {notFound, redirect} from 'next/navigation';
import {getDataContext} from '@/src/active-context';
import {canEditData} from '@/src/company';
import {catalogForCodes, formPageStrip, getBatch, getExtraction, getUpload, listStores} from '@/src/goldline-data';
import {MANIFESTS} from '@/src/goldline-extract';
import {committedSnapshotFor} from '@/src/goldline-inventory-data';
import {UploadReview} from '@/components/analyst/upload-review';

export const dynamic = 'force-dynamic';

// Per-file review page. A scanned inventory PDF opens the review workbench (the
// staged Claude Vision extraction, editable before commit); a sales CSV has no
// extraction, so it shows a status summary. Scoped to the active company — a
// mismatched id (or another tenant's) resolves to notFound().
export default async function Page(props: {params: Promise<{id: string}>}) {
  const {id} = await props.params;
  const ctx = await getDataContext();
  if (!ctx || !ctx.companyId) {
    return (
      <div className="mx-auto flex min-h-[50vh] max-w-md flex-col items-center justify-center gap-2 text-center">
        <h1 className="font-heading text-lg font-semibold">No company in view</h1>
        <p className="text-sm text-muted-foreground">Sign in to a company you belong to to review uploads.</p>
      </div>
    );
  }
  const upload = await getUpload(ctx.companyId, id);
  if (!upload) notFound();
  // A page waiting for review inside an open batch is reviewed WITH its batch: one
  // place for the store, period, every page and the commit, whichever way you got here
  // (a file in the batch, the Files list, a page link). Committed, failed and
  // single-file uploads keep this page.
  if (upload.kind === 'inventory_pdf' && upload.status === 'needs_review' && upload.batch_id) {
    const batch = await getBatch(ctx.companyId, upload.batch_id);
    if (batch?.status === 'open') redirect(`/uploads/batch/${batch.id}?page=${upload.id}`);
  }
  const extraction = upload.kind === 'inventory_pdf' ? await getExtraction(ctx.companyId, id) : null;
  // Same-origin proxy (streams the private file) so the browser can embed it in an
  // <iframe> under the app CSP; null when there's no stored file.
  const scanUrl = upload.storage_path ? `/api/goldline/uploads/${upload.id}/file` : null;
  // Product names come from the detected page's manifest (item_code → printed product),
  // so the reviewer sees names next to the codes.
  const productNames: Record<string, string> = {};
  for (const item of MANIFESTS[extraction?.page ?? 0] ?? []) productNames[item.code] = item.product;
  // Once committed, link straight to the store + period this scan fed in Inventory.
  const snap = upload.status === 'committed' ? await committedSnapshotFor(ctx.companyId, upload.id) : null;
  const inventoryHref = snap
    ? `/stock?store=${encodeURIComponent(snap.store_code)}&period=${snap.period_start}_${snap.period_end}`
    : null;
  // Catalog line + price for this page's items (form grid, totals check) and the
  // latest scan of each form page (page strip). Only for a scan with an extraction.
  const codes = extraction?.data?.rows?.map((r) => r.item_code) ?? [];
  const [catalog, pageStrip, stores] = extraction
    ? await Promise.all([catalogForCodes(ctx.companyId, codes), formPageStrip(ctx.companyId, upload.id), listStores(ctx.companyId)])
    : [{}, null, []];
  return (
    <UploadReview
      company={ctx.companyId}
      canEdit={canEditData(ctx.role)}
      upload={upload}
      extraction={extraction}
      scanUrl={scanUrl}
      productNames={productNames}
      inventoryHref={inventoryHref}
      catalog={catalog}
      pageStrip={pageStrip}
      stores={stores}
    />
  );
}
