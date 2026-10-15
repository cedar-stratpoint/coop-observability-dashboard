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
};

export function sendUpload(input: {
  company: string;
  file: File;
  batchId?: string | null;
  periodStart?: string;
  periodEnd?: string;
  onUploadProgress: (fraction: number) => void;
  onStage: (stage: UploadStage) => void;
}): {promise: Promise<UploadResult>; abort: () => void} {
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
          else if (ev.type === 'stage') input.onStage(ev);
        } catch {
          /* partial line — wait for the rest */
        }
      }
    };
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) input.onUploadProgress(e.loaded / e.total);
    };
    xhr.upload.onload = () => input.onUploadProgress(1);
    xhr.onprogress = flush;
    xhr.onload = () => {
      flush();
      if (result) return resolve(result);
      try {
        resolve({httpStatus: xhr.status, ...(JSON.parse(xhr.responseText) as Omit<UploadResult, 'httpStatus'>)});
      } catch {
        reject(new Error(`Upload failed (${xhr.status}). Please try again.`));
      }
    };
    xhr.onerror = () => reject(new Error('Network error. Check your connection and try again.'));
    xhr.onabort = () => reject(new DOMException('Upload cancelled', 'AbortError'));

    const fd = new FormData();
    fd.append('file', input.file);
    if (input.batchId) fd.append('batch_id', input.batchId);
    if (input.periodStart) fd.append('period_start', input.periodStart);
    if (input.periodEnd) fd.append('period_end', input.periodEnd);
    xhr.open('POST', `/api/goldline/upload?company=${encodeURIComponent(input.company)}`);
    xhr.setRequestHeader('Accept', 'application/x-ndjson');
    xhr.send(fd);
  });
  return {promise, abort: () => xhr.abort()};
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
