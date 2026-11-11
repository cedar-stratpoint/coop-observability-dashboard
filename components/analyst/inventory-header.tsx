// Shared header for both Inventory channels (Stratpoint offline / BoxMe online),
// so flipping the channel keeps the title, switch and actions in the same place.
// One heading, one quiet channel switch, one line of context, and the page's
// actions on the right. The channel switch is a soft segmented control (card on
// muted) so the only filled-primary element on the page is the primary action.

import Link from 'next/link';
import {cn} from '@/lib/utils';

export type InventoryChannel = 'offline' | 'online';

export function InventoryHeader({channel, offlineHref, onlineHref, meta, actions}: {
  channel: InventoryChannel;
  offlineHref: string;
  onlineHref: string;
  meta?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
      <div className="flex min-w-0 flex-col gap-3">
        <h1 className="text-3xl font-semibold tracking-tight text-balance">Inventory</h1>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <nav aria-label="Inventory channel" className="inline-flex rounded-lg bg-muted/60 p-0.5">
            <ChannelLink href={offlineHref} active={channel === 'offline'} name="Stratpoint" kind="Offline" />
            <ChannelLink href={onlineHref} active={channel === 'online'} name="BoxMe" kind="Online" />
          </nav>
          {meta}
        </div>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

function ChannelLink({href, active, name, kind}: {href: string; active: boolean; name: string; kind: string}) {
  return (
    <Link
      href={href}
      scroll={false}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex h-7 items-center gap-1.5 rounded-md px-3 text-xs font-medium transition-[color,background-color,box-shadow] duration-150 ease-out focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none',
        active ? 'bg-card text-foreground shadow-sm ring-1 ring-border dark:bg-foreground/12' : 'text-muted-foreground hover:text-foreground',
      )}
    >
      {name}
      <span className="text-[11px] font-normal text-muted-foreground">{kind}</span>
    </Link>
  );
}

/** Quiet inline context next to the channel switch: "274 in Office · 311 at Events". */
export function HeaderMeta({children, demo}: {children: React.ReactNode; demo?: boolean}) {
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
      {children}
      {demo && (
        <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-400">Demo data</span>
      )}
    </p>
  );
}
