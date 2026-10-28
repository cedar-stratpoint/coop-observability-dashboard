'use client';

import {Fragment, useEffect, useId, useRef, useState} from 'react';
import {X} from 'lucide-react';
import type {FormPage} from '@/src/goldline-sku-links-data';
import {ModalShell, useModalExit} from './modal-shell';
import {cn} from '@/lib/utils';

// One page of the printed inventory form, on screen, with one item pinpointed: its row
// is highlighted and scrolled into view. Drawn from the fixed form template (same
// printed order as the paper), grouped by product line, with the BA's five count
// columns left blank so it reads like the sheet they know. Opened from "Page 2 · row 17"
// on SKU linking; pages 1 to 5 can be flipped without closing.

const COUNT_COLS = ['Stockroom', 'Drawer', 'Selling area', 'Delivery', 'Ending'];

export function FormPageDialog({pages, at, onClosed}: {pages: FormPage[]; at: {page: number; itemCode: string}; onClosed: () => void}) {
  const {closing, close} = useModalExit(onClosed);
  const [page, setPage] = useState(at.page);
  const titleId = useId();
  const mark = useRef<HTMLTableRowElement>(null);
  const current = pages.find((p) => p.page === page);
  const target = pages.find((p) => p.page === at.page)?.lines.find((l) => l.itemCode === at.itemCode);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);

  // Bring the pinpointed row to the middle whenever its page is showing.
  useEffect(() => {
    if (page !== at.page) return;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    requestAnimationFrame(() => mark.current?.scrollIntoView({block: 'center', behavior: reduced ? 'auto' : 'smooth'}));
  }, [page, at.page]);

  // Product line headers, as printed: a new group starts when the line changes.
  let lastLine: string | null | undefined;

  return (
    <ModalShell
      closing={closing}
      onBackdropClick={close}
      labelledBy={titleId}
      panelClassName="flex max-h-[88vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-border bg-popover shadow-lg"
    >
      <header className="flex flex-col gap-3 border-b px-5 pt-4 pb-3">
        <div className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 flex-col gap-0.5">
            <h2 id={titleId} className="font-heading text-base font-semibold tracking-tight">
              Inventory form · Page {page} of {pages.length}
            </h2>
            {target && (
              <p className="truncate text-sm text-muted-foreground">
                Row {target.row} on page {at.page}: <span className="text-foreground">{target.productLine ? `${target.productLine} · ` : ''}{target.name}</span>{' '}
                <span className="font-mono text-xs">{target.itemCode}</span>
              </p>
            )}
          </div>
          <button type="button" onClick={close} aria-label="Close" className="-mr-1 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
            <X className="size-4" />
          </button>
        </div>
        <div role="tablist" aria-label="Form page" className="-mx-1 flex gap-1 overflow-x-auto px-1 [scrollbar-width:none]">
          {pages.map((p) => (
            <button
              key={p.page}
              type="button"
              role="tab"
              aria-selected={page === p.page}
              onClick={() => setPage(p.page)}
              className={cn(
                'inline-flex h-8 min-w-16 shrink-0 items-center justify-center gap-1.5 rounded-md px-3 text-xs whitespace-nowrap tabular-nums transition-colors duration-150',
                page === p.page ? 'bg-foreground font-medium text-background' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              Page {p.page}
              {p.page === at.page && <span className="size-1.5 rounded-full bg-[var(--status-warn)]" aria-label="has the item" />}
            </button>
          ))}
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full border-collapse text-sm md:min-w-[44rem]">
          <thead className="sticky top-0 z-10 bg-popover">
            <tr className="border-b text-left text-[11px] font-medium text-muted-foreground">
              <th className="w-12 px-3 py-2 text-right font-medium">Row</th>
              <th className="px-3 py-2 font-medium">Item</th>
              <th className="px-3 py-2 font-medium">Code</th>
              {COUNT_COLS.map((c) => (
                <th key={c} className="w-[4.5rem] px-2 py-2 text-center font-medium max-md:hidden">
                  {c}
                </th>
              ))}
              <th className="px-3 py-2 font-medium">Watsons SKU</th>
            </tr>
          </thead>
          <tbody>
            {current?.lines.map((l) => {
              const head = l.productLine !== lastLine;
              lastLine = l.productLine;
              const hit = page === at.page && l.itemCode === at.itemCode;
              return (
                <Fragment key={l.itemCode}>
                  {head && (
                    <tr className="bg-muted/40">
                      <td colSpan={9} className="px-3 py-1.5 text-xs font-medium text-muted-foreground">
                        {l.productLine ?? 'Other'}
                      </td>
                    </tr>
                  )}
                  <tr
                    ref={hit ? mark : undefined}
                    aria-current={hit ? 'true' : undefined}
                    className={cn('border-b border-border/60', hit && 'bg-[color-mix(in_oklab,var(--status-warn)_16%,transparent)] outline-2 -outline-offset-2 outline-[var(--status-warn)]')}
                  >
                    <td className={cn('px-3 py-2 text-right tabular-nums text-muted-foreground', hit && 'font-semibold text-foreground')}>{l.row}</td>
                    <td className={cn('px-3 py-2', hit && 'font-medium')}>{l.name}</td>
                    <td className="px-3 py-2 font-mono text-xs text-muted-foreground">{l.itemCode}</td>
                    {COUNT_COLS.map((c) => (
                      <td key={c} className="border-l border-border/40 px-2 py-2 max-md:hidden" aria-hidden />
                    ))}
                    <td className="px-3 py-2 font-mono text-xs text-muted-foreground">{l.sku ?? '—'}</td>
                  </tr>
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      <footer className="border-t px-5 py-2.5 text-xs text-muted-foreground">
        The printed form&apos;s order and items.<span className="max-md:hidden"> Count columns are left blank.</span> A store&apos;s filled form is under Flags.
      </footer>
    </ModalShell>
  );
}
