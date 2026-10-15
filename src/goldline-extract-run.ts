import 'server-only';
import Anthropic from '@anthropic-ai/sdk';
import {
  buildSystemPrompt,
  buildManifestPrompt,
  buildPageDetectPrompt,
  EXTRACTION_SCHEMA,
  PAGE_DETECT_SCHEMA,
  EXTRACT_MODEL,
} from './goldline-extract';
import type {WriterProfile} from './goldline-writer-data';

// The live Claude Vision call for one scanned inventory page. Server-only; reads
// ANTHROPIC_API_KEY from the env (never the browser). The hard, reusable parts —
// the prompt, manifest, and schema — are in goldline-extract.ts and unit-tested;
// this thin wrapper is exercised end-to-end by the upload route and smoke-tested
// on Staging once the key is set.

export type ExtractedRow = {
  item_code: string;
  stockroom: number | null;
  drawer: number | null;
  selling_area: number | null;
  delivery: number | null;
  ending_on_hand: number | null;
  confidence: number;
  alt?: string | null;
};

export type ExtractedPage = {
  store_code: string;
  store_name?: string;
  period_start?: string | null;
  period_end?: string | null;
  consultant?: string | null;
  rows: ExtractedRow[];
  /** How this page was read (stamped by us, not the model): which writer profile was
   *  used, so reader accuracy can be compared before and after it. */
  reader?: {profile: boolean; reference_upload_id: string | null; notes: boolean};
};

/** True when extraction is configured; lets callers disable the PDF path cleanly. */
export function extractionConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

/** A document content block for a base64 PDF — shared by the detect + extract calls. */
function pdfDoc(pdfBase64: string) {
  return {type: 'document', source: {type: 'base64', media_type: 'application/pdf', data: pdfBase64}};
}

/** First text block of a response, JSON-parsed; throws loud on empty/invalid JSON. */
function parseJsonContent(res: {content?: Array<{type: string; text?: string}>}): unknown {
  const text = res.content?.find((b) => b.type === 'text' && typeof b.text === 'string')?.text;
  if (!text) throw new Error('Vision returned no text content');
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Vision did not return valid JSON');
  }
}

/**
 * Identify which page of the Nichido form a scan is, from its footer. Returns 1–6,
 * or 0 if it isn't a recognizable form page. A cheap, low-token call so the route can
 * pick the right manifest without asking the user which page they uploaded.
 */
export async function detectPage(pdfBase64: string): Promise<number> {
  if (!extractionConfigured()) throw new Error('ANTHROPIC_API_KEY is not set');
  const client = new Anthropic();
  const params = {
    model: EXTRACT_MODEL,
    max_tokens: 300,
    system: buildPageDetectPrompt(),
    output_config: {format: {type: 'json_schema', schema: PAGE_DETECT_SCHEMA}},
    // The user turn MUST include a text block alongside the document — a document-only
    // message is rejected (a 400 that broke ALL PDF extraction, incl. page 1).
    messages: [{role: 'user', content: [pdfDoc(pdfBase64), {type: 'text', text: 'Which page of the form is this? Return JSON only.'}]}],
  };
  // Short timeout: detect runs BEFORE extract in the same request, so their timeouts
  // must sum under the route's maxDuration. 20s (detect) + 85s (extract) = 105s < 120s.
  const res = (await client.messages.create(
    params as unknown as Parameters<typeof client.messages.create>[0],
    {timeout: 20_000},
  )) as {content?: Array<{type: string; text?: string}>};
  const parsed = parseJsonContent(res) as {page?: unknown};
  const n = typeof parsed.page === 'number' ? Math.trunc(parsed.page) : 0;
  return n >= 0 && n <= 6 ? n : 0;
}

/**
 * Read ONE scanned inventory page with Claude Vision against the fixed template.
 * Throws on: no key, a page with no manifest, no text/invalid JSON, or an `{error}`
 * response (page_mismatch / unreadable). The caller marks the upload failed and
 * surfaces the reason to the reviewer.
 */
