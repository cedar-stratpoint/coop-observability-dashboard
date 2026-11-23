import {revalidatePath} from 'next/cache';
import {auth} from '@/auth';
import {getDataContext} from '@/src/active-context';
import {canEditData} from '@/src/company';
import {createPoFormDraft, PoFormError} from '@/src/goldline-po-form-data';
import {PoFormFileError, readPoFormXlsx} from '@/src/goldline-po-form-xlsx';
import {transcribePoFormPdf} from '@/src/goldline-po-form-pdf';
import {nichidoConfigured} from '@/src/nichido-client';

// Upload a PO form (NICH-17, PO leg): one .xlsx or .pdf in the multipart field `file`,
// for the active company (?company=<slug>). The file is read into a DRAFT; an admin
// reviews it on /stock/po-form and activates it there. Company-wide editors only: the PO
// form decides which products are active for every store.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300; // a scanned PDF goes through one Claude read

const MAX_BYTES = 15 * 1024 * 1024;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json'}});
}

export async function POST(req: Request): Promise<Response> {
  const ctx = await getDataContext(new URL(req.url).searchParams.get('company'));
  if (!ctx || !ctx.companyId) return json({error: 'Not authorized for this company.'}, 403);
  if (!canEditData(ctx.role)) return json({error: 'Your role can’t upload data.'}, 403);
  if (ctx.storeScope) return json({error: 'Only company-wide roles can change the PO form.'}, 403);
  if (!nichidoConfigured()) return json({error: 'The database is not connected on this environment.'}, 503);

  let file: File | null = null;
  try {
    const form = await req.formData();
    const f = form.get('file');
    file = f instanceof File ? f : null;
  } catch {
    return json({error: 'No file was received.'}, 400);
  }
  if (!file || !file.size) return json({error: 'No file was received.'}, 400);
  if (file.size > MAX_BYTES) return json({error: 'That file is over 15 MB.'}, 413);
  const name = file.name || 'po-form';
  const kind = /\.xlsx$/i.test(name) ? 'xlsx' : /\.pdf$/i.test(name) ? 'pdf' : null;
  if (!kind) return json({error: 'Upload the PO form as an Excel (.xlsx) or PDF file.'}, 415);

  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const cells = kind === 'xlsx' ? await readPoFormXlsx(bytes) : await transcribePoFormPdf(bytes);
    const session = await auth();
    const out = await createPoFormDraft(ctx.companyId, {
      fileName: name,
      kind,
      bytes,
      contentType: kind === 'xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'application/pdf',
      cells,
      by: session?.user?.email ?? null,
    });
    revalidatePath('/stock/po-form');
    return json({ok: true, ...out});
  } catch (err) {
    if (err instanceof PoFormFileError || err instanceof PoFormError) return json({error: err.message}, 422);
    console.error('po-form upload', err);
    return json({error: 'The PO form could not be read. Please try again.'}, 500);
  }
}
