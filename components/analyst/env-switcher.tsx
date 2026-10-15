'use client';

// Environment switcher — Staging ↔ Production — for anyone who holds a Coop Admin
// role (in whatever view they're in). Each environment is its own deployment with its
// own database and sign-in, so switching opens the SAME page on the other site; no
// deployment ever holds another environment's keys. Rendered only when the server
// says the user holds Coop Admin (nav.holdsCoopAdmin).

import Link from 'next/link';
import {usePathname, useSearchParams} from 'next/navigation';
import {Menu} from '@base-ui/react/menu';
import {ArrowUpRight, ChevronDown, Layers, Settings2} from 'lucide-react';
import {COOP_ENVS, envByKey, switchHref, type CoopEnvKey} from '@/src/coop-env';
import {cn} from '@/lib/utils';

const POPUP =
  'z-50 w-64 origin-[var(--transform-origin)] rounded-xl border bg-popover p-1.5 text-popover-foreground shadow-lg outline-none transition-[opacity,transform] duration-150 ease-out data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0';
const ITEM =
  'flex cursor-default items-center gap-3 rounded-lg px-2.5 py-2 text-sm outline-none select-none data-[highlighted]:bg-muted';

export function EnvSwitcher({env}: {env: CoopEnvKey}) {
  const current = envByKey(env);
  const pathname = usePathname() || '/';
  const search = useSearchParams()?.toString() ?? '';

  return (
    <Menu.Root>
      <Menu.Trigger
        aria-label={`Environment: ${current.label}. Switch environment`}
        className="inline-flex h-8 items-center gap-2 rounded-full border bg-background pr-2 pl-2.5 text-xs font-medium outline-none transition-[background-color,border-color,transform] duration-150 ease-out hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/40 active:scale-[0.97] data-[popup-open]:bg-muted"
        style={{borderColor: `color-mix(in oklab, ${current.tone} 45%, var(--border))`}}
      >
        <Layers aria-hidden className="size-3.5" style={{color: current.tone}} />
        <span className="max-sm:sr-only">{current.label}</span>
        <ChevronDown aria-hidden className="size-3 opacity-60" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="bottom" align="start" sideOffset={6}>
          <Menu.Popup className={POPUP}>
            <div className="px-2.5 pt-1.5 pb-1 text-sm font-semibold">Environments</div>
            <div className="px-2.5 pb-1.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Coop</div>
            {COOP_ENVS.map((e) => {
              const active = e.key === env;
              const rail = <span aria-hidden className="h-5 w-0.5 shrink-0 rounded-full" style={{background: e.tone}} />;
              return active ? (
                // Not a menu item (nothing to do) — a plain row screen readers still read.
                <div key={e.key} className={cn(ITEM, 'cursor-default')} aria-current="true">
                  {rail}
                  <span className="flex-1 font-medium">{e.label}</span>
                  <span className="inline-flex items-center gap-1.5 text-xs font-medium" style={{color: 'var(--status-good)'}}>
                    <span className="size-1.5 rounded-full bg-current" /> Active
                  </span>
                </div>
              ) : (
                <Menu.Item
                  key={e.key}
                  className={ITEM}
                  render={<a href={switchHref(e.key, pathname, search)} />}
                  // Keep the current #anchor too — read at click time so it's never stale.
                  onClick={(ev) => {
                    if (!window.location.hash) return;
                    ev.preventDefault();
                    window.location.assign(switchHref(e.key, pathname, search, window.location.hash));
                  }}
                >
                  {rail}
                  <span className="flex-1">{e.label}</span>
                  <ArrowUpRight aria-hidden className="size-3.5 text-muted-foreground" />
                </Menu.Item>
              );
            })}
            <div role="separator" className="my-1.5 h-px bg-border" />
            <Menu.Item className={cn(ITEM, 'justify-center text-muted-foreground')} render={<Link href="/admin/environments" />}>
              <Settings2 aria-hidden className="size-3.5" /> Manage environments
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

/** A thin colour strip along the top of the header so a Coop Admin always knows which
 *  environment they're in (strongest in Production). */
export function EnvStrip({env}: {env: CoopEnvKey}) {
  const e = envByKey(env);
  return <span aria-hidden className={cn('pointer-events-none absolute inset-x-0 top-0', env === 'production' ? 'h-[3px]' : 'h-0.5')} style={{background: e.tone}} />;
}
