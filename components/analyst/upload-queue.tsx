'use client';

import {createContext, useCallback, useContext, useEffect, useMemo, useRef, useState} from 'react';
import {useRouter} from 'next/navigation';
import {createBatchAction, updateBatchInfoAction} from '@/app/uploads/actions';
import {kindOfFile, type Phase} from '@/src/upload-progress';
import {MAX_BATCH_FILES, MAX_FILE_BYTES, splitName} from '@/src/upload-batch';
import {sendUpload, splitPdfPages, type UploadResult} from '@/src/upload-transport';

// The Goldline upload queue. Lives in the app shell (which stays mounted across
// in-app navigation), so uploads keep running while the user moves between pages and
// a small indicator can follow them. One batch at a time = one store's form for one
// period: PDFs (multi-page ones split into pages on drop) are read 2 at a time; the
// batch's store + period are entered once, prefilled from page 1's printed header.
// A sales CSV rides along but needs the period before it can go.

export const CONCURRENCY = 2;

export type ItemState = 'queued' | 'waiting_period' | 'running' | 'done' | 'failed' | 'cancelled';

export type QueueItem = {
  id: string;
  file: File;
  name: string;
  size: number;
  kind: 'pdf' | 'csv';
  state: ItemState;
  phase: Phase; // server milestone while running
  uploadFrac: number; // real bytes sent, 0–1
  phaseAt: number; // when the current phase began (for the eased progress band)
  startedAt: number | null;
  reading: {page: number; items: number} | null;
  // results
  uploadId?: string;
  serverStatus?: string; // needs_review | committed | rejected | failed
  page?: number;
  rows?: number;
  flagged?: number;
  rowsCommitted?: number;
  error?: string;
};

export type BatchInfo = {
  id: string | null;
  storeCode: string;
  periodStart: string;
  periodEnd: string;
  consultant: string | null;
  prefilled: boolean; // store/period came from page 1's printed header
};

type QueueApi = {
  company: string | null;
  batch: BatchInfo;
  items: QueueItem[];
  preparing: boolean; // splitting multi-page PDFs
  notice: string | null; // add-time problems (wrong type, too big, too many)
  active: number; // queued + running + waiting
  addFiles: (files: File[]) => Promise<void>;
  retry: (id: string) => void;
  cancel: (id: string) => void;
  remove: (id: string) => void;
  setBatchInfo: (patch: Partial<Pick<BatchInfo, 'storeCode' | 'periodStart' | 'periodEnd'>>) => void;
  reset: () => void;
  dismissNotice: () => void;
};

const EMPTY_BATCH: BatchInfo = {id: null, storeCode: '', periodStart: '', periodEnd: '', consultant: null, prefilled: false};
const Ctx = createContext<QueueApi | null>(null);

export function useUploadQueue(): QueueApi | null {
  return useContext(Ctx);
}

let seq = 0;
const newId = () => `q${Date.now().toString(36)}${(seq++).toString(36)}`;

