'use client';

// Review flags (NICH-42, Nov 25): a reviewer flags a row (a number they can't read, a BA's
// note or revision, "Damage" written in a count, anything else) or the whole page (columns
// the BA relabelled). A flag names the page and row for the reports; it never changes a
// count or the BA's score, and it doesn't block commit. Syl: for an unreadable number,
// leave the cell blank and flag it instead of guessing.
//
// One provider per review screen holds every page's flags, so stepping between pages in a
// batch keeps what was flagged without a reload. Saves go straight to the server.

import {createContext, useCallback, useContext, useEffect, useId, useMemo, useState, type ReactNode} from 'react';
import {Flag, X} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {cn} from '@/lib/utils';
import {ModalShell, useModalExit} from '@/components/analyst/modal-shell';
import {clearMarkAction, flagAction} from '@/app/uploads/review-marks-actions';
import {MARK_HINT, MARK_LABEL, PAGE_KINDS, REASON_MAX, ROW_KINDS, pageMarks, rowMarks, upsertLocal, type MarkKind, type ReviewMark} from '@/src/goldline-review-marks';

export type FlagTarget = {uploadId: string; itemCode: string | null; rowIndex: number | null; label: string};

type Ctx = {
  marks: ReviewMark[];
  canFlag: boolean;
  open: (t: FlagTarget) => void;
  /** Save a flag without the dialog (Add product row). Returns an error, or null. */
  save: (flag: {uploadId: string; itemCode: string | null; rowIndex: number | null; kind: MarkKind; reason?: string | null}) => Promise<string | null>;
  /** Clear a flag by id without the dialog. Returns an error, or null. */
  clear: (id: string) => Promise<string | null>;
};

const MarksContext = createContext<Ctx | null>(null);

/** The flags of one review screen. Absent = no flagging (e.g. a sales upload). */
export function useReviewFlags(): Ctx | null {
  return useContext(MarksContext);
}

export function ReviewFlagsProvider({company, initial, canFlag, children}: {company: string; initial: ReviewMark[]; canFlag: boolean; children: ReactNode}) {
  const [marks, setMarks] = useState<ReviewMark[]>(initial);
  const [target, setTarget] = useState<FlagTarget | null>(null);
  const open = useCallback((t: FlagTarget) => setTarget(t), []);
  const onSaved = useCallback((m: ReviewMark) => setMarks((all) => upsertLocal(all, m)), []);
  const save = useCallback<Ctx['save']>(
    async (flag) => {
      const res = await flagAction({company, flag: {...flag, reason: flag.reason ?? ''}});
      if (!res.ok) return res.error;
      onSaved(res.mark);
      return null;
    },
    [company, onSaved],
  );
  const clear = useCallback<Ctx['clear']>(
    async (id) => {
      const res = await clearMarkAction({company, id});
      if (!res.ok) return res.error;
      onSaved(res.mark);
      return null;
    },
    [company, onSaved],
  );
  const value = useMemo(() => ({marks, canFlag, open, save, clear}), [marks, canFlag, open, save, clear]);
  return (
    <MarksContext.Provider value={value}>
      {children}
      {target && <FlagDialog company={company} target={target} marks={marks} onSaved={onSaved} onClose={() => setTarget(null)} />}
    </MarksContext.Provider>
  );
}

/** The open flags on one row, or on the page when `itemCode` is null. */
export function useTargetMarks(uploadId: string | undefined, itemCode: string | null): ReviewMark[] {
  const ctx = useReviewFlags();
  return useMemo(() => {
    if (!ctx || !uploadId) return [];
    const mine = ctx.marks.filter((m) => m.uploadId === uploadId);
    return itemCode == null ? pageMarks(mine) : rowMarks(mine, itemCode);
  }, [ctx, uploadId, itemCode]);
}

