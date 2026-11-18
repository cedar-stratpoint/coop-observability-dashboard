import {downloadUpload, goldlineConfigured} from '@/src/goldline-data';
import type {FormVersion} from '@/src/goldline-extract';
import {
  buildAnchoredParams,
  extractionConfigured,
  fetchAnchoredBatch,
  submitAnchoredBatch,
} from '@/src/goldline-extract-run';
import {getFormTemplate} from '@/src/goldline-form-template-data';
import {mapAnchoredToExtractedPage} from '@/src/goldline-anchored-extract';

// L7 BATCH-MODE COST SPIKE (removable; staging only). A one-off measurement endpoint, NOT part of
// the pump. Given an explicit list of a known scan's anchored inventory pages, it submits their
// anchored reads as a single Anthropic Message Batch (50% off, async) and reads the results back,
// so we can confirm on OUR data that batch billing halves the anchored-read cost and the output
// stays within the reader's noise floor. Guarded by GOLDLINE_L7_SPIKE_SECRET — with that env unset
// the route is a 404, so it is inert on deploy until the secret is set. Delete this file and the
// helpers in goldline-extract-run.ts once the number is recorded.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// `submit` downloads each page's PDF then makes one batch-create call; `fetch` is quick. 300s is
// ample and the batch itself runs async on Anthropic's side (minutes to <=24h), polled by `fetch`.
export const maxDuration = 300;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json'}});
}

type Page = {uploadId: string; version: FormVersion; formPage: number; pdfPage: number};

function parsePages(raw: unknown): Page[] {
  if (!Array.isArray(raw)) return [];
  const out: Page[] = [];
  for (const p of raw) {
    const o = p as Record<string, unknown>;
    const uploadId = typeof o.uploadId === 'string' ? o.uploadId : '';
    const version = o.version === 'v1' || o.version === 'v2' || o.version === 'legacy' ? (o.version as FormVersion) : null;
    const formPage = typeof o.formPage === 'number' ? o.formPage : Number(o.formPage);
    const pdfPage = typeof o.pdfPage === 'number' ? o.pdfPage : Number(o.pdfPage);
    if (uploadId && version && Number.isFinite(formPage) && Number.isFinite(pdfPage)) {
      out.push({uploadId, version, formPage, pdfPage});
    }
  }
  return out;
}

export async function POST(req: Request): Promise<Response> {
  const secret = process.env.GOLDLINE_L7_SPIKE_SECRET?.trim();
  // Env unset => the spike does not exist. Same for a wrong secret.
  if (!secret) return json({error: 'Not found.'}, 404);
  if (req.headers.get('x-goldline-l7-secret') !== secret) return json({error: 'Not found.'}, 404);
  if (!goldlineConfigured()) return json({error: 'Goldline is not configured.'}, 503);
  if (!extractionConfigured()) return json({error: 'The reader is not configured.'}, 503);

  const body = (await req.json().catch(() => null)) as {
    action?: unknown;
    company?: unknown;
    pages?: unknown;
    batchId?: unknown;
  } | null;
  const action = typeof body?.action === 'string' ? body.action : '';
  const company = typeof body?.company === 'string' && body.company ? body.company : 'goldline';
  const pages = parsePages(body?.pages);

  if (action === 'submit') {
    if (pages.length === 0) return json({error: 'pages[] is required for submit.'}, 400);
    const requests: {custom_id: string; params: unknown}[] = [];
    const skipped: {pdfPage: number; reason: string}[] = [];
    for (const p of pages) {
      const stored = await downloadUpload(company, p.uploadId);
      if (!stored) {
        skipped.push({pdfPage: p.pdfPage, reason: 'file missing'});
        continue;
      }
      const template = await getFormTemplate(company, p.version, p.formPage);
      if (!template) {
        skipped.push({pdfPage: p.pdfPage, reason: `no template for ${p.version} page ${p.formPage}`});
        continue;
      }
      const pdfBase64 = Buffer.from(stored.bytes).toString('base64');
      requests.push({custom_id: String(p.pdfPage), params: buildAnchoredParams(pdfBase64, template)});
    }
    if (requests.length === 0) return json({error: 'No pages could be prepared.', skipped}, 400);
    const batchId = await submitAnchoredBatch(requests);
    return json({batchId, submitted: requests.length, skipped});
  }

  if (action === 'fetch') {
    const batchId = typeof body?.batchId === 'string' ? body.batchId : '';
    if (!batchId) return json({error: 'batchId is required for fetch.'}, 400);
    if (pages.length === 0) return json({error: 'pages[] is required for fetch (to rebuild templates).'}, 400);
    const byPdfPage = new Map(pages.map((p) => [String(p.pdfPage), p]));
    const {status, results} = await fetchAnchoredBatch(batchId);
    if (status !== 'ended') return json({batchId, status});

    let input = 0;
    let output = 0;
    const errors: {custom_id: string; error: string}[] = [];
    const summaries: Array<{
      pdfPage: number;
      version: FormVersion;
      store: string;
      rows: number;
      filledBlanks: number;
      extras: number;
      input: number;
      output: number;
    }> = [];
    for (const r of results) {
      if (r.error || !r.output) {
        errors.push({custom_id: r.custom_id, error: r.error ?? 'no output'});
        continue;
      }
      input += r.usage?.input ?? 0;
      output += r.usage?.output ?? 0;
      const p = byPdfPage.get(r.custom_id);
      if (!p) {
        errors.push({custom_id: r.custom_id, error: 'no page mapping'});
        continue;
      }
      const template = await getFormTemplate(company, p.version, p.formPage);
      if (!template) {
        errors.push({custom_id: r.custom_id, error: 'template rebuild failed'});
        continue;
      }
      const mapped = mapAnchoredToExtractedPage(template, r.output);
      summaries.push({
        pdfPage: p.pdfPage,
        version: p.version,
        store: mapped.page.store_code,
        rows: mapped.page.rows.length,
        filledBlanks: mapped.filledBlanks,
        extras: mapped.extras,
        input: r.usage?.input ?? 0,
        output: r.usage?.output ?? 0,
      });
    }
    summaries.sort((a, b) => a.pdfPage - b.pdfPage);
    return json({
      batchId,
      status,
      totals: {pages: summaries.length, input, output, errors: errors.length},
      pages: summaries,
      errors,
    });
  }

  return json({error: "action must be 'submit' or 'fetch'."}, 400);
}
