// Sharper page images for the OCR read (plan: knowledge/tasks/2026-11-19-handwriting-read-accuracy.md).
//
// Sent as a PDF, a scan page reaches the model rendered at roughly 90 dpi (~1,600 input tokens), so
// dense handwriting blurs: 4/9, 1/7, 6/0 and large Delivery numbers get misread, and a cramped column
// can slip a row. A whole page sent as one 300 dpi image is shrunk by the API to ~180 dpi; horizontal
// bands of the page are small enough to be kept at the full 300 dpi. Measured on the four hardest
// answer-key pages: filled cells read right 82.6% (PDF) -> 91.1% (page image) -> 94.1% (page + bands),
// at ~+18k input tokens and slightly FEWER output tokens per page.
//
// So the read gets: the whole page (1600 px wide, for layout and row alignment), a short note, then
// ~5 overlapping full-width bands at 300 dpi (for the digits). Rendering is best-effort: any failure
// returns null and the caller sends the PDF exactly as before.

export const BAND_DPI = 300;
export const BAND_HEIGHT = 1000;
export const BAND_OVERLAP = 160;
export const PAGE_IMAGE_WIDTH = 1600;
/** Widest band we send unscaled; the API keeps a ~2,500 x 1,000 px band at full resolution. */
export const MAX_BAND_WIDTH = 2560;
const MIN_LAST_BAND = 250;

import {estimateSlant, type Slant} from './goldline-slant';

export type ImageBlock = {type: 'image'; source: {type: 'base64'; media_type: 'image/jpeg'; data: string}};
export type TextBlock = {type: 'text'; text: string};
export type PageBlock = ImageBlock | TextBlock;

/** Top/height of each overlapping horizontal band for a page `height` px tall. Pure. */
export function bandRects(height: number, bandHeight = BAND_HEIGHT, overlap = BAND_OVERLAP): {y: number; h: number}[] {
  if (!(height > 0) || bandHeight <= overlap) return [];
  const out: {y: number; h: number}[] = [];
  for (let y = 0; y < height; y += bandHeight - overlap) {
    const h = Math.min(bandHeight, height - y);
    if (h < MIN_LAST_BAND && out.length > 0) break; // a sliver already covered by the previous band's overlap
    out.push({y, h});
    if (y + bandHeight >= height) break;
  }
  return out;
}

/** The note placed between the whole-page image and the bands. */
export function bandsNote(n: number): string {
  return [
    `The image above is the whole page. The next ${n} images are ZOOMED, overlapping horizontal bands of the SAME`,
    'page, top to bottom (each band repeats the bottom of the previous one). Read the handwritten digits from the',
    'zoomed bands; use the printed ITEM# at the left of each band, and the whole page, to place every number on its',
    'row. A number that appears in two overlapping bands is ONE number.',
  ].join(' ');
}

const jpeg = (data: Buffer): ImageBlock => ({type: 'image', source: {type: 'base64', media_type: 'image/jpeg', data: data.toString('base64')}});

/**
 * Render page 1 of an (already upright) single-page PDF at 300 dpi and return the content blocks that
 * replace the PDF document block: [whole page, note, ...bands]. Null on any failure (caller keeps the
 * PDF). Server-only in practice (native canvas), loaded lazily so tests and the client never import it.
 */
export async function renderBandBlocks(pdfBase64: string): Promise<PageBlock[] | null> {
  return (await renderReadImages(pdfBase64))?.blocks ?? null;
}

/** Width of the page image sent with the row-box request (the answer-key test located rows well at
 *  1000 px; the API keeps an image this size as is). */
export const LOCATE_IMAGE_WIDTH = 1000;

/**
 * One render, two uses: the read's content blocks (as `renderBandBlocks`) and a 1000 px page image
 * for the row-box request, with its pixel size. Null on any failure (caller keeps the PDF, no boxes).
 */