/** The row's (or page's) flags as small amber pills, with the reviewer's note when there is one. */
export function FlagChips({marks, className}: {marks: ReviewMark[]; className?: string}) {
  if (!marks.length) return null;
  return (
    <span className={cn('flex flex-wrap items-center gap-1', className)}>
      {marks.map((m) => (
        <span
          key={m.id}
          title={m.reason ?? undefined}
          className="inline-flex h-5 max-w-full items-center gap-1 truncate rounded-full px-2 text-[11px] font-medium"
          style={{color: 'color-mix(in oklab, var(--status-warn) 78%, var(--foreground))', background: 'color-mix(in oklab, var(--status-warn) 14%, transparent)'}}
        >
          <Flag aria-hidden className="size-3 shrink-0" />
          <span className="truncate">
            {MARK_LABEL[m.kind]}
            {m.reason ? ` · ${m.reason}` : ''}
            {m.source === 'reader' ? ' · by the reader' : ''}
          </span>
        </span>
      ))}
    </span>
  );
}

/**
 * The Flag button on a row or the page. Tinted once there is an open flag. On a row with no flag
 * it only shows when it can be wanted (Hick's law, Nov 25): on hover, keyboard focus anywhere in
 * the row, the row pointed at on the scan, or a phone row whose count is being edited. It keeps
 * its space when hidden, so the count columns never shift.
 */
export function FlagButton({target, count, size = 'row'}: {target: FlagTarget; count: number; size?: 'row' | 'page'}) {
  const ctx = useReviewFlags();
  if (!ctx?.canFlag) return null;
  const on = count > 0;
  const label = target.itemCode ? `Flag ${target.label}` : 'Flag this page';
  return (
    <button
      type="button"
      onClick={() => ctx.open(target)}
      aria-label={on ? `${label} (${count} flagged)` : label}
      title={on ? 'Flagged. Open to add or clear' : label}
      className={cn(
        'inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md border text-xs font-medium outline-none',
        'transition-[transform,border-color,background-color,opacity] duration-150 ease-out active:scale-[0.97] focus-visible:ring-3 focus-visible:ring-ring/40',
        size === 'row' && !on && 'opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100 group-data-[pointed]/row:opacity-100 focus-visible:opacity-100',
        size === 'row' ? 'size-7' : 'h-8 px-2.5',
        on ? 'border-transparent' : 'border-border bg-background text-muted-foreground [@media(hover:hover)]:hover:border-foreground/25 [@media(hover:hover)]:hover:text-foreground',
      )}
      style={on ? {color: 'color-mix(in oklab, var(--status-warn) 78%, var(--foreground))', background: 'color-mix(in oklab, var(--status-warn) 16%, transparent)'} : undefined}
    >
      <Flag aria-hidden className={cn('size-3.5', on && 'fill-current')} />
      {size === 'page' && <span>{on ? `Page flagged · ${count}` : 'Flag page'}</span>}
    </button>
  );
}

