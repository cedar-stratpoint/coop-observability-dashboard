import 'server-only';
import Anthropic from '@anthropic-ai/sdk';
import {
  buildSystemPrompt,
  buildManifestPrompt,
  buildPageDetectPrompt,
  buildPageClassifyPrompt,
  EXTRACTION_SCHEMA,
  PAGE_DETECT_SCHEMA,
  PAGE_CLASSIFY_SCHEMA,
  EXTRACT_MODEL,
  isTransientJsonMiss,
} from './goldline-extract';
import {sanitizeClassification, type PageClassification} from './goldline-segment';
import {
  buildLegacyManifestPrompt,
  LEGACY_EXTRACTION_SCHEMA,
  legacyRowToCore,
  type LegacyExtractedRow,
} from './goldline-legacy-extract';
import type {FormVersion} from './goldline-extract';
import type {WriterProfile} from './goldline-writer-data';

// The live Claude Vision call for one scanned inventory page. Server-only; reads
// GOLDLINE_ANTHROPIC_API_KEY from the env (never the browser). Goldline has its own
// key, separate from Ask Coop's ANTHROPIC_API_KEY, and deliberately does NOT fall
// back to it, so Goldline usage is never billed to Ask Coop's key. The hard, reusable parts —
// the prompt, manifest, and schema — are in goldline-extract.ts and unit-tested;
// this thin wrapper is exercised end-to-end by the upload route and smoke-tested
// on Staging once the key is set.

export type ExtractedRow = {
  item_code: string;
  // The product name as printed on this row of the paper (beside the code), transcribed
  // for cross-checking only — the displayed/stored name still comes from the manifest by
  // code. When it disagrees with the manifest name, the review shows a "Paper reads" hint
  // so a possibly-misread code or an out-of-date printed label isn't silently resolved.
  // Null/absent on scans read before this field existed.
  printed_name?: string | null;
  stockroom: number | null;
  drawer: number | null;
  selling_area: number | null;
  delivery: number | null;
  ending_on_hand: number | null;
  confidence: number;
  alt?: string | null;
  // F3 · cells the reader couldn't read cleanly, so erasures can be counted (plan §06 b).
  // `written` keeps what was on the paper when the reader chose another reading.
  marks?: CellMark[] | null;
  // Phase 1 · Legacy-only fields (beginning, begin_plus_delivery, deducted_pcs) that
  // have no three-location column; kept here so they survive into the extraction jsonb
  // (and later the inventory sidecar). Null/absent for v1/v2.
  extra?: Record<string, number | null> | null;
  // Pointer 6b · where this printed row sits on the scan, as page fractions (0 = top,
  // 1 = bottom), so "show in scan" can draw an exact box instead of the template band.
  // Null/absent for scans read before this (they fall back to the band). Cosmetic only.
  box?: {y_top: number; y_bottom: number} | null;
  // NICH-36 · the row is printed on the page but its code/name isn't in the reference
  // manifest. Kept and flagged for review (never dropped). Null/absent on known rows.
  off_manifest?: boolean | null;
};

