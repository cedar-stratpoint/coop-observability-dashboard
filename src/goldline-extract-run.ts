import {cleanHeaders, HEADERS_PROMPT_LINES, withHeadersSchema, type ReaderFlag} from './goldline-reader-marks';
import 'server-only';
import {AsyncLocalStorage} from 'node:async_hooks';
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
  withLegacyMarksSchema,
  legacyBandCheck,
  legacyPageToCore,
  type LegacyExtractedRow,
  type FamilyTotal,
} from './goldline-legacy-extract';
import {printedPageItems} from './goldline-printed-page';
import {checkBands, type PaperBand} from './band-prices';
import {type OutOfStock} from './out-of-stock';
import {applyPageOutOfStock} from './printed-os';
import type {FormVersion} from './goldline-extract';
import type {WriterProfile} from './goldline-writer-data';
import {
  ANCHORED_EXTRACTION_SCHEMA,
  ANCHORED_EXTRACTION_SCHEMA_P1,
  DELIVERY_LOCATOR_SCHEMA,
  buildAnchoredPrompt,
  buildAnchoredSystemPrompt,
  buildAnchoredPromptP1,
  withUnsureSchema,
  withMarksSchema,
  buildAnchoredSystemPromptP1,
  buildDeliveryLocatorPrompt,
  anchoredSchemaFor,
  versionFromLocator,
  type LocatedVersion,
  mapAnchoredOutput,
  type AnchoredMapResult,
  type AnchoredOutput,
  type DeliveryLocatorOutput,
} from './goldline-anchored-extract';
import type {FormTemplate} from './goldline-form-template';
import {HEADER_CROPS_NOTE, type PageBlock} from './goldline-page-bands';
import {readMarksEnabled, readP1Enabled, readUnsureEnabled} from './goldline-anchored-flag';

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
  // NICH-36 · what the reader saw besides the counts (GOLDLINE_READ_MARKS): a BA note or revision
  // on the row, or "Damage" written in a count. Written as review flags; never the note's text.
  reader_flags?: ReaderFlag[] | null;
  // QA Nov 25 · "O/S" written on the row: the cells it set to 0 (tagged in review, kept as
  // inventory.extra.out_of_stock), and whether the row wants a look.
  oos?: OutOfStock | null;
  // Audit Nov 25 · "O/S" printed on the form for this row: not a BA's mark and not a count.
  os_printed?: boolean | null;
  // NICH-42 · a product the reviewer added on the review screen (hand-written by the BA, not
  // printed or not read). Browser-only: never set by the reader, commits like any row.
  added?: boolean;
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
  /** The page's slant (degrees, and the pivot as a fraction of the width), stored with the row boxes
   *  so review tilts the box with the paper. Absent on pages read without boxes. Cosmetic only. */
  slant?: {angle: number; px: number} | null;
  /** NICH-36 · printed column headers the BA wrote their own names over (GOLDLINE_READ_MARKS). */
  headers_written_over?: string[] | null;
  /** Legacy only: how the page's columns were used, from its own arithmetic (PR #685). 'locations'
   *  = col1 to col3 filed as Stockroom / Drawer / Selling, i.e. the BA repurposed the printed columns. */
  legacy_layout?: 'locations' | 'printed' | null;
  /** Each heading band's paper total and written price, and whether the paper points at another
   *  price than the printed one (QA Nov 25). Absent on pages read before then. */
  bands?: PaperBand[] | null;
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

/** The primary Goldline reader client (null when no key is set). For one-off reads
 *  outside the scan pipeline, e.g. transcribing a PO form PDF. */
