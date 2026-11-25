'use client';

import {useCallback, useEffect, useState} from 'react';
import {CheckCircle2, X, XCircle} from 'lucide-react';

// Short confirmations, the same look as the Uploads page's: bottom right on desktop, bottom
// centre above the phone tab bar, auto-dismissed, announced politely to screen readers.

export type ToastItem = {id: number; kind: 'ok' | 'error'; text: string; action?: {label: string; onClick: () => void}};

export function useToasts(ms = 6000) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const push = useCallback((t: Omit<ToastItem, 'id'>) => {
    if (!t.text) return;
    setToasts((all) => [...all.slice(-2), {...t, id: Date.now() + Math.random()}]);
  }, []);
  const dismiss = useCallback((id: number) => setToasts((all) => all.filter((x) => x.id !== id)), []);
  useEffect(() => {
    if (!toasts.length) return;
    const t = setTimeout(() => setToasts((all) => all.slice(1)), ms);
    return () => clearTimeout(t);
  }, [toasts, ms]);
  return {toasts, push, dismiss};
}

export function ToastStack({toasts, dismiss}: {toasts: ToastItem[]; dismiss: (id: number) => void}) {
  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed inset-x-4 bottom-[calc(env(safe-area-inset-bottom)+5.5rem)] z-50 flex flex-col items-center gap-2 md:inset-x-auto md:right-6 md:bottom-6 md:items-end"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          role="status"
          className="pointer-events-auto flex w-full max-w-sm items-start gap-2.5 rounded-xl border border-border bg-popover px-3.5 py-3 text-sm text-popover-foreground shadow-lg transition-[opacity,transform] duration-200 ease-out starting:translate-y-2 starting:opacity-0 motion-reduce:transition-none"
        >
          {t.kind === 'ok' ? (
            <CheckCircle2 className="mt-0.5 size-4 shrink-0" style={{color: 'var(--status-good)'}} aria-hidden />
          ) : (
            <XCircle className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
          )}
          <span className="min-w-0 flex-1">{t.text}</span>
          {t.action && (
            <button
              type="button"
              onClick={() => {
                t.action!.onClick();
                dismiss(t.id);
              }}
              className="-my-0.5 shrink-0 rounded-md px-2 py-0.5 font-medium text-[color:var(--primary)] transition-[background-color,transform] duration-150 ease-out hover:bg-muted active:scale-[0.97] motion-reduce:transition-none"
            >
              {t.action.label}
            </button>
          )}
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => dismiss(t.id)}
            className="-mr-1 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
          >
            <X className="size-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}
