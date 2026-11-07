// Browser-side transport for one Goldline upload: an XHR so we get true upload-byte
// progress, asking the route for its NDJSON stage stream (see
// app/api/goldline/upload/route.ts) so the UI moves on real server milestones.
// Cancellable via the returned abort(). Client-only.

export type UploadStage =
  | {type: 'stage'; stage: 'stored' | 'parsing' | 'detecting' | 'saving'}
  | {type: 'stage'; stage: 'reading'; page: number; items: number};

export type UploadHeader = {
  storeCode: string | null;
  storeName: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  consultant: string | null;
};

export type UploadResult = {
  httpStatus: number;
  uploadId?: string;
  status?: string;
  error?: string;
  errors?: string[];
  rowsCommitted?: number;
  page?: number;
  rows?: number;
  flagged?: number;
  docConfidence?: number;
  header?: UploadHeader;
  watsons?: WatsonsResult; // a Watsons POS Sales Data month
  // What kind of page this was when it isn't an inventory page to read: 'sales'
  // (page 6 report), 'blank' (a back side), or 'unknown' — drives a friendly pill.
  pageKind?: string;
};

export type WatsonsResult = {
  month: {start: string; end: string};
  salesRows: number;
  stores: number;
  storesAdded: number;
  skus: number;
  skusNew: number;
  linkedNow: string[];
  units: number;
  linkedUnits: number;
};

// The shared NDJSON stream reader for a POST to the upload route: forwards stage events,
// resolves on the final {type:'result'} line, and turns a cut stream into a clear error.
// The 12s server heartbeat keeps a long read's connection open so this resolves for real
// rather than hanging — which is why both a fresh upload and a re-read use it.
function streamUpload(
  fd: FormData,
  company: string,
  onStage: (stage: UploadStage) => void,
  onUploadProgress?: (fraction: number) => void,
): {promise: Promise<UploadResult>; abort: () => void} {
  const xhr = new XMLHttpRequest();
  const promise = new Promise<UploadResult>((resolve, reject) => {
    let seen = 0;
    let result: UploadResult | null = null;
    const flush = () => {
      const text = xhr.responseText;
      let nl: number;
      while ((nl = text.indexOf('\n', seen)) >= 0) {
        const line = text.slice(seen, nl).trim();
        seen = nl + 1;
        if (!line) continue;
        try {
          const ev = JSON.parse(line) as UploadStage | (UploadResult & {type: 'result'});
          if (ev.type === 'result') result = ev;
          else if (ev.type === 'stage') onStage(ev);
        } catch {
          /* partial line — wait for the rest */
        }
      }
    };
    if (onUploadProgress) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onUploadProgress(e.loaded / e.total);
      };
      xhr.upload.onload = () => onUploadProgress(1);
    }
    xhr.onprogress = flush;
    xhr.onload = () => {
      flush();
      if (result) return resolve(result);
      try {
        resolve({httpStatus: xhr.status, ...(JSON.parse(xhr.responseText) as Omit<UploadResult, 'httpStatus'>)});
      } catch {
        // The stream closed before the final result line (a proxy idle-timeout cut it, or
        // the connection dropped). No raw status code in front of the user.
        reject(new Error('We couldn’t finish reading this page. Please try again.'));
      }
    };
    xhr.onerror = () => reject(new Error('Network error. Check your connection and try again.'));
    xhr.onabort = () => reject(new DOMException('Upload cancelled', 'AbortError'));
    xhr.open('POST', `/api/goldline/upload?company=${encodeURIComponent(company)}`);
    xhr.setRequestHeader('Accept', 'application/x-ndjson');
    xhr.send(fd);
  });
  return {promise, abort: () => xhr.abort()};
}

export function sendUpload(input: {
  company: string;
  file: File;
  batchId?: string | null;
  periodStart?: string;
  periodEnd?: string;
  onUploadProgress: (fraction: number) => void;
  onStage: (stage: UploadStage) => void;
}): {promise: Promise<UploadResult>; abort: () => void} {
  const fd = new FormData();
  fd.append('file', input.file);
  if (input.batchId) fd.append('batch_id', input.batchId);
  if (input.periodStart) fd.append('period_start', input.periodStart);
  if (input.periodEnd) fd.append('period_end', input.periodEnd);
  return streamUpload(fd, input.company, input.onStage, input.onUploadProgress);
}

/**
 * Re-read a stored page again (no new file): posts its upload id to the same route, which
 * reads it through the shared pipeline and streams progress + the final result back — so a
 * long re-read resolves in realtime instead of leaving the row spinning until a refresh.
 */
export function sendReread(input: {
  company: string;
  uploadId: string;
  onStage?: (stage: UploadStage) => void;
}): {promise: Promise<UploadResult>; abort: () => void} {
  const fd = new FormData();
  fd.append('reread_upload_id', input.uploadId);
  return streamUpload(fd, input.company, input.onStage ?? (() => {}));
}

/**
 * Split a multi-page PDF into one File per page (pdf-lib, loaded on demand so it only
 * costs bytes when someone actually drops a multi-page PDF). A single-page PDF comes
 * back as-is. Throws a readable error for a damaged or encrypted file.
 */
export async function splitPdfPages(file: File, nameFor: (i: number, total: number) => string): Promise<File[]> {
  const {PDFDocument} = await import('pdf-lib');
  let src;
  try {
    src = await PDFDocument.load(await file.arrayBuffer(), {ignoreEncryption: true, updateMetadata: false});
  } catch {
    throw new Error(`“${file.name}” couldn’t be opened. It may be damaged, so please re-scan it.`);
  }
  if (src.isEncrypted) throw new Error(`“${file.name}” is password-protected. Save an unlocked copy and add that.`);
  const total = src.getPageCount();
  if (total <= 1) return [file];
  const out: File[] = [];
  for (let i = 0; i < total; i++) {
    const doc = await PDFDocument.create();
    const [pg] = await doc.copyPages(src, [i]);
    doc.addPage(pg);
    const bytes = await doc.save();
    out.push(new File([bytes as BlobPart], nameFor(i, total), {type: 'application/pdf'}));
  }
  return out;
}
