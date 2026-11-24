import 'server-only';
import {EXTRACT_MODEL} from './goldline-extract';
import {goldlineReaderClient} from './goldline-extract-run';
import {PoFormFileError} from './goldline-po-form-xlsx';
import type {PoFormCell} from './goldline-po-form';

// A PO form sent as a PDF (printed or scanned): Claude transcribes the DESCRIPTION columns
// line by line, exactly as printed, and the same deterministic matcher as the xlsx path
// turns those lines into catalog products. The model never picks products itself, so it
// can't invent one; the admin reviews the result before it becomes the PO form.

const PROMPT = `This PDF is Nichido Cosmetics' PURCHASE ORDER FORM: pages with two "QTY. | DESCRIPTION" column pairs.
Transcribe every printed line of the DESCRIPTION columns, page by page, left column top to bottom, then right column top to bottom.
Rules:
- Copy each line as printed. Keep a leading "-" on shade lines (e.g. "- Salmon"), keep codes like '86619 or #LP02.
- When a line also has selling notes printed to its right (e.g. "Bestseller", "(1) Full coverage", Tagalog keywords), separate them from the product text with three spaces.
- Ignore the QTY column, bullets, handwriting, and the instructions at the top and bottom of the page.
Answer with only JSON: {"pages":[{"page":1,"left":["..."],"right":["..."]}]}`;

export async function transcribePoFormPdf(bytes: Uint8Array): Promise<PoFormCell[]> {
  const client = goldlineReaderClient();
  if (!client) throw new PoFormFileError('PDF reading is not set up on this environment. Upload the Excel version instead.');
  const res = await client.messages.create({
    model: EXTRACT_MODEL,
    max_tokens: 16000,
    messages: [
      {
        role: 'user',
        content: [
          {type: 'document', source: {type: 'base64', media_type: 'application/pdf', data: Buffer.from(bytes).toString('base64')}},
          {type: 'text', text: PROMPT},
        ],
      },
    ],
  });
  const text = res.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
  const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  let parsed: {pages?: Array<{page?: number; left?: unknown; right?: unknown}>};
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new PoFormFileError('The PDF could not be read. Try again, or upload the Excel version.');
  }
  const cells: PoFormCell[] = [];
  for (const [pi, p] of (parsed.pages ?? []).entries()) {
    const page = String(p.page ?? pi + 1);
    [p.left, p.right].forEach((col, column) => {
      if (!Array.isArray(col)) return;
      col.forEach((line, row) => {
        if (typeof line === 'string' && line.trim()) cells.push({page, column, row, text: line});
      });
    });
  }
  if (!cells.length) throw new PoFormFileError('No product lines were found in that PDF. Is this the PO form?');
  return cells;
}
