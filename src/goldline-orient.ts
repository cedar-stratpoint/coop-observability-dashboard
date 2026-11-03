// Goldline Phase 0 — rotate an upside-down scan 180° so it reads upright before
// extraction. The classifier (goldline-extract-run.classifyPage) reports orientation;
// when it is 180, the upload path re-rotates the page with this helper and extracts
// the upright copy. Uses pdf-lib, loaded on demand (same as upload-transport), and is
// environment-agnostic (no 'server-only') so it can run wherever the page is handled.

/**
 * Return a copy of `bytes` with every page rotated an extra 180°. Idempotent in
 * pairs (two calls return to the original angle). Preserves any existing rotation
 * (e.g. a 90° page becomes 270°), so it only ever ADDS 180 rather than forcing a
 * value. Throws only if the PDF can't be loaded.
 */
export async function rotatePdf180(bytes: ArrayBuffer | Uint8Array): Promise<Uint8Array> {
  const {PDFDocument, degrees} = await import('pdf-lib');
  const doc = await PDFDocument.load(bytes, {ignoreEncryption: true, updateMetadata: false});
  for (const page of doc.getPages()) {
    const current = page.getRotation().angle; // normalized degrees from pdf-lib
    page.setRotation(degrees(((current % 360) + 180) % 360));
  }
  return doc.save();
}

/** Apply a 180° rotation only when the classifier flagged the page upside-down.
 *  Returns the input untouched for upright pages, so callers can call it blindly. */
export async function applyOrientation(bytes: ArrayBuffer | Uint8Array, orientation: 0 | 180): Promise<Uint8Array> {
  if (orientation !== 180) return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return rotatePdf180(bytes);
}