export function UploadQueueProvider({company, children}: {company: string | null; children: React.ReactNode}) {
  const router = useRouter();
  const [items, setItems] = useState<QueueItem[]>([]);
  const [batch, setBatch] = useState<BatchInfo>(EMPTY_BATCH);
  const [preparing, setPreparing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const aborts = useRef(new Map<string, () => void>());
  const batchPromise = useRef<Promise<string | null> | null>(null);
  // Run attempt per item: cancelling (before the request goes out) or retrying bumps
  // it, so a superseded run stops at the gate and never overwrites a newer one.
  const attempt = useRef(new Map<string, number>());
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const batchRef = useRef(batch);
  batchRef.current = batch;
  // The company the queue's work belongs to (fixed while a batch is in flight, even if
  // the user switches views meanwhile).
  const queueCompany = useRef<string | null>(company);
  if (!items.length) queueCompany.current = company;

  const patch = useCallback((id: string, p: Partial<QueueItem> | ((i: QueueItem) => Partial<QueueItem>)) => {
    setItems((all) => all.map((i) => (i.id === id ? {...i, ...(typeof p === 'function' ? p(i) : p)} : i)));
  }, []);

  /** Create the batch once (shared by concurrent first uploads). */
  const ensureBatch = useCallback(async (): Promise<string | null> => {
    if (batchRef.current.id) return batchRef.current.id;
    if (!batchPromise.current) {
      batchPromise.current = createBatchAction({company: queueCompany.current}).then((r) => {
        if (!r.ok) {
          batchPromise.current = null;
          throw new Error(r.error);
        }
        setBatch((b) => ({...b, id: r.batchId}));
        batchRef.current = {...batchRef.current, id: r.batchId};
        return r.batchId;
      });
    }
    return batchPromise.current;
  }, []);

  // Save store + period to the batch whenever they change — including values typed
  // before the batch existed (saved as soon as it's created). Debounced while typing.
  useEffect(() => {
    if (!batch.id) return;
    const company = queueCompany.current;
    const t = setTimeout(() => {
      void updateBatchInfoAction({
        company,
        batchId: batch.id!,
        storeCode: batch.storeCode,
        periodStart: batch.periodStart,
        periodEnd: batch.periodEnd,
      });
    }, 400);
    return () => clearTimeout(t);
  }, [batch.id, batch.storeCode, batch.periodStart, batch.periodEnd]);

  /** Refresh server data once a burst of finished uploads settles, not after each one. */
  const refreshSoon = useCallback(() => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = null;
      router.refresh();
    }, 800);
  }, [router]);
  useEffect(() => () => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
  }, []);

  const run = useCallback(
    async (item: QueueItem) => {
      const token = (attempt.current.get(item.id) ?? 0) + 1;
      attempt.current.set(item.id, token);
      const superseded = () => attempt.current.get(item.id) !== token;
      const company = queueCompany.current;
      if (!company) return patch(item.id, {state: 'failed', error: 'No company in view.'});
      patch(item.id, {state: 'running', phase: 'uploading', uploadFrac: 0, phaseAt: Date.now(), startedAt: Date.now(), error: undefined});
      let batchId: string | null = null;
      try {
        if (item.kind === 'pdf') batchId = await ensureBatch();
      } catch (e) {
        if (superseded()) return; // cancelled (and maybe retried) meanwhile
        return patch(item.id, {state: 'failed', error: e instanceof Error ? e.message : 'Could not start the upload.'});
      }
      // Cancelled while the batch was being created: don't send.
      if (superseded()) return;
      const b = batchRef.current;
      const {promise, abort} = sendUpload({
        company,
        file: item.file,
        batchId,
        periodStart: item.kind === 'csv' ? b.periodStart : undefined,
        periodEnd: item.kind === 'csv' ? b.periodEnd : undefined,
        onUploadProgress: (f) => patch(item.id, {uploadFrac: f}),
        onStage: (ev) =>
          patch(item.id, {
            phase: ev.stage,
            phaseAt: Date.now(),
            ...(ev.stage === 'reading' ? {reading: {page: ev.page, items: ev.items}} : {}),
          }),
      });
      aborts.current.set(item.id, abort);
      let res: UploadResult;
      try {
        res = await promise;
      } catch (e) {
        aborts.current.delete(item.id);
        if (e instanceof DOMException && e.name === 'AbortError') return patch(item.id, {state: 'cancelled'});
        return patch(item.id, {state: 'failed', error: e instanceof Error ? e.message : 'Upload failed.'});
      }
      aborts.current.delete(item.id);
      if (res.status === 'needs_review' || res.status === 'committed') {
        patch(item.id, {
          state: 'done',
          phase: 'done',
          uploadId: res.uploadId,
          serverStatus: res.status,
          page: res.page,
          rows: res.rows,
          flagged: res.flagged,
          rowsCommitted: res.rowsCommitted,
        });
        // Page 1 prints the store + period: prefill the batch if the user hasn't typed them.
        const h = res.header;
        if (res.page === 1 && h) {
          setBatch((cur) => ({
            ...cur,
            storeCode: cur.storeCode || h.storeCode || '',
            periodStart: cur.periodStart || h.periodStart || '',
            periodEnd: cur.periodEnd || h.periodEnd || '',
            consultant: cur.consultant ?? h.consultant ?? null,
            prefilled: cur.prefilled || Boolean((!cur.storeCode && h.storeCode) || (!cur.periodStart && h.periodStart)),
          }));
        }
        refreshSoon(); // the Files list picks up the new rows
      } else {
        patch(item.id, {
          state: 'failed',
          uploadId: res.uploadId,
          serverStatus: res.status,
          error: res.error ?? res.errors?.[0] ?? `Upload failed (${res.httpStatus}).`,
        });
      }
    },
    [ensureBatch, patch, refreshSoon],
  );

  // Scheduler: keep CONCURRENCY uploads going; CSVs wait for the batch period.
  useEffect(() => {
    const hasPeriod = Boolean(batch.periodStart && batch.periodEnd);
    const waiting = items.filter((i) => i.state === 'waiting_period');
    if (hasPeriod && waiting.length) {
      setItems((all) => all.map((i) => (i.state === 'waiting_period' ? {...i, state: 'queued'} : i)));
      return;
    }
    const running = items.filter((i) => i.state === 'running').length;
    const next = items.filter((i) => i.state === 'queued').slice(0, Math.max(0, CONCURRENCY - running));
    for (const i of next) {
      if (i.kind === 'csv' && !hasPeriod) {
        patch(i.id, {state: 'waiting_period'});
        continue;
      }
      void run(i);
    }
  }, [items, batch.periodStart, batch.periodEnd, run, patch]);

  const active = items.filter((i) => i.state === 'queued' || i.state === 'running' || i.state === 'waiting_period').length;

  // Leaving the app (reload / close) would kill in-flight uploads — warn first.
  useEffect(() => {
    if (!items.some((i) => i.state === 'queued' || i.state === 'running')) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [items]);

  const addFiles = useCallback(
    async (files: File[]) => {
      setNotice(null);
      const problems: string[] = [];
      const accepted: File[] = [];
      setPreparing(true);
      try {
        for (const f of files) {
          const k = kindOfFile(f.name);
          if (!k) {
            problems.push(`“${f.name}” isn’t a .csv or .pdf.`);
            continue;
          }
          if (f.size === 0) {
            problems.push(`“${f.name}” is empty.`);
            continue;
          }
          if (f.size > MAX_FILE_BYTES) {
            problems.push(`“${f.name}” is over 25 MB.`);
            continue;
          }
          if (k === 'pdf') {
            try {
              accepted.push(...(await splitPdfPages(f, (i, n) => splitName(f.name, i, n))));
            } catch (e) {
              problems.push(e instanceof Error ? e.message : `“${f.name}” couldn’t be opened.`);
            }
          } else accepted.push(f);
        }
      } finally {
        setPreparing(false);
      }
      setItems((all) => {
        const room = Math.max(0, MAX_BATCH_FILES - all.filter((i) => i.state !== 'cancelled').length);
        if (accepted.length > room) problems.push(`Up to ${MAX_BATCH_FILES} files per batch, so ${accepted.length - room} were left out.`);
        const added: QueueItem[] = accepted.slice(0, room).map((file) => ({
          id: newId(),
          file,
          name: file.name,
          size: file.size,
          kind: kindOfFile(file.name) === 'csv' ? 'csv' : 'pdf',
          state: 'queued',
          phase: 'uploading',
          uploadFrac: 0,
          phaseAt: 0,
          startedAt: null,
          reading: null,
        }));
        return [...all, ...added];
      });
      if (problems.length) setNotice(problems.join(' '));
    },
    [],
  );

  const api = useMemo<QueueApi>(
    () => ({
      company: queueCompany.current,
      batch,
      items,
      preparing,
      notice,
      active,
      addFiles,
      retry: (id) =>
        patch(id, (i) =>
          i.state === 'failed' || i.state === 'cancelled'
            ? {state: 'queued', error: undefined, phase: 'uploading', uploadFrac: 0, uploadId: undefined, serverStatus: undefined}
            : {},
        ),
      cancel: (id) => {
        const abort = aborts.current.get(id);
        if (abort) return abort();
        const item = items.find((i) => i.id === id);
        // Running but not sent yet (the batch is still being created): stop it at the gate.
        if (item?.state === 'running') attempt.current.set(id, (attempt.current.get(id) ?? 0) + 1);
        patch(id, (i) => (i.state === 'queued' || i.state === 'waiting_period' || i.state === 'running' ? {state: 'cancelled'} : {}));
      },
      remove: (id) => setItems((all) => all.filter((i) => i.id !== id || i.state === 'running')),
      setBatchInfo: (p) => setBatch((cur) => ({...cur, ...p, prefilled: false})),
      reset: () => {
        if (items.some((i) => i.state === 'running')) return;
        setItems([]);
        setBatch(EMPTY_BATCH);
        batchPromise.current = null;
        attempt.current.clear();
        setNotice(null);
      },
      dismissNotice: () => setNotice(null),
    }),
    // company: queueCompany.current follows it whenever the queue is empty.
    [batch, items, preparing, notice, active, addFiles, patch, company],
  );

  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}
