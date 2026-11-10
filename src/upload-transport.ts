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
  // The inventory form layout detected (legacy/v1/v2/unknown) for a read inventory page.
  formVersion?: string;
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

// --- Server-driven upload (P2) -------------------------------------------------------
// The whole scan is PUT to storage once, then the server splits + reads every page, so a
// refresh / navigation / slow page can't cut it (client-driven split+read above is for
// companies not on the flag). Two steps: ask for a signed upload URL, PUT the PDF to it
// (real byte progress), then POST one ingest request. The browser then only polls state.

export type ServerUploadPhase = 'uploading' | 'ingesting';

/**
 * Upload a whole scan PDF the server-driven way and enqueue its pages. Returns the batch it
 * created and the page count. Throws a readable error at whichever step fails. `onProgress`
 * reports real upload bytes (0–1) during the PUT; `onPhase` switches the label from
 * "uploading" to "ingesting" once the bytes are in and the server is splitting.
 */
export async function signAndIngestScan(input: {
  company: string;
  file: File;
  /** Optional name the user typed for this upload; shown instead of the filename on the scan
   *  tile and header. Stored per page so source-grouped views can read it. */
  name?: string;
  onProgress?: (fraction: number) => void;
  onPhase?: (phase: ServerUploadPhase) => void;
}): Promise<{batchId: string; pages: number}> {
  const company = encodeURIComponent(input.company);
  input.onPhase?.('uploading');
  // 1) Signed upload URL for this company's bucket prefix.
  const signRes = await fetch(`/api/goldline/upload/sign?company=${company}`, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({filename: input.file.name}),
  });
  const signed = (await signRes.json().catch(() => null)) as {signedUrl?: string; path?: string; error?: string} | null;
  if (!signRes.ok || !signed?.signedUrl || !signed?.path) {
    throw new Error(signed?.error ?? 'Could not start the upload. Please try again.');
  }

  // 2) PUT the whole PDF straight to storage, with real byte progress (XHR, not fetch).
  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    if (input.onProgress) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) input.onProgress!(e.loaded / e.total);
      };
      xhr.upload.onload = () => input.onProgress!(1);
    }
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error('The upload didn’t go through. Please try again.'));
    xhr.onerror = () => reject(new Error('Network error during upload. Check your connection and try again.'));
    xhr.open('PUT', signed.signedUrl!);
    xhr.setRequestHeader('content-type', 'application/pdf');
    xhr.send(input.file);
  });

  // 3) Ingest: the server splits the stored PDF into pages and enqueues them under one batch.
  input.onPhase?.('ingesting');
  const ingestRes = await fetch(`/api/goldline/ingest?company=${company}`, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({storagePath: signed.path, filename: input.file.name, name: input.name?.trim() || undefined}),
  });
  const ingested = (await ingestRes.json().catch(() => null)) as {batchId?: string; pages?: number; error?: string} | null;
  if (!ingestRes.ok || !ingested?.batchId || typeof ingested.pages !== 'number') {
    throw new Error(ingested?.error ?? 'Could not prepare the scan’s pages. Please try again.');
  }
  return {batchId: ingested.batchId, pages: ingested.pages};
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