export function goldlineReaderClient(): Anthropic | null {
  const c = goldlineCreds()[0];
  return c ? clientFor(c) : null;
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

// Token-usage accounting for one page read, so each read_logs row can carry the Claude
// cost of the page (there is NO per-read usage anywhere else: the Anthropic console only
// aggregates a whole workspace by day). Kept in an AsyncLocalStorage, not a module global,
// because Fluid Compute reuses one instance across CONCURRENT reads — a global would mix two
// pages' tokens together. `createMessageWithFallback` (the single Anthropic call site, two
// levels below the pipeline) adds each call's usage to the active page's tally; the pipeline
// opens a tally with `withReadUsage` and snapshots it onto every log row.
export type ReadUsage = {input: number; output: number; cacheRead: number; cacheCreate: number; calls: number};
const usageStore = new AsyncLocalStorage<ReadUsage>();

/** Run `fn` with a fresh per-page token tally active (so nested Anthropic calls record into it). */
export function withReadUsage<T>(fn: () => Promise<T>): Promise<T> {
  return usageStore.run({input: 0, output: 0, cacheRead: 0, cacheCreate: 0, calls: 0}, fn);
}

/** A copy of the current page's token tally (or null outside a `withReadUsage` scope). */
export function readUsageSnapshot(): ReadUsage | null {
  const u = usageStore.getStore();
  return u ? {...u} : null;
}

/** Fold one Anthropic response's `usage` into the active page tally (no-op outside a scope). */
function recordUsage(usage: unknown): void {
  const u = usageStore.getStore();
  if (!u || !usage || typeof usage !== 'object') return;
  const x = usage as {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  u.input += x.input_tokens ?? 0;
  u.output += x.output_tokens ?? 0;
  u.cacheRead += x.cache_read_input_tokens ?? 0;
  u.cacheCreate += x.cache_creation_input_tokens ?? 0;
  u.calls += 1;
}

/** Send one message, trying each key in order and advancing to the next ONLY on a
 *  key-level error (expired/out-of-credits/workspace). Transient and content errors
 *  propagate from the key that hit them, unchanged, so the caller's retry/timeout logic
 *  and the real reason are preserved. Throws when no key is configured. */
async function createMessageWithFallback(
  params: unknown,
  opts: {timeout: number},
): Promise<{content?: Array<{type: string; text?: string}>; stop_reason?: string | null}> {
  const creds = goldlineCreds();
  if (creds.length === 0) throw new Error('GOLDLINE_ANTHROPIC_API_KEY is not set');
  let lastErr: unknown;
  for (let i = 0; i < creds.length; i++) {
    const client = clientFor(creds[i]);
    try {
      // Stream (then collect the final message) rather than a plain create: with the extract's
      // raised max_tokens, Anthropic rejects a NON-streaming request outright ("Streaming is
      // required for operations that may take longer than 10 minutes"). Streaming lifts that cap
      // and the final message is identical in shape (content + stop_reason). The route's 600s
      // maxDuration still bounds the whole read.
      const message = (await client.messages
        .stream(params as Parameters<typeof client.messages.stream>[0], {timeout: opts.timeout})
        .finalMessage()) as {
        content?: Array<{type: string; text?: string}>;
        stop_reason?: string | null;
        usage?: unknown;
      };
      recordUsage(message.usage);
      return message;
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

/** First text block of a response, JSON-parsed; throws loud on empty/invalid JSON. When the
 *  model stopped because it hit `max_tokens`, the JSON is truncated, not malformed: that is a
 *  distinct, non-transient failure (the page has more rows than one pass can return), so it
 *  gets its own message and is NOT retried (a retry would truncate at the same place). */
function parseJsonContent(res: {content?: Array<{type: string; text?: string}>; stop_reason?: string | null}): unknown {
  const text = res.content?.find((b) => b.type === 'text' && typeof b.text === 'string')?.text;
  if (!text) throw new Error('Vision returned no text content');
  try {
    return JSON.parse(text);
  } catch {
    if (res.stop_reason === 'max_tokens') {
      throw new Error('Vision output was truncated: the page has more rows than the extractor can return in one pass.');
    }
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
 * L1 cost lever (flagged, default OFF). GOLDLINE_READ_EFFORT ∈ low|medium|high|xhigh|max
 * sets output_config.effort on the inventory read (Sonnet 5.5 defaults to high), so the
 * read "thinks less" and bills fewer output tokens — output is ~68% of the per-run cost.
 * GOLDLINE_READ_THINKING=between_tools additionally turns thinking off (Sonnet 5.5 rejects
 * {type:'disabled'}; between_tools is accepted only at effort high or below). Unset = today's
 * behavior, so a cost A/B is a pure env toggle that reverts instantly. Scoped to
 * extractInventoryPage, the output-heavy call.
 */
const READ_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
function readEffort(): string | undefined {
  const v = (process.env.GOLDLINE_READ_EFFORT ?? '').trim().toLowerCase();
  return READ_EFFORTS.has(v) ? v : undefined;
}
/** between_tools is valid only at effort high or below, so refuse it at xhigh/max (would 400). */
function readThinkingOff(effort: string | undefined): boolean {
  const on = (process.env.GOLDLINE_READ_THINKING ?? '').trim().toLowerCase() === 'between_tools';
  return on && effort !== 'xhigh' && effort !== 'max';
}

/**
 * L2 + L3 cost levers for the cheap vision calls (classify + detect) — flagged, default OFF,
 * and never touching the inventory read's numbers (that call stays on EXTRACT_MODEL / Sonnet).
 *  - L3: GOLDLINE_CHEAP_READ_MODEL (e.g. "claude-haiku-5-5") runs classify + detect on a cheaper
 *    model; unset = EXTRACT_MODEL (today's behavior).
 *  - L2: GOLDLINE_CACHE_CHEAP_READS=1 caches their (identical-every-page) system prompt via
 *    cache_control — a free input-token win, ignored by the API if the prompt is under the
 *    cacheable minimum, so it is harmless when it does not help.
 */
function cheapReadModel(): string {
  const v = (process.env.GOLDLINE_CHEAP_READ_MODEL ?? '').trim();
  return v || EXTRACT_MODEL;
}
function cheapSystem(text: string): string | Array<{type: string; text: string; cache_control?: {type: string}}> {
  return (process.env.GOLDLINE_CACHE_CHEAP_READS ?? '').trim() === '1'
    ? [{type: 'text', text, cache_control: {type: 'ephemeral'}}]
    : text;
}

/**
 * L6 (safe variant) cost lever — flagged, default OFF. GOLDLINE_CHEAP_READ_DOWNSCALE = a render
 * scale (e.g. "1.4") sends the CHEAP calls (classify + locator) a downscaled PNG of the page
 * instead of the full PDF. Those calls read PRINTED text (page number, store header, column
 * labels), which survives a smaller image; the handwriting read keeps the full-resolution PDF, so
 * digit accuracy is untouched. Scans carry no text layer, so an image loses nothing vs the PDF.
 * Fail-safe: any render error returns null and the caller falls back to the PDF block, so a bad
 * render never breaks a read.
 */
function cheapDownscaleScale(): number | null {
  const v = parseFloat((process.env.GOLDLINE_CHEAP_READ_DOWNSCALE ?? '').trim());
  return Number.isFinite(v) && v > 0 && v <= 4 ? v : null;
}

function imageDoc(base64: string, mediaType: string) {
  return {type: 'image', source: {type: 'base64', media_type: mediaType, data: base64}};
}

/** Render a single-page PDF to a downscaled PNG block for a cheap call, or null on any failure
 *  (caller falls back to the full PDF). Dynamic import so the renderer only loads when the lever
 *  is on, and never breaks the build or a flag-off read. */
async function cheapPageImage(pdfBase64: string): Promise<ReturnType<typeof imageDoc> | null> {
  const scale = cheapDownscaleScale();
  if (!scale) return null;
  try {
    const {pdf} = await import('pdf-to-img');
    const doc = await pdf(Buffer.from(pdfBase64, 'base64'), {scale});
    for await (const page of doc) {
      return imageDoc(page.toString('base64'), 'image/png');
    }
    return null;
  } catch (e) {
    console.error('goldline: cheap-read downscale render failed, using full PDF', e instanceof Error ? e.message : String(e));
    return null;
  }
}

/** The page content block for a cheap call: a downscaled PNG when the lever is on and rendering
 *  succeeds, else the full PDF document block (today's behavior). */
async function cheapPageBlock(pdfBase64: string): Promise<ReturnType<typeof imageDoc> | ReturnType<typeof pdfDoc>> {
  return (await cheapPageImage(pdfBase64)) ?? pdfDoc(pdfBase64);
}

/**
 * Identify which page of the Nichido form a scan is, from its footer. Returns 1–6,
 * or 0 if it isn't a recognizable form page. A cheap, low-token call so the route can
 * pick the right manifest without asking the user which page they uploaded.
 */
export async function detectPage(pdfBase64: string): Promise<number> {
  if (!extractionConfigured()) throw new Error('GOLDLINE_ANTHROPIC_API_KEY is not set');
  const params = {
    model: cheapReadModel(),
    max_tokens: 300,
    system: cheapSystem(buildPageDetectPrompt()),
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
export async function classifyPage(pdfBase64: string, headerCrops?: PageBlock[] | null): Promise<PageClassification> {
  if (!extractionConfigured()) throw new Error('GOLDLINE_ANTHROPIC_API_KEY is not set');
  const pageBlock = await cheapPageBlock(pdfBase64);
  const params = {
    model: cheapReadModel(),
    // 2000: a truncated response yields unterminated JSON, which degrades to an all-unknown
    // classification and sets a real form page aside. 800 was hit on prod (Nov 24, 2 of 163
    // pages, output exactly 800); billed on actual output, so the headroom is cheap.
    max_tokens: 2000,
    system: cheapSystem(buildPageClassifyPrompt()),
    output_config: {format: {type: 'json_schema', schema: PAGE_CLASSIFY_SCHEMA}},
    // A document-only user turn is rejected (400); always pair the PDF with text.
    // Header crops (GOLDLINE_HEADER_CROP_COMPANIES): sharp 300 dpi top/bottom edges after the page,
    // so the handwritten store code and name are read from a legible image. Absent = as before.
    messages: [
      {
        role: 'user',
        content: headerCrops?.length
          ? [pageBlock, ...headerCrops, {type: 'text', text: `${HEADER_CROPS_NOTE}\nClassify this page. Return JSON only.`}]
          : [pageBlock, {type: 'text', text: 'Classify this page. Return JSON only.'}],
      },
    ],
  };
  // Same 20s budget as detectPage — it replaces detect in the Phase 0 path, so the
  // request timeout math (classify + extract < route maxDuration) is unchanged.
  // Degrade, don't throw: after a couple of retries on a transient empty/invalid-JSON
  // response, a still-malformed read becomes an all-unknown classification (page 0,
  // kind/version unknown, confidence 0), so ONE unreadable page is flagged for manual
  // placement instead of sinking the whole bundle.
  try {
    return sanitizeClassification(await visionJson(params, {timeout: headerCrops?.length ? 30_000 : 20_000}));
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
/** The request body for one free (non-anchored) inventory read: Legacy, or V1/V2 when the template
 *  read is off. Extracted so the same body can be sent inline or packed into a Message Batch.
 *  `pageBlocks` (sharper page images) replace the PDF block when given; absent = the PDF, as before. */
export function buildInventoryReadParams(
  pdfBase64: string,
  page: number,
  profile?: WriterProfile,
  version: FormVersion = 'v1',
  pageBlocks?: PageBlock[] | null,
) {
  const isLegacy = version === 'legacy';
  const system = buildSystemPrompt();
  // Unknown version falls back to v1 (the current default three-location layout).
  // Reader review flags (NICH-36) ride on the Legacy read; the free V1/V2 read is unchanged.
  const marks = isLegacy && readMarksEnabled();
  // QA Nov 26: the free V1/V2 read (a page whose version wasn't proven) also says which printed
  // headers the BA wrote over, so "Columns changed" isn't limited to the anchored read.
  const headers = !isLegacy && readMarksEnabled();
  const manifest = isLegacy
    ? buildLegacyManifestPrompt(page, {marks})
    : [buildManifestPrompt(page, version === 'v2' ? 'v2' : 'v1'), ...(headers ? HEADERS_PROMPT_LINES : [])].join('\n');

  // L1 cost lever (flagged, default off): lower effort / thinking off to cut output tokens.
  const effort = readEffort();
  const thinkingOff = readThinkingOff(effort);
  const params = {
    model: EXTRACT_MODEL,
    // One JSON object per inventory row, so output scales with row count. The cap has climbed
    // with the pages we met: 8000 truncated dense pages, 16000 covered most, 32000 covered all
    // but the very densest (a real scan page measured 32105 output tokens and truncated). 64000
    // clears those too and is still only half the model's 128K output ceiling. This is purely a
    // CEILING: a normal page generates far fewer tokens and is byte-for-byte unchanged (same
    // output, same cost) — only a page that would otherwise truncate is affected. A page still
    // exceeding it surfaces a clear "truncated" error, not a silent invalid-JSON retry loop
    // (see parseJsonContent). Streaming (createMessageWithFallback) is what makes a cap this
    // high usable: a non-streaming call is rejected once max_tokens could run past 10 minutes.
    max_tokens: 64000,
    // Cached: the system prompt is the same for every page (ignored by the API if it is
    // under the model's minimum cacheable size, which is harmless).
    system: [{type: 'text', text: system, cache_control: {type: 'ephemeral'}}],
    // Structured output — the first text block is valid JSON matching the schema.
    // output_config.effort is added only when GOLDLINE_READ_EFFORT is set (L1); otherwise
    // the model's default effort (high) stands, i.e. today's behavior.
    output_config: {
      format: {type: 'json_schema', schema: isLegacy ? (marks ? withLegacyMarksSchema(LEGACY_EXTRACTION_SCHEMA) : LEGACY_EXTRACTION_SCHEMA) : headers ? withHeadersSchema(EXTRACTION_SCHEMA) : EXTRACTION_SCHEMA},
      ...(effort ? {effort} : {}),
    },
    // No `thinking` param by default. Sonnet 5.5 rejects `{type:'disabled'}` with a 400
    // ("send {type:'between_tools'} instead"); the L1 thinking-off path sends between_tools,
    // which readThinkingOff() only allows at effort high or below. Omitted otherwise.
    ...(thinkingOff ? {thinking: {type: 'between_tools'}} : {}),
    messages: [{role: 'user', content: [...referenceBlocks(profile), ...(pageBlocks?.length ? pageBlocks : [pdfDoc(pdfBase64)]), {type: 'text', text: readText(manifest, profile)}]}],
  };
  return params;
}

export async function extractInventoryPage(
  pdfBase64: string,
  page: number,
  profile?: WriterProfile,
  version: FormVersion = 'v1',
  pageBlocks?: PageBlock[] | null,
): Promise<ExtractedPage> {
  if (!extractionConfigured()) throw new Error('GOLDLINE_ANTHROPIC_API_KEY is not set');
  const params = buildInventoryReadParams(pdfBase64, page, profile, version, pageBlocks);

  // 150s (was 85s): the densest pages — page 4, the accessories list — measured ~85s to
  // read and were timing out at the old cap, so dense pages need more room. 20s (classify)
  // + 150s (extract) = 170s, under the route's 300s maxDuration, so a hung call throws here
  // and the route's catch marks the upload failed — never a hard platform kill.
  const parsed = await visionJson(params, {timeout: 150_000});
  return mapInventoryRead(parsed, page, profile, version);
}

/** Validate + map one free-read output to an ExtractedPage (Legacy rows mapped to the core shape).
 *  Shared by the inline read and the batch poller. */
export function mapInventoryRead(parsed: unknown, page: number, profile?: WriterProfile, version: FormVersion = 'v1'): ExtractedPage {
  const isLegacy = version === 'legacy';
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
    const {rows, layout} = legacyPageToCore(p.rows, page);
    const headersOver = cleanHeaders((p as {headers_written_over?: unknown}).headers_written_over);
    // Band totals (written per heading band) catch misreads that still add up within a row.
    const totals = Array.isArray(p.family_totals) ? p.family_totals : [];
    const printed = printedPageItems('legacy', page);
    legacyBandCheck(rows, printed, totals);
    // Saved with the page: each band's paper total and written price, flagged when they point at
    // another price than the printed one (36 x 180 = 6,480 on a printed ₱225 band).
    const bands = checkBands(printed, rows, totals);
    return {
      ...(bands.length ? {bands} : {}),
      ...(headersOver.length ? {headers_written_over: headersOver} : {}),
      legacy_layout: layout,
      store_code: typeof p.store_code === 'string' ? p.store_code : '',
      store_name: p.store_name ?? undefined,
      period_start: p.period_start ?? null,
      period_end: p.period_end ?? null,
      consultant: p.consultant ?? null,
      rows,
      reader: {profile: Boolean(profile?.reference || profile?.notes), reference_upload_id: profile?.reference?.uploadId ?? null, notes: Boolean(profile?.notes)},
    };
  }

  // Don't trust output_config to have been honored: validate the shape before it
  // reaches the review queue, so malformed JSON fails loud instead of persisting.
  if (!isExtractedPage(parsed)) {
    throw new Error('Extraction JSON did not match the expected page shape');
  }
  // "O/S" (QA Nov 25): printed on the form = a quiet note; one a BA wrote = 0 in that cell.
  applyPageOutOfStock(parsed.rows, {version, page, layout: version === 'v2' ? 'v2' : 'v1'});
  const headersOver = cleanHeaders((parsed as {headers_written_over?: unknown}).headers_written_over);
  // store_code is header-only (page 1); normalize a missing/null one to '' so the
  // rest of the pipeline (and the reviewer's editable field) has a string.
  return {
    ...parsed,
    headers_written_over: headersOver.length ? headersOver : undefined,
    store_code: typeof parsed.store_code === 'string' ? parsed.store_code : '',
    reader: {profile: Boolean(profile?.reference || profile?.notes), reference_upload_id: profile?.reference?.uploadId ?? null, notes: Boolean(profile?.notes)},
  };
}

/**
 * Template-anchored read of ONE scanned inventory page (V1/V2 only; Legacy already reads this
 * way via its own path). The model is given the page's fixed template rows and returns only the
 * handwritten numbers by row index; `mapAnchoredToExtractedPage` then rebuilds the full page from
 * the template, so no row is dropped or invented. Numbers-only output, so `max_tokens` is small.
 * Throws on no key or an empty read, like `extractInventoryPage`.
 */
export async function extractInventoryPageAnchored(
  pdfBase64: string,
  template: FormTemplate,
  profile?: WriterProfile,
  pageBlocks?: PageBlock[] | null,
): Promise<AnchoredMapResult> {
  if (!extractionConfigured()) throw new Error('GOLDLINE_ANTHROPIC_API_KEY is not set');
  const params = buildAnchoredParams(pdfBase64, template, profile, pageBlocks);
  const parsed = (await visionJson(params, {timeout: 150_000})) as AnchoredOutput;
  if (!parsed || !Array.isArray(parsed.rows)) {
    throw new Error('Anchored read returned no rows');
  }
  return mapAnchoredOutput(template, parsed);
}

/** The request body for ONE anchored read (model, system, numbers-only schema, page + prompt).
 *  Extracted so the same body can be sent synchronously (above) or packed into a Message Batch
 *  (L7 cost spike below) with no difference in what the model sees. */
export function buildAnchoredParams(pdfBase64: string, template: FormTemplate, profile?: WriterProfile, pageBlocks?: PageBlock[] | null) {
  const p1 = readP1Enabled();
  const unsure = p1 && readUnsureEnabled();
  // Reader review flags (NICH-36) ride on the P1 read only.
  const marks = p1 && readMarksEnabled();
  const p1Schema = unsure ? withUnsureSchema(ANCHORED_EXTRACTION_SCHEMA_P1) : ANCHORED_EXTRACTION_SCHEMA_P1;
  return {
    model: EXTRACT_MODEL,
    // Numbers-only output is far smaller than the free-read schema, but the densest pages (form
    // page 2 = 71 rows, page 4 = 68) can still exceed a small cap and truncate — observed failing on
    // the live 98-page run at 8000. Same high cap as the free read; billed on actual output.
    max_tokens: 64000,
    system: [{type: 'text', text: p1 ? buildAnchoredSystemPromptP1() : buildAnchoredSystemPrompt(), cache_control: {type: 'ephemeral'}}],
    output_config: {format: {type: 'json_schema', schema: anchoredSchemaFor(p1 ? (marks ? withMarksSchema(p1Schema) : p1Schema) : ANCHORED_EXTRACTION_SCHEMA, template.version)}},
    messages: [
      {
        role: 'user',
        content: [...referenceBlocks(profile), ...(pageBlocks?.length ? pageBlocks : [pdfDoc(pdfBase64)]), {type: 'text', text: p1 ? buildAnchoredPromptP1(template, {unsure, marks}) : buildAnchoredPrompt(template)}],
      },
    ],
  };
}

// ============================================================================================
// L7 BATCH-MODE COST SPIKE (removable). A one-off measurement: submit the anchored reads of a
// known scan as a single Anthropic Message Batch (50% off, async) and read the results back, to
// confirm on OUR data that batch billing halves the anchored-read cost and the output stays
// within the reader's noise floor. Not wired into the pump; driven only by /api/goldline/l7-spike
// behind GOLDLINE_L7_SPIKE_SECRET. Delete this block and the route once the number is recorded.
// ============================================================================================

export type AnchoredBatchResult = {
  custom_id: string;
  output?: AnchoredOutput | null;
  usage?: {input: number; output: number};
  error?: string;
};

/** Submit anchored-read requests as one Message Batch; returns the batch id. Primary key only
 *  (a spike does not need the fallback-key dance). */
export async function submitAnchoredBatch(requests: {custom_id: string; params: unknown}[]): Promise<string> {
  const creds = goldlineCreds();
  if (creds.length === 0) throw new Error('GOLDLINE_ANTHROPIC_API_KEY is not set');
  const client = clientFor(creds[0]);
  const batch = await client.messages.batches.create({
    requests: requests as unknown as Parameters<typeof client.messages.batches.create>[0]['requests'],
  });
  return batch.id;
}

/** Poll a batch; when `ended`, decode every result (parsed JSON output + per-request usage). */
export async function fetchAnchoredBatch(batchId: string): Promise<{status: string; results: AnchoredBatchResult[]}> {
  const creds = goldlineCreds();
  if (creds.length === 0) throw new Error('GOLDLINE_ANTHROPIC_API_KEY is not set');
  const client = clientFor(creds[0]);
  const batch = await client.messages.batches.retrieve(batchId);
  if (batch.processing_status !== 'ended') return {status: batch.processing_status, results: []};
  const results: AnchoredBatchResult[] = [];
  for await (const entry of await client.messages.batches.results(batchId)) {
    const r = entry.result;
    if (r.type === 'succeeded') {
      const msg = r.message as {content?: Array<{type: string; text?: string}>; usage?: {input_tokens?: number; output_tokens?: number}};
      const text = msg.content?.find((b) => b.type === 'text' && typeof b.text === 'string')?.text;
      let output: AnchoredOutput | null = null;
      try {
        output = text ? (JSON.parse(text) as AnchoredOutput) : null;
      } catch {
        output = null;
      }
      results.push({
        custom_id: entry.custom_id,
        output,
        usage: {input: msg.usage?.input_tokens ?? 0, output: msg.usage?.output_tokens ?? 0},
      });
    } else {
      results.push({custom_id: entry.custom_id, error: r.type});
    }
  }
  return {status: 'ended', results};
}

/**
 * Safeguard (B): read the printed layout ONLY, with no expected column order stated: where the
 * "Delivery" column is, and the printed column numbers (QA Nov 26). The caller turns that into the
 * anchor version (versionFromLocator). The classifier confidently mis-reads some V2 pages as V1 (QA
 * page 16) and wavers on faint copies (QA p30, 0.5 to 0.6), so this layout read decides. Degrades to
 * an empty verdict (caller falls back to the classify-based gate) rather than throwing, and keeps
 * what it saw for the read log. Cheap: a tiny header-only read.
 */
export async function locateFormVersion(pdfBase64: string): Promise<LocatedVersion & {seen: DeliveryLocatorOutput | null; error?: string}> {
  if (!extractionConfigured()) throw new Error('GOLDLINE_ANTHROPIC_API_KEY is not set');
  const pageBlock = await cheapPageBlock(pdfBase64);
  const params = {
    model: EXTRACT_MODEL,
    // 4000 (was 500): the model thinks before it answers, and on a faint page the thinking alone
    // used all 500 tokens, so it never wrote an answer (QA p30, 4 of 4 tries: stop_reason
    // max_tokens, 499 to 500 thinking tokens) and the page silently fell back to the classifier's
    // unsure guess. A real answer measured 740 to 1200 tokens. Billed on actual output, so the
    // headroom is cheap (same fix the classifier got on Nov 24).
    max_tokens: 4000,
    output_config: {format: {type: 'json_schema', schema: DELIVERY_LOCATOR_SCHEMA}},
    messages: [{role: 'user', content: [pageBlock, {type: 'text', text: buildDeliveryLocatorPrompt()}]}],
  };
  try {
    const seen = (await visionJson(params, {timeout: 30_000})) as DeliveryLocatorOutput;
    return {...versionFromLocator(seen), seen};
  } catch (e) {
    return {version: null, by: null, deliveryColumn: null, conflict: false, seen: null, error: e instanceof Error ? e.message : String(e)};
  }
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
  family_totals?: FamilyTotal[];
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
