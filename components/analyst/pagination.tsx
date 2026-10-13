'use client';

// Shared numbered pager: ‹ [1] [2] … [9] › — page numbers are clickable to jump
// straight to a page, with ellipses collapsing long ranges (always first + last +
// current±`siblings`). Works two ways: URL-driven (pass `hrefFor` -> renders
// <Link>s, for server-paginated tables) or client-state-driven (pass `onPage` ->
// renders <button>s). Renders nothing when there is a single page.

import Link from 'next/link';
import {ChevronLeft, ChevronRight} from 'lucide-react';
import {cn} from '@/lib/utils';

type Item = {kind: 'page'; n: number} | {kind: 'gap'; id: string};

/** First + last + a window of ±siblings around the current page, gaps become '…'. */
function pageItems(current: number, count: number, siblings: number): Item[] {
  const nums = new Set<number>([1, count]);
  for (let n = current - siblings; n <= current + siblings; n++) {
    if (n >= 1 && n <= count) nums.add(n);
  }
  const sorted = [...nums].sort((a, b) => a - b);
  const items: Item[] = [];
  let prev = 0;
  for (const n of sorted) {
    if (n - prev > 1) items.push({kind: 'gap', id: `gap-${prev}-${n}`});
    items.push({kind: 'page', n});
    prev = n;
  }
  return items;
}

export function Pagination({
  page,
  pageCount,
  onPage,
  hrefFor,
  siblings = 1,
  className,
  label = 'Pagination',
  alwaysShow = false,
}: {
  page: number;
  pageCount: number;
  onPage?: (p: number) => void;
  hrefFor?: (p: number) => string;
  siblings?: number;
  className?: string;
  label?: string;
  /** Render even for a single page (disabled arrows + "1"), for layouts that
   *  keep a persistent pager bar. Default hides it. */
  alwaysShow?: boolean;
}) {
  if (pageCount <= 1 && !alwaysShow) return null;
  const items = pageItems(page, pageCount, siblings);
  return (
    <nav aria-label={label} className={cn('flex flex-wrap items-center justify-center gap-1', className)}>
      <Ctl to={page - 1} disabled={page <= 1} onPage={onPage} hrefFor={hrefFor} ariaLabel="Previous page">
        <ChevronLeft className="size-4" />
      </Ctl>
      {items.map((it) =>
        it.kind === 'gap' ? (
          <span key={it.id} className="select-none px-1 text-sm text-muted-foreground" aria-hidden>
            …
          </span>
        ) : (
          <Ctl
            key={it.n}
            to={it.n}
            active={it.n === page}
            onPage={onPage}
            hrefFor={hrefFor}
            ariaLabel={`Page ${it.n}`}
            current={it.n === page}
          >
            {it.n}
          </Ctl>
        ),
      )}
      <Ctl to={page + 1} disabled={page >= pageCount} onPage={onPage} hrefFor={hrefFor} ariaLabel="Next page">
        <ChevronRight className="size-4" />
      </Ctl>
    </nav>
  );
}

function Ctl({
  to,
  disabled,
  active,
  current,
  onPage,
  hrefFor,
  ariaLabel,
  children,
}: {
  to: number;
  disabled?: boolean;
  active?: boolean;
  current?: boolean;
  onPage?: (p: number) => void;
  hrefFor?: (p: number) => string;
  ariaLabel: string;
  children: React.ReactNode;
}) {
  const cls = cn(
    'inline-flex h-8 min-w-8 items-center justify-center rounded-md border px-2 text-xs font-medium tabular-nums transition-colors',
    active
      ? 'border-primary bg-primary text-primary-foreground'
      : disabled
        ? 'cursor-not-allowed border-border/60 text-muted-foreground/40'
        : 'border-border text-foreground hover:border-primary hover:text-primary',
  );
  const aria = current ? ('page' as const) : undefined;
  if (disabled) {
    return (
      <span className={cls} aria-disabled aria-label={ariaLabel}>
        {children}
      </span>
    );
  }
  if (hrefFor) {
    return (
      <Link href={hrefFor(to)} scroll={false} className={cls} aria-label={ariaLabel} aria-current={aria}>
        {children}
      </Link>
    );
  }
  return (
    <button type="button" onClick={() => onPage?.(to)} className={cls} aria-label={ariaLabel} aria-current={aria}>
      {children}
    </button>
  );
}