function FlagDialog({company, target, marks, onSaved, onClose: rawClose}: {company: string; target: FlagTarget; marks: ReviewMark[]; onSaved: (m: ReviewMark) => void; onClose: () => void}) {
  const {closing, close} = useModalExit(rawClose);
  const kinds = target.itemCode ? ROW_KINDS : PAGE_KINDS;
  const current = useMemo(
    () => (target.itemCode == null ? pageMarks(marks.filter((m) => m.uploadId === target.uploadId)) : rowMarks(marks.filter((m) => m.uploadId === target.uploadId), target.itemCode)),
    [marks, target],
  );
  const [kind, setKind] = useState<MarkKind>(kinds[0]);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();
  const noteId = useId();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, close]);

  const save = async () => {
    setBusy('save');
    setError(null);
    const res = await flagAction({company, flag: {uploadId: target.uploadId, itemCode: target.itemCode, rowIndex: target.rowIndex, kind, reason}});
    setBusy(null);
    if (!res.ok) return setError(res.error);
    onSaved(res.mark);
    close();
  };
  const clear = async (id: string) => {
    setBusy(id);
    setError(null);
    const res = await clearMarkAction({company, id});
    setBusy(null);
    if (!res.ok) return setError(res.error);
    onSaved(res.mark);
  };

  return (
    <ModalShell closing={closing} onBackdropClick={() => !busy && close()} labelledBy={titleId} panelClassName="flex w-full max-w-md flex-col gap-4 rounded-xl border border-border bg-popover p-5 shadow-lg">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id={titleId} className="font-heading text-base font-semibold">
            {target.itemCode ? 'Flag this row' : 'Flag this page'}
          </h2>
          <p className="mt-0.5 truncate text-sm text-muted-foreground">{target.label}</p>
        </div>
        <button type="button" onClick={close} aria-label="Close" className="-mt-1 -mr-1 inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 [@media(hover:hover)]:hover:bg-muted">
          <X className="size-4" />
        </button>
      </div>

      {current.length > 0 && (
        <ul className="flex flex-col gap-1.5 rounded-lg border border-border p-2.5" aria-label="Flagged now">
          {current.map((m) => (
            <li key={m.id} className="flex items-center justify-between gap-3 text-sm">
              <span className="min-w-0">
                <span className="font-medium">{MARK_LABEL[m.kind]}</span>
                {m.reason && <span className="text-muted-foreground"> · {m.reason}</span>}
                <span className="block truncate text-xs text-muted-foreground">{m.source === 'reader' ? 'Flagged by the reader' : `Flagged by ${m.createdBy ?? 'a reviewer'}`}</span>
              </span>
              <Button variant="outline" size="xs" disabled={busy != null} onClick={() => clear(m.id)}>
                {busy === m.id ? 'Clearing…' : 'Clear'}
              </Button>
            </li>
          ))}
        </ul>
      )}

      <fieldset className="flex flex-col gap-1.5">
        <legend className="mb-1.5 text-xs font-medium text-muted-foreground">{current.length ? 'Add a flag' : 'What should someone look at?'}</legend>
        {kinds.map((k) => (
          <label
            key={k}
            className={cn(
              'flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2 transition-[border-color,background-color] duration-150',
              kind === k ? 'border-[color-mix(in_oklab,var(--status-warn)_55%,transparent)] bg-[color-mix(in_oklab,var(--status-warn)_8%,transparent)]' : 'border-border [@media(hover:hover)]:hover:border-foreground/25',
            )}
          >
            <input type="radio" name="flag-kind" value={k} checked={kind === k} onChange={() => setKind(k)} className="mt-1 accent-[var(--status-warn)]" />
            <span className="flex flex-col">
              <span className="text-sm font-medium">{MARK_LABEL[k]}</span>
              <span className="text-xs text-muted-foreground">{MARK_HINT[k]}</span>
            </span>
          </label>
        ))}
      </fieldset>

      <div className="flex flex-col gap-1.5">
        <label htmlFor={noteId} className="text-xs font-medium text-muted-foreground">
          Your note {kind === 'other' ? '' : '(optional)'}
        </label>
        <input
          id={noteId}
          value={reason}
          maxLength={REASON_MAX}
          onChange={(e) => setReason(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && !busy && void save()}
          placeholder={kind === 'illegible' ? 'Looks like 3, 22 or 25' : 'For whoever checks this'}
          className="h-9 rounded-lg border border-border bg-background px-2.5 text-sm outline-none transition-colors duration-150 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40"
        />
        {kind === 'illegible' && <p className="text-xs text-muted-foreground">Leave the cell blank rather than guessing. Reconcile then shows it as not known.</p>}
      </div>

      {error && (
        <p role="alert" className="text-sm" style={{color: 'color-mix(in oklab, var(--status-crit) 80%, var(--foreground))'}}>
          {error}
        </p>
      )}

      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={close} disabled={busy != null}>
          Cancel
        </Button>
        <Button onClick={() => void save()} disabled={busy != null || (kind === 'other' && !reason.trim())}>
          {busy === 'save' ? 'Saving…' : 'Flag'}
        </Button>
      </div>
    </ModalShell>
  );
}
