import {describe, expect, it} from 'vitest';
import {applyOrientation, rotatePdf180} from '../src/goldline-orient';

async function onePagePdf(initial = 0): Promise<Uint8Array> {
  const {PDFDocument, degrees} = await import('pdf-lib');
  const doc = await PDFDocument.create();
  const p = doc.addPage([200, 300]);
  if (initial) p.setRotation(degrees(initial));
  return doc.save();
}

async function angleOf(bytes: Uint8Array): Promise<number> {
  const {PDFDocument} = await import('pdf-lib');
  const doc = await PDFDocument.load(bytes);
  return doc.getPages()[0].getRotation().angle;
}

describe('rotatePdf180', () => {
  it('adds 180° to an upright page', async () => {
    expect(await angleOf(await rotatePdf180(await onePagePdf(0)))).toBe(180);
  });
  it('returns to 0 when applied twice', async () => {
    const once = await rotatePdf180(await onePagePdf(0));
    expect(await angleOf(await rotatePdf180(once))).toBe(0);
  });
  it('preserves existing rotation (90 → 270)', async () => {
    expect(await angleOf(await rotatePdf180(await onePagePdf(90)))).toBe(270);
  });
});

describe('applyOrientation', () => {
  it('rotates only when the page is flagged upside-down', async () => {
    const base = await onePagePdf(0);
    expect(await angleOf(await applyOrientation(base, 0))).toBe(0);
    expect(await angleOf(await applyOrientation(base, 180))).toBe(180);
  });
});
