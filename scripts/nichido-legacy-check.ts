/**
 * Dev-only: extract ONE Legacy page and print the deducted-column rows + the printed
 * self-check (col3=col1+col2, col6=col3-col4), to validate Phase 1 Legacy extraction
 * on real data. No DB. Usage:
 *   GOLDLINE_ANTHROPIC_API_KEY=... npx tsx scripts/nichido-legacy-check.ts \
 *     "../reference/nichido/Sept/Scan2026-10-30_171554.pdf" --pdfpage 2 --page 1
 */
import {readFileSync} from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import {PDFDocument} from 'pdf-lib';
import {buildSystemPrompt, EXTRACT_MODEL} from '../src/goldline-extract';
import {buildLegacyManifestPrompt, LEGACY_EXTRACTION_SCHEMA, legacyRowMathOff, type LegacyExtractedRow} from '../src/goldline-legacy-extract';

function flag(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

async function main() {
  const key = process.env.GOLDLINE_ANTHROPIC_API_KEY;
  if (!key) throw new Error('GOLDLINE_ANTHROPIC_API_KEY is not set');
  const pdfPath = process.argv[2] ?? '../reference/nichido/Sept/Scan2026-10-30_171554.pdf';
  const pdfPage = Number(flag('pdfpage', '2'));
  const page = Number(flag('page', '1'));

  const src = await PDFDocument.load(readFileSync(pdfPath), {ignoreEncryption: true, updateMetadata: false});
  const one = await PDFDocument.create();
  const [cp] = await one.copyPages(src, [pdfPage - 1]);
  one.addPage(cp);
  const b64 = Buffer.from(await one.save()).toString('base64');

  const client = new Anthropic({apiKey: key});
  const params = {
    model: EXTRACT_MODEL,
    max_tokens: 16000,
    system: [{type: 'text', text: buildSystemPrompt(), cache_control: {type: 'ephemeral'}}],
    output_config: {format: {type: 'json_schema', schema: LEGACY_EXTRACTION_SCHEMA}},
    messages: [{role: 'user', content: [
      {type: 'document', source: {type: 'base64', media_type: 'application/pdf', data: b64}},
      {type: 'text', text: buildLegacyManifestPrompt(page)},
    ]}],
  };
  const res = (await client.messages.create(
    params as unknown as Parameters<typeof client.messages.create>[0],
    {timeout: 85_000},
  )) as {content?: Array<{type: string; text?: string}>};
  const text = res.content?.find((b) => b.type === 'text' && typeof b.text === 'string')?.text ?? '{}';
  const parsed = JSON.parse(text) as {store_code?: string; period_start?: string; period_end?: string; rows: LegacyExtractedRow[]};

  console.log(`store ${parsed.store_code ?? '?'} · ${parsed.period_start ?? '?'}..${parsed.period_end ?? '?'} · ${parsed.rows.length} rows\n`);
  const pad = (s: string, n: number) => (s ?? '').toString().padStart(n);
  console.log('ITEM        beg  dlv  b+d  ded  end  conf  selfcheck');
  let off = 0;
  for (const r of parsed.rows) {
    const m = legacyRowMathOff(r);
    if (m) off++;
    const anyVal = [r.beginning, r.delivery, r.begin_plus_delivery, r.deducted_pcs, r.ending_on_hand].some((v) => v != null);
    if (!anyVal) continue; // skip empty rows for readability
    console.log(
      r.item_code.padEnd(11) +
        pad(r.beginning == null ? '-' : String(r.beginning), 4) +
        pad(r.delivery == null ? '-' : String(r.delivery), 5) +
        pad(r.begin_plus_delivery == null ? '-' : String(r.begin_plus_delivery), 5) +
        pad(r.deducted_pcs == null ? '-' : String(r.deducted_pcs), 5) +
        pad(r.ending_on_hand == null ? '-' : String(r.ending_on_hand), 5) +
        pad((r.confidence ?? 0).toFixed(2), 6) +
        '  ' + (m ? `OFF: ${m.rule} (${m.written}≠${m.expected})` : 'ok'),
    );
  }
  console.log(`\n${off} row(s) with a self-check mismatch out of ${parsed.rows.length}.`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
