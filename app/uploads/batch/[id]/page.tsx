import {notFound} from 'next/navigation';
import {getDataContext} from '@/src/active-context';
import {canEditData} from '@/src/company';
import {catalogForCodes, getBatch, getBatchPages, listStores} from '@/src/goldline-data';
import {MANIFESTS} from '@/src/goldline-extract';
import {orderPages} from '@/src/upload-batch';
import {BatchReview, type BatchReviewPage} from '@/components/analyst/batch-review';

export const dynamic = 'force-dynamic';

// Review one upload batch — a store's inventory form for one period — and commit every
// page into one Inventory count. Company-scoped: another tenant's batch id is a 404.
export default async function Page(props: {params: Promise<{id: string}>; searchParams: Promise<{page?: string}>}) {
  const {id} = await props.params;
  const {page: openPage} = await props.searchParams;
  const ctx = await getDataContext();
  if (!ctx || !ctx.companyId) {
    return (
      <div className="mx-auto flex min-h-[50vh] max-w-md flex-col items-center justify-center gap-2 text-center">
        <h1 className="font-heading text-lg font-semibold">No company in view</h1>
        <p className="text-sm text-muted-foreground">Pick a company you belong to to review its uploads.</p>
      </div>
    );
  }
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const batch = await getBatch(ctx.companyId, id);
  if (!batch) notFound();

  const raw = await getBatchPages(ctx.companyId, id);
  const pdfPages = raw.filter((p) => p.upload.kind === 'inventory_pdf');
  const codes = [...new Set(pdfPages.flatMap((p) => p.extraction?.data?.rows?.map((r) => r.item_code) ?? []))];
  const [catalog, stores] = await Promise.all([catalogForCodes(ctx.companyId, codes), listStores(ctx.companyId)]);

  const pages: BatchReviewPage[] = orderPages(
    pdfPages.map((p) => {
      const pageNo = p.extraction?.page ?? null;
      const names: Record<string, string> = {};
      for (const item of MANIFESTS[pageNo ?? 0] ?? []) names[item.code] = item.product;
      return {
        page: pageNo,
        upload: p.upload,
        extraction: p.extraction,
        productNames: names,
        scanUrl: p.upload.storage_path ? `/api/goldline/uploads/${p.upload.id}/file` : null,
      };
    }),
  );
  // Page 1 prints the store + period — use it when the batch fields are still empty.
  const header = pages.find((p) => p.page === 1)?.extraction?.data;

  return (
    <BatchReview
      company={ctx.companyId}
      canEdit={canEditData(ctx.role)}
      batch={batch}
      defaults={{
        storeCode: batch.store_code ?? header?.store_code ?? '',
        periodStart: batch.period_start ?? header?.period_start ?? '',
        periodEnd: batch.period_end ?? header?.period_end ?? '',
        consultant: header?.consultant ?? null,
      }}
      pages={pages}
      catalog={catalog}
      stores={stores}
      initialPageId={typeof openPage === 'string' ? openPage : null}
      otherFiles={raw.filter((p) => p.upload.kind !== 'inventory_pdf').map((p) => p.upload)}
    />
  );
}