export async function renderReadImages(
  pdfBase64: string,
): Promise<{blocks: PageBlock[]; locate: {data: string; w: number; h: number; slant: Slant | null}} | null> {
  try {
    const {pdf} = await import('pdf-to-img');
    const {createCanvas, loadImage} = await import('@napi-rs/canvas');
    const doc = await pdf(Buffer.from(pdfBase64, 'base64'), {scale: BAND_DPI / 72});
    let png: Buffer | null = null;
    for await (const p of doc) {
      png = p;
      break;
    }
    if (!png) return null;
    const img = await loadImage(png);
    const w = img.width, h = img.height;
    if (!(w > 0 && h > 0)) return null;

    const pw = PAGE_IMAGE_WIDTH, ph = Math.round((h * PAGE_IMAGE_WIDTH) / w);
    const pageCanvas = createCanvas(pw, ph);
    pageCanvas.getContext('2d').drawImage(img, 0, 0, pw, ph);
    const blocks: PageBlock[] = [jpeg(await pageCanvas.encode('jpeg', 88))];

    const rects = bandRects(h);
    const bw = Math.min(w, MAX_BAND_WIDTH);
    const bands: ImageBlock[] = [];
    for (const r of rects) {
      const bh = Math.round((r.h * bw) / w);
      const c = createCanvas(bw, bh);
      c.getContext('2d').drawImage(img, 0, r.y, w, r.h, 0, 0, bw, bh);
      bands.push(jpeg(await c.encode('jpeg', 88)));
    }
    if (bands.length === 0) return null;
    blocks.push({type: 'text', text: bandsNote(bands.length)}, ...bands);
    const lw = LOCATE_IMAGE_WIDTH, lh = Math.round((h * LOCATE_IMAGE_WIDTH) / w);
    const lc = createCanvas(lw, lh);
    const lctx = lc.getContext('2d');
    lctx.drawImage(img, 0, 0, lw, lh);
    // The page's slant, from the same image, so review can tilt the row box with the paper.
    let slant: Slant | null = null;
    try {
      const px = lctx.getImageData(0, 0, lw, lh).data;
      const gray = new Uint8Array(lw * lh);
      for (let i = 0; i < lw * lh; i++) gray[i] = (px[i * 4] * 299 + px[i * 4 + 1] * 587 + px[i * 4 + 2] * 114) / 1000;
      slant = estimateSlant(gray, lw, lh);
    } catch {
      slant = null;
    }
    const locate = {data: (await lc.encode('jpeg', 85)).toString('base64'), w: lw, h: lh, slant};
    return {blocks, locate};
  } catch (e) {
    console.error('goldline: band render failed, sending the PDF', e instanceof Error ? e.message : String(e));
    return null;
  }
}

/** Share of the page height each header crop covers. The handwritten header line sits in the top
 *  ~10% of an upright page (the bottom ~10% of an upside-down one). */
export const HEADER_CROP_FRAC = 0.13;

/** What the classify call is told about the header crops. */
export const HEADER_CROPS_NOTE = [
  'The two images after the page are sharp 300 dpi crops of the TOP and BOTTOM edges of this same page, each turned',
  'so its text reads upright if the header is there. The handwritten header line (Period Covered, Beauty Consultant,',
  'Store Assignment w/ Code) is in one of them: read store_code, store_name, the period and the consultant from that',
  'sharp crop. Judge page, kind, orientation and version from the whole page as usual.',
].join(' ');

/**
 * Render a single-page PDF at 300 dpi and return two JPEG crops: the top edge as is, and the bottom
 * edge turned 180 degrees (so an upside-down page's header reads upright). Null on any failure (the
 * caller classifies from the page alone, as before). Server-only in practice, loaded lazily.
 */
export async function renderHeaderCrops(pdfBase64: string): Promise<ImageBlock[] | null> {
  try {
    const {pdf} = await import('pdf-to-img');
    const {createCanvas, loadImage} = await import('@napi-rs/canvas');
    const doc = await pdf(Buffer.from(pdfBase64, 'base64'), {scale: BAND_DPI / 72});
    let png: Buffer | null = null;
    for await (const p of doc) {
      png = p;
      break;
    }
    if (!png) return null;
    const img = await loadImage(png);
    const w = img.width, h = img.height;
    if (!(w > 0 && h > 0)) return null;
    const ch = Math.round(h * HEADER_CROP_FRAC);
    const cw = Math.min(w, MAX_BAND_WIDTH);
    const scaledH = Math.round((ch * cw) / w);
    const top = createCanvas(cw, scaledH);
    top.getContext('2d').drawImage(img, 0, 0, w, ch, 0, 0, cw, scaledH);
    const bottom = createCanvas(cw, scaledH);
    const bctx = bottom.getContext('2d');
    bctx.translate(cw, scaledH);
    bctx.rotate(Math.PI);
    bctx.drawImage(img, 0, h - ch, w, ch, 0, 0, cw, scaledH);
    return [jpeg(await top.encode('jpeg', 88)), jpeg(await bottom.encode('jpeg', 88))];
  } catch (e) {
    console.error('goldline: header crop render failed, classifying from the page alone', e instanceof Error ? e.message : String(e));
    return null;
  }
}