export type CellMark = {
  field: 'stockroom' | 'drawer' | 'selling_area' | 'delivery' | 'ending_on_hand';
  mark: 'overwritten' | 'unclear' | 'straddle';
  written?: string | null;
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

/** True when extraction is configured (a primary OR fallback key is set). */
export function extractionConfigured(): boolean {
  return Boolean(process.env.GOLDLINE_ANTHROPIC_API_KEY || process.env.GOLDLINE_ANTHROPIC_API_KEY_FALLBACK);
}

type GoldlineCred = {label: string; apiKey: string; workspaceId?: string};

/** The Anthropic credentials to try, primary first then fallback. The temporary/primary
 *  key (e.g. one that expires) is `GOLDLINE_ANTHROPIC_API_KEY`; a standby is
 *  `GOLDLINE_ANTHROPIC_API_KEY_FALLBACK`. Each may carry its own workspace id (an
 *  org-scoped key must; a workspace-scoped key leaves it unset). */
function goldlineCreds(): GoldlineCred[] {
  const creds: GoldlineCred[] = [];
  const primary = process.env.GOLDLINE_ANTHROPIC_API_KEY?.trim();
  if (primary) creds.push({label: 'primary', apiKey: primary, workspaceId: process.env.GOLDLINE_ANTHROPIC_WORKSPACE_ID?.trim() || undefined});
  const fallback = process.env.GOLDLINE_ANTHROPIC_API_KEY_FALLBACK?.trim();
  if (fallback) creds.push({label: 'fallback', apiKey: fallback, workspaceId: process.env.GOLDLINE_ANTHROPIC_WORKSPACE_ID_FALLBACK?.trim() || undefined});
  return creds;
}

/** One Anthropic client for a credential set. An org-scoped key names its workspace via
 *  the anthropic-workspace-id header; a workspace-scoped key omits it. */
function clientFor(c: GoldlineCred): Anthropic {
  return new Anthropic({apiKey: c.apiKey, ...(c.workspaceId ? {defaultHeaders: {'anthropic-workspace-id': c.workspaceId}} : {})});
}

/** A KEY-level failure worth switching to the fallback key: an expired/revoked/invalid
 *  key, an out-of-credits balance, or a workspace-scope problem. NOT a transient (429 /
 *  529 / timeout) or a content error (our own page_mismatch) — those must stay on the
 *  same key, so a real reading problem isn't masked by burning the fallback's budget. */
export function isKeyLevelError(e: unknown): boolean {
  const status = (e as {status?: number} | null)?.status;
  if (status === 401 || status === 403) return true;
  const s = (e instanceof Error ? e.message : String(e ?? '')).toLowerCase();
  return /credit balance|billing|not scoped to a workspace|authentication|invalid x-api-key|x-api-key header|expired|unauthorized|permission_error/.test(s);
}

/** Send one message, trying each key in order and advancing to the next ONLY on a
 *  key-level error (expired/out-of-credits/workspace). Transient and content errors
 *  propagate from the key that hit them, unchanged, so the caller's retry/timeout logic
 *  and the real reason are preserved. Throws when no key is configured. */
async function createMessageWithFallback(
  params: unknown,
  opts: {timeout: number},
): Promise<{content?: Array<{type: string; text?: string}>}> {
  const creds = goldlineCreds();
  if (creds.length === 0) throw new Error('GOLDLINE_ANTHROPIC_API_KEY is not set');
  let lastErr: unknown;
  for (let i = 0; i < creds.length; i++) {
    const client = clientFor(creds[i]);
    try {
      return (await client.messages.create(
        params as Parameters<typeof client.messages.create>[0],
        {timeout: opts.timeout},
      )) as {content?: Array<{type: string; text?: string}>};
    } catch (e) {
      lastErr = e;
      if (i < creds.length - 1 && isKeyLevelError(e)) {
        const detail = (e instanceof Error ? e.message : String(e ?? '')).slice(0, 160);
        console.error(`goldline: Anthropic ${creds[i].label} key failed (${detail}); trying the fallback key`);
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// A couple of quick re-tries; the empty/invalid responses come back in seconds, so even
// before a real read these stay far under the route's duration budget.
const JSON_RETRY_BACKOFF_MS = [600, 1200];

/**
 * Call Vision (with key fallback) and JSON-parse its first text block, re-trying only a
 * transient empty/invalid-JSON response a few times. Observed on live scans: the model
 * occasionally returns a fast 200 with no usable text, failing a perfectly readable page
 * (read_logs: pages 23/33/57/79 that read fine on another pass). Those misses come back
 * in seconds, so retrying only them keeps a dense 150s read well within the route budget;
 * a real error (key, content, timeout, bad shape) is raised on the spot.
 */
async function visionJson(params: unknown, opts: {timeout: number; tries?: number}): Promise<unknown> {
  const tries = opts.tries ?? JSON_RETRY_BACKOFF_MS.length + 1;
  let lastErr: unknown;
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      return parseJsonContent(await createMessageWithFallback(params, {timeout: opts.timeout}));
    } catch (e) {
      lastErr = e;
      if (attempt === tries - 1 || !isTransientJsonMiss(e)) throw e;
      await sleep(JSON_RETRY_BACKOFF_MS[attempt] ?? 1200);
    }
  }
  throw lastErr;
}

/**
 * Identify which page of the Nichido form a scan is, from its footer. Returns 1–6,
 * or 0 if it isn't a recognizable form page. A cheap, low-token call so the route can
 * pick the right manifest without asking the user which page they uploaded.
 */
export async function detectPage(pdfBase64: string): Promise<number> {
  if (!extractionConfigured()) throw new Error('GOLDLINE_ANTHROPIC_API_KEY is not set');
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
  const parsed = (await visionJson(params, {timeout: 20_000})) as {page?: unknown};
  const n = typeof parsed.page === 'number' ? Math.trunc(parsed.page) : 0;
  return n >= 0 && n <= 6 ? n : 0;
}

/**
 * Phase 0 classifier for ONE shuffled scan page: page number, kind, orientation,
 * form version, and the per-page handwritten header (store / period / consultant) —
 * without transcribing counts. Feeds goldline-segment's grouping so a multi-store,
 * multi-version, rotated bundle can be sorted before extraction. Cheap, low-token,
 * and never throws on a bad read: sanitizeClassification coerces to 'unknown'/null so
 * the page still groups (and gets flagged) instead of sinking the batch.
 */
export async function classifyPage(pdfBase64: string): Promise<PageClassification> {
  if (!extractionConfigured()) throw new Error('GOLDLINE_ANTHROPIC_API_KEY is not set');
  const params = {
    model: EXTRACT_MODEL,
    // 800 (not 500): a truncated response yields unterminated JSON, which we'd rather
    // not hit at all — the classify output is tiny, so the headroom is cheap.
    max_tokens: 800,
    system: buildPageClassifyPrompt(),
    output_config: {format: {type: 'json_schema', schema: PAGE_CLASSIFY_SCHEMA}},
    // A document-only user turn is rejected (400); always pair the PDF with text.
    messages: [{role: 'user', content: [pdfDoc(pdfBase64), {type: 'text', text: 'Classify this page. Return JSON only.'}]}],
  };
  // Same 20s budget as detectPage — it replaces detect in the Phase 0 path, so the
  // request timeout math (classify + extract < route maxDuration) is unchanged.
  // Degrade, don't throw: after a couple of retries on a transient empty/invalid-JSON
  // response, a still-malformed read becomes an all-unknown classification (page 0,
  // kind/version unknown, confidence 0), so ONE unreadable page is flagged for manual
  // placement instead of sinking the whole bundle.
  try {
    return sanitizeClassification(await visionJson(params, {timeout: 20_000}));
  } catch {
    return sanitizeClassification({});
  }
}

/**
 * Read ONE scanned inventory page with Claude Vision against the fixed template.
 * Version-aware (Phase 1): V1/V2 share the three-location schema (the prompt just
 * states the Delivery-column position); LEGACY uses the 7-column deducted schema and
 * its rows are mapped to the common core {delivery, ending_on_hand} with the deducted
 * fields kept in each row's `extra` sidecar. Throws on: no key, a page with no
 * manifest, no text/invalid JSON, or an `{error}` response. The caller marks the
 * upload failed and surfaces the reason to the reviewer.
 */
export async function extractInventoryPage(
  pdfBase64: string,
  page: number,
  profile?: WriterProfile,
  version: FormVersion = 'v1',
): Promise<ExtractedPage> {
  if (!extractionConfigured()) throw new Error('GOLDLINE_ANTHROPIC_API_KEY is not set');
  const isLegacy = version === 'legacy';
  const system = buildSystemPrompt();
  // Unknown version falls back to v1 (the current default three-location layout).
  const manifest = isLegacy
    ? buildLegacyManifestPrompt(page)
    : buildManifestPrompt(page, version === 'v2' ? 'v2' : 'v1');

  const params = {
    model: EXTRACT_MODEL,
    // Pages 2 & 4 have ~67–68 rows; 8000 tokens truncated the JSON. 16000 covers the
    // largest page's one-object-per-item output with headroom.
    max_tokens: 16000,
    // Cached: the system prompt is the same for every page (ignored by the API if it is
    // under the model's minimum cacheable size, which is harmless).
    system: [{type: 'text', text: system, cache_control: {type: 'ephemeral'}}],
    // Structured output — the first text block is valid JSON matching the schema.
    output_config: {format: {type: 'json_schema', schema: isLegacy ? LEGACY_EXTRACTION_SCHEMA : EXTRACTION_SCHEMA}},
    // Note: no `thinking` param. Sonnet 5 rejects `{type:'disabled'}` with a 400
    // ("send {type:'between_tools'} instead"); for a pure, no-tools extraction we
    // just omit it and let the model default. Keep it omitted unless we add tools.
    messages: [{role: 'user', content: [...referenceBlocks(profile), pdfDoc(pdfBase64), {type: 'text', text: readText(manifest, profile)}]}],
  };

  // 150s (was 85s): the densest pages — page 4, the accessories list — measured ~85s to
  // read and were timing out at the old cap, so dense pages need more room. 20s (classify)
  // + 150s (extract) = 170s, under the route's 300s maxDuration, so a hung call throws here
  // and the route's catch marks the upload failed — never a hard platform kill.
  const parsed = await visionJson(params, {timeout: 150_000});
  if (parsed && typeof parsed === 'object' && 'error' in parsed) {
    throw new Error(`Extraction declined: ${String((parsed as {error: unknown}).error)}`);
  }

  // Legacy: validate + map its deducted rows into the common core shape before the
  // usual guard, so the rest of the pipeline sees a normal ExtractedPage.
  if (isLegacy) {
    if (!isLegacyPage(parsed)) {
      throw new Error('Extraction JSON did not match the expected Legacy page shape');
    }
    const p = parsed as LegacyPage;
    return {
      store_code: typeof p.store_code === 'string' ? p.store_code : '',
      store_name: p.store_name ?? undefined,
      period_start: p.period_start ?? null,
      period_end: p.period_end ?? null,
      consultant: p.consultant ?? null,
      rows: p.rows.map(legacyRowToCore),
      reader: {profile: Boolean(profile?.reference || profile?.notes), reference_upload_id: profile?.reference?.uploadId ?? null, notes: Boolean(profile?.notes)},
    };
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

/** The raw Legacy page shape (header + legacy rows) before mapping to core. */
type LegacyPage = {
  store_code?: string | null;
  store_name?: string | null;
  period_start?: string | null;
  period_end?: string | null;
  consultant?: string | null;
  rows: LegacyExtractedRow[];
};

/** Runtime guard for a Legacy extraction: a rows array of {item_code} objects. */
function isLegacyPage(v: unknown): v is LegacyPage {
  if (!v || typeof v !== 'object') return false;
  const p = v as {store_code?: unknown; rows?: unknown};
  if (p.store_code != null && typeof p.store_code !== 'string') return false;
  if (!Array.isArray(p.rows)) return false;
  return p.rows.every((r) => r && typeof r === 'object' && typeof (r as {item_code?: unknown}).item_code === 'string');
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
