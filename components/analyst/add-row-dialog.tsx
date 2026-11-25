'use client';

// Add product row (NICH-42): pick a catalog product the BA hand-wrote onto the form. The
// list opens on the product lines already on this page (a hand-written product is usually
// another shade of a printed line); typing searches every product by code or name. A
// product already on the page can't be added twice; one printed on another page of the
// form is allowed with a warning, because committing both replaces one count.

import {useEffect, useId, useMemo, useRef, useState} from 'react';
import {AlertTriangle, Search, X} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {cn} from '@/lib/utils';
import {ModalShell, useModalExit} from '@/components/analyst/modal-shell';
import {addWarning, searchAddable, type AddableItem} from '@/src/review-add-row';

export function AddRowDialog({
  items,
  pageCodes,
  pageLines,
  page,
  onAdd,
  onClose: rawClose,
}: {
  items: AddableItem[];
  pageCodes: ReadonlySet<string>;
  pageLines: ReadonlySet<string>;
  page: number | null;
  onAdd: (it: AddableItem) => Promise<string | null>;
  onClose: () => void;
}) {
  const {closing, close} = useModalExit(rawClose);
  const [q, setQ] = useState('');
  const [pick, setPick] = useState<AddableItem | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();
  const input = useRef<HTMLInputElement>(null);
  const hits = useMemo(() => searchAddable(items, q, pageLines), [items, q, pageLines]);
  const warn = pick ? addWarning(pick, pageCodes, page) : null;

  useEffect(() => {
    input.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, close]);

  const add = async () => {
    if (!pick || warn?.block) return;
    setBusy(true);
    setError(null);
    const err = await onAdd(pick);
    setBusy(false);
    if (err) return setError(err);
    close();
  };

  return (
    <ModalShell closing={closing} onBackdropClick={() => !busy && close()} labelledBy={titleId} panelClassName="flex max-h-[min(40rem,90vh)] w-full max-w-lg flex-col gap-4 rounded-xl border border-border bg-popover p-5 shadow-lg">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 id={titleId} className="font-heading text-base font-semibold">
            Add a product the BA wrote in
          </h2>
          <p className="mt-0.5 text-sm text-muted-foreground">It joins this page with blank counts for you to fill in, and is flagged as written in.</p>
        </div>
        <button type="button" onClick={close} aria-label="Close" className="-mt-1 -mr-1 inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 [@media(hover:hover)]:hover:bg-muted">
          <X className="size-4" />
        </button>
      </div>

      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <input
          ref={input}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Code or name, e.g. Creamy Glow"
          aria-label="Search products"
          className="h-9 w-full rounded-lg border border-border bg-background pr-2.5 pl-8 text-sm outline-none transition-colors duration-150 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40"
        />
      </div>

      <ul role="listbox" aria-label="Products" className="-mx-1 flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-1">
        {hits.length === 0 ? (
          <li className="px-2 py-6 text-center text-sm text-muted-foreground">No product matches “{q.trim()}”.</li>
        ) : (
          hits.map((it) => {
            const on = pick?.code === it.code;
            const here = pageCodes.has(it.code);
            return (
              <li key={it.code} role="option" aria-selected={on}>
                <button
                  type="button"
                  onClick={() => setPick(it)}
                  className={cn(
                    'flex w-full items-baseline gap-3 rounded-lg px-2.5 py-2 text-left transition-[background-color] duration-150',
                    on ? 'bg-[color-mix(in_oklab,var(--primary)_12%,transparent)]' : '[@media(hover:hover)]:hover:bg-muted',
                  )}
                >
                  <span className="w-24 shrink-0 font-mono text-xs font-medium">{it.code}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{it.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {here ? 'On this page' : it.printedPage != null ? `Printed on page ${it.printedPage}` : 'Not printed on this form'}
                    </span>
                  </span>
                  {it.price != null && <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">₱{it.price.toLocaleString('en-US')}</span>}
                </button>
              </li>
            );
          })
        )}
      </ul>

      {warn && (
        <p className="flex items-start gap-2 text-sm" style={{color: 'color-mix(in oklab, var(--status-warn) 78%, var(--foreground))'}}>
          <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />
          {warn.text}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm" style={{color: 'color-mix(in oklab, var(--status-crit) 80%, var(--foreground))'}}>
          {error}
        </p>
      )}

      <div className="flex items-center justify-end gap-2">
        <Button variant="outline" onClick={close} disabled={busy}>
          Cancel
        </Button>
        <Button onClick={() => void add()} disabled={busy || !pick || Boolean(warn?.block)}>
          {busy ? 'Adding…' : pick ? `Add ${pick.code}` : 'Add'}
        </Button>
      </div>
    </ModalShell>
  );
}
