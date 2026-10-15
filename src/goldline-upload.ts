// Upload gatekeeping (P2) — the ONLY file types the Uploads page accepts are a
// POS sales .csv and a scanned inventory .pdf. Pure + unit-tested so the route
// stays thin; the route rejects anything this returns {ok:false} for before a
// single byte is stored (status 'rejected' on the gate, per the plan).

// 25 MB covers a multi-page scanned PDF comfortably; bigger is almost always a
// wrong file, and keeps us inside the route's memory + Vision limits.
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export type UploadClass =
  | {ok: true; kind: 'pos_csv' | 'inventory_pdf'; contentType: string}
  | {ok: false; reason: string};

/**
 * Decide whether a dropped file is an accepted Goldline upload, and which kind.
 * Extension is authoritative (browser MIME is unreliable); a MIME that clearly
 * contradicts the extension is still rejected so a renamed file can't slip past.
 */
export function classifyUpload(filename: string, mime: string, size: number): UploadClass {
  const name = (filename || '').trim();
  const dot = name.lastIndexOf('.');
  if (!name || dot < 0) return {ok: false, reason: 'Only .csv and .pdf files are accepted.'};
  const ext = name.slice(dot).toLowerCase();
  const m = (mime || '').toLowerCase();

  if (size <= 0) return {ok: false, reason: 'File is empty.'};
  if (size > MAX_UPLOAD_BYTES) {
    return {ok: false, reason: `File exceeds the ${Math.floor(MAX_UPLOAD_BYTES / 1048576)} MB limit.`};
  }

  if (ext === '.csv') {
    if (m.includes('pdf')) return {ok: false, reason: 'Named .csv but the file looks like a PDF.'};
    return {ok: true, kind: 'pos_csv', contentType: 'text/csv'};
  }
  if (ext === '.pdf') {
    if (m.includes('csv') || m.startsWith('text/')) {
      return {ok: false, reason: 'Named .pdf but the file looks like text/CSV.'};
    }
    return {ok: true, kind: 'inventory_pdf', contentType: 'application/pdf'};
  }
  return {ok: false, reason: 'Only .csv and .pdf files are accepted.'};
}
