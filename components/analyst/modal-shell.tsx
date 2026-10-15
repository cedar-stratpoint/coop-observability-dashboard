'use client';

// Shared centered dialog: backdrop + panel with an enter and an exit. Replaces
// the hand-rolled `fixed inset-0` overlays that snapped in and out in one frame.
//
// Motion (productivity UI, so short and quiet):
//   enter  backdrop fades 150ms; panel fades + scales 0.96 -> 1 over 180ms, ease-out-quint
//   exit   both fade over 120ms, no scale (exits are subtler than enters)
// The enter uses CSS @starting-style (Tailwind `starting:`), so it needs no JS.
// The exit needs the dialog to stay mounted for 120ms; `useModalExit` handles
// that. Under prefers-reduced-motion the global rule in globals.css collapses
// the transitions and the hook closes immediately.
import {useCallback, useEffect, useRef, useState, type ReactNode} from 'react';
import {createPortal} from 'react-dom';
import {cn} from '@/lib/utils';

const EXIT_MS = 120;

/**
 * Wraps a dialog's `onClose` so closing plays the exit first. Dialogs shadow
 * their prop with the returned `close`, so every existing close path (Escape,
 * backdrop, X, Cancel, close-after-save) animates without touching each one.
 */
export function useModalExit(onClose: () => void) {
  const [closing, setClosing] = useState(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const close = useCallback(() => {
    if (timer.current) return; // already closing
    const reduced = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) {
      onCloseRef.current();
      return;
    }
    setClosing(true);
    timer.current = setTimeout(() => onCloseRef.current(), EXIT_MS);
  }, []);

  return {closing, close};
}

export function ModalShell({
  closing,
  onBackdropClick,
  backdropLabel = 'Close',
  labelledBy,
  panelClassName,
  children,
}: {
  closing: boolean;
  onBackdropClick: () => void;
  backdropLabel?: string;
  labelledBy?: string;
  /** Size, padding and layout of the panel (e.g. `w-full max-w-md rounded-xl border bg-popover p-5 shadow-lg`). */
  panelClassName: string;
  children: ReactNode;
}) {
  if (typeof document === 'undefined') return null;
  return createPortal(
    <div
      className="group fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby={labelledBy}
      data-closing={closing || undefined}
    >
      <button
        type="button"
        aria-label={backdropLabel}
        onClick={onBackdropClick}
        className="absolute inset-0 cursor-default bg-foreground/40 backdrop-blur-[1px] transition-opacity duration-150 ease-out starting:opacity-0 group-data-closing:opacity-0 group-data-closing:duration-120"
      />
      <div
        className={cn(
          'relative transition-[opacity,transform] duration-180 ease-[cubic-bezier(0.23,1,0.32,1)] starting:scale-[0.96] starting:opacity-0 group-data-closing:opacity-0 group-data-closing:duration-120',
          panelClassName,
        )}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
