/**
 * Dev-only validation harness for Nichido Phase 0.
 *
 * Splits a scanned inventory PDF into single pages, runs the Phase 0 classifier
 * (Claude Vision) on each, and prints a table + the groupIntoForms() result, so we
 * can see on REAL data whether orientation / version / store-header detection holds
 * before wiring the upload route or changing the Staging schema. No DB, nothing
 * persisted. Exercises the real pure prompt/schema/segmentation (imports from
 * src/goldline-extract.ts + src/goldline-segment.ts); the live call is reproduced
 * here to avoid the server-only extract-run module.
 *
 * Usage:
 *   GOLDLINE_ANTHROPIC_API_KEY=... npx tsx scripts/nichido-classify-check.ts \
 *     "../reference/nichido/Sept/Scan2026-10-30_171554.pdf" --pages 1,2,3,5,6,15,21,27,45,57
 *   add --all to do every page; --concurrency N (default 3).
 */
import {readFileSync} from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import {PDFDocument} from 'pdf-lib';
import {buildPageClassifyPrompt, PAGE_CLASSIFY_SCHEMA, EXTRACT_MODEL} from '../src/goldline-extract';
import {sanitizeClassification, segmentBundle, type ClassifiedPage} from '../src/goldline-segment';

function parseArgs(argv: string[]) {
  const args = argv.slice(2);
  const flags = new Map<string, string>();
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : 'true';
      flags.set(k, v);
    } else positionals.push(a);
  }
  return {flags, positionals};
}

/** "1,2,5-7" → [1,2,5,6,7]. */
function parsePages(spec: string, total: number): number[] {
  const out = new Set<number>();
  for (const part of spec.split(',')) {
    const t = part.trim();
    const m = /^(\d+)-(\d+)$/.exec(t);
    if (m) {
      for (let n = Number(m[1]); n <= Number(m[2]); n++) out.add(n);
    } else if (/^\d+$/.test(t)) out.add(Number(t));
  }
  return [...out].filter((n) => n >= 1 && n <= total).sort((a, b) => a - b);
}

async function singlePageBase64(src: PDFDocument, index0: number): Promise<string> {
  const doc = await PDFDocument.create();
  const [copied] = await doc.copyPages(src, [index0]);
  doc.addPage(copied);
  const bytes = await doc.save();
  return Buffer.from(bytes).toString('base64');
}

async function classifyOne(client: Anthropic, pdfBase64: string) {
  const params = {
    model: EXTRACT_MODEL,
    max_tokens: 500,
    system: buildPageClassifyPrompt(),
    output_config: {format: {type: 'json_schema', schema: PAGE_CLASSIFY_SCHEMA}},
    messages: [{role: 'user', content: [
      {type: 'document', source: {type: 'base64', media_type: 'application/pdf', data: pdfBase64}},
      {type: 'text', text: 'Classify this page. Return JSON only.'},
    ]}],
  };
  const res = (await client.messages.create(
    params as unknown as Parameters<typeof client.messages.create>[0],
    {timeout: 30_000},
  )) as {content?: Array<{type: string; text?: string}>};
  const text = res.content?.find((b) => b.type === 'text' && typeof b.text === 'string')?.text ?? '{}';
  try {
    return sanitizeClassification(JSON.parse(text));
  } catch {
    return sanitizeClassification({}); // degrade to unknown, mirror classifyPage
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({length: Math.min(limit, items.length)}, worker));
  return out;
}

const pad = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n));

async function main() {
  const {flags, positionals} = parseArgs(process.argv);
  const key = process.env.GOLDLINE_ANTHROPIC_API_KEY;
  if (!key) throw new Error('GOLDLINE_ANTHROPIC_API_KEY is not set');
  const pdfPath = positionals[0] ?? '../reference/nichido/Sept/Scan2026-10-30_171554.pdf';
  const concurrency = Number(flags.get('concurrency') ?? 3);

  console.log(`Loading ${pdfPath} …`);
  const src = await PDFDocument.load(readFileSync(pdfPath), {ignoreEncryption: true, updateMetadata: false});
  const total = src.getPageCount();
  const pages = flags.has('all')
    ? Array.from({length: total}, (_, i) => i + 1)
    : parsePages(flags.get('pages') ?? '1,2,3,5,6,15,21,27,45,57', total);
  console.log(`PDF has ${total} pages. Classifying ${pages.length}: ${pages.join(', ')} (concurrency ${concurrency})\n`);

  const client = new Anthropic({apiKey: key});
  const classified: ClassifiedPage[] = [];

  const results = await mapLimit(pages, concurrency, async (pageNo) => {
    const t0 = Date.now();
    try {
      const b64 = await singlePageBase64(src, pageNo - 1);
      const c = await classifyOne(client, b64);
      return {pageNo, c, ms: Date.now() - t0, err: null as string | null};
    } catch (e) {
      return {pageNo, c: null, ms: Date.now() - t0, err: e instanceof Error ? e.message : String(e)};
    }
  });

  console.log(
    pad('PDFpg', 6) + pad('detPg', 6) + pad('kind', 11) + pad('orient', 7) + pad('version', 9) +
      pad('store', 8) + pad('period', 24) + pad('consultant', 16) + pad('conf', 6) + 'notes',
  );
  console.log('-'.repeat(110));
  for (const r of results) {
    if (r.err || !r.c) {
      console.log(pad(String(r.pageNo), 6) + `ERROR: ${r.err}`);
      continue;
    }
    const c = r.c;
    classified.push({...c, id: `pdf-${r.pageNo}`});
    const period = c.period_start || c.period_end ? `${c.period_start ?? '?'}..${c.period_end ?? '?'}` : '—';
    console.log(
      pad(String(r.pageNo), 6) + pad(String(c.page), 6) + pad(c.kind, 11) + pad(String(c.orientation), 7) +
        pad(c.version, 9) + pad(c.store_code ?? '—', 8) + pad(period, 24) + pad(c.consultant ?? '—', 16) +
        pad(c.confidence.toFixed(2), 6) + `${r.ms}ms`,
    );
  }

  console.log('\n=== segmentBundle ===');
  const {forms, sales, blanks, unplaceable} = segmentBundle(classified);
  console.log(`${forms.length} form group(s); ${sales.length} sales, ${blanks.length} blank, ${unplaceable.length} unplaceable set aside\n`);
  for (const g of forms) {
    console.log(`• ${g.store_code ?? 'unknown-store'} · ${g.period_start ?? '?'}..${g.period_end ?? '?'} · ${g.version}`);
    console.log(`    present: [${g.present.join(', ')}]  missing: [${g.missing.join(', ')}]  ` +
      `dups: ${g.duplicates.map((d) => `p${d.page}×${d.ids.length}`).join(', ') || 'none'}`);
    if (g.flags.length) console.log(`    flags: ${g.flags.join(', ')}`);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