export async function extractInventoryPage(pdfBase64: string, page: number, profile?: WriterProfile): Promise<ExtractedPage> {
  if (!extractionConfigured()) throw new Error('ANTHROPIC_API_KEY is not set');
  const system = buildSystemPrompt();
  const manifest = buildManifestPrompt(page); // throws if this page has no manifest yet

  const client = new Anthropic();
  const params = {
    model: EXTRACT_MODEL,
    // Pages 2 & 4 have ~67–68 rows; 8000 tokens truncated the JSON. 16000 covers the
    // largest page's one-object-per-item output with headroom.
    max_tokens: 16000,
    // Cached: the system prompt is the same for every page (ignored by the API if it is
    // under the model's minimum cacheable size, which is harmless).
    system: [{type: 'text', text: system, cache_control: {type: 'ephemeral'}}],
    // Structured output — the first text block is valid JSON matching the schema.
    output_config: {format: {type: 'json_schema', schema: EXTRACTION_SCHEMA}},
    // Note: no `thinking` param. Sonnet 5 rejects `{type:'disabled'}` with a 400
    // ("send {type:'between_tools'} instead"); for a pure, no-tools extraction we
    // just omit it and let the model default. Keep it omitted unless we add tools.
    messages: [{role: 'user', content: [...referenceBlocks(profile), pdfDoc(pdfBase64), {type: 'text', text: readText(manifest, profile)}]}],
  };

  // Cast through unknown: output_config/thinking are newer params and the exact SDK
  // type surface varies by version; the wire shape above follows the current docs.
  // 85s + the detect call's 20s = 105s, under the route's 160s maxDuration, so a hung
  // call throws here and the route's catch marks the upload failed — never 'processing'.
  const res = (await client.messages.create(
    params as unknown as Parameters<typeof client.messages.create>[0],
    {timeout: 85_000},
  )) as {content?: Array<{type: string; text?: string}>};

  const parsed = parseJsonContent(res);
  if (parsed && typeof parsed === 'object' && 'error' in parsed) {
    throw new Error(`Extraction declined: ${String((parsed as {error: unknown}).error)}`);
  }
  // Don't trust output_config to have been honored: validate the shape before it
  // reaches the review queue, so malformed JSON fails loud instead of persisting.
  if (!isExtractedPage(parsed)) {
    throw new Error('Extraction JSON did not match the expected page shape');
  }
  // store_code is header-only (page 1); normalize a missing/null one to '' so the
  // rest of the pipeline (and the reviewer's editable field) has a string.
  return {
    ...parsed,
    store_code: typeof parsed.store_code === 'string' ? parsed.store_code : '',
    reader: {profile: Boolean(profile?.reference || profile?.notes), reference_upload_id: profile?.reference?.uploadId ?? null, notes: Boolean(profile?.notes)},
  };
}

/** The writer's reference page (an earlier confirmed scan of the same page + its
 *  confirmed values), ahead of the page being read. Not cached: each form page of a
 *  batch gets a different reference, so a cache write would never be read back. */
function referenceBlocks(profile?: WriterProfile) {
  const ref = profile?.reference;
  if (!ref) return [];
  return [pdfDoc(ref.pdfBase64), {type: 'text', text: ref.text}];
}

/** The instruction after the page being read: writer notes (if any), then the manifest. */
function readText(manifest: string, profile?: WriterProfile): string {
  const lead = profile?.reference ? 'The scan just above is the page to read now.' : null;
  return [lead, profile?.notes ?? null, manifest].filter(Boolean).join('\n\n');
}

/** Minimal runtime guard: a rows array of {item_code} objects (store_code is optional —
 *  only page 1 has the header). */
function isExtractedPage(v: unknown): v is ExtractedPage {
  if (!v || typeof v !== 'object') return false;
  const p = v as {store_code?: unknown; rows?: unknown};
  if (p.store_code != null && typeof p.store_code !== 'string') return false;
  if (!Array.isArray(p.rows)) return false;
  return p.rows.every(
    (r) => r && typeof r === 'object' && typeof (r as {item_code?: unknown}).item_code === 'string',
  );
}
