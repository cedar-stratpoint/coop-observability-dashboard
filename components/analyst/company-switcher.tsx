'use client';

import {useEffect, useState, useTransition} from 'react';
import {createPortal} from 'react-dom';
import {useRouter} from 'next/navigation';
import {Menu} from '@base-ui/react/menu';
import {Check, ChevronDown, Loader2, ShieldCheck} from 'lucide-react';
import {setActiveView} from '@/app/actions/company';
import {companyHue, groupViews, monogram, type SwitcherView} from '@/src/view-switcher';
import {cn} from '@/lib/utils';
import {brandFor} from '@/src/brands';
import {homeFor} from '@/src/company-nav';
import {BrandMark} from '@/components/analyst/brand-mark';

// Multi-role view switcher in the top bar. Only rendered (by the shell) when the
// user holds more than one view. Writes the choice via a server action (cookie)
// then refreshes so every server component re-resolves the active view.
//
// Menu: the cross-tenant Coop Admin view is pinned on top and set apart by a
// divider (it sees no business data, so it's a different kind of place), then the
// companies A–Z. Each company carries a stable color badge so the views are told
// apart at a glance, in the menu and on the trigger.

const ROLE_LABEL: Record<string, string> = {
  coop_admin: 'Coop Admin',
  company_admin: 'Company User',
  analyst: 'Analyst',
  store_manager: 'Store Manager',
};

const roleLabel = (v: SwitcherView) => ROLE_LABEL[v.role] ?? v.role;
const title = (v: SwitcherView) => (v.companyId ? v.name : 'Coop Admin');

/** The view's badge: a colored monogram for a company, a shield for Coop Admin. */
export function ViewBadge({view, size = 'md'}: {view: SwitcherView; size?: 'sm' | 'md'}) {
  const box = size === 'sm' ? 'size-5 rounded-[5px] text-[9px]' : 'size-7 rounded-md text-[11px]';
  if (!view.companyId) {
    return (
      <span aria-hidden className={cn('flex shrink-0 items-center justify-center bg-foreground/10 text-foreground', box)}>
        <ShieldCheck className={size === 'sm' ? 'size-3' : 'size-3.5'} />
      </span>
    );
  }
  return (
    <span
      aria-hidden
      style={{['--hue' as string]: companyHue(view.companyId)}}
      className={cn(
        'flex shrink-0 items-center justify-center font-semibold tracking-tight',
        'bg-[oklch(0.62_0.12_var(--hue)/0.16)] text-[oklch(0.45_0.11_var(--hue))] ring-1 ring-[oklch(0.62_0.12_var(--hue)/0.28)] ring-inset',
        'dark:bg-[oklch(0.75_0.12_var(--hue)/0.16)] dark:text-[oklch(0.84_0.1_var(--hue))] dark:ring-[oklch(0.75_0.12_var(--hue)/0.3)]',
        box,
      )}
    >
      {monogram(view.name)}
    </span>
  );
}

const ITEM =
  'group flex w-full cursor-default items-center gap-2.5 rounded-lg px-2 py-1.5 text-left outline-none select-none data-[highlighted]:bg-muted data-[checked]:bg-muted/60';

function ViewItem({view}: {view: SwitcherView}) {
  const brand = brandFor(view.companyId);
  return (
    <Menu.RadioItem value={view.key} closeOnClick className={ITEM}>
      {/* Fixed-width logo slot so names line up whether a row has a wordmark or a badge. */}
      <span className="flex w-[5.75rem] shrink-0 items-center">
        {brand ? <BrandMark brand={brand} size={brand.style === 'thin' ? 11 : 14} /> : <ViewBadge view={view} />}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[13px] font-medium text-foreground">{title(view)}</span>
        <span className="truncate text-[11px] text-muted-foreground">
          {view.companyId ? `${roleLabel(view)}${brand ? ` · ${brand.about}` : ''}` : 'People & roles · no business data'}
        </span>
      </span>
      <Menu.RadioItemIndicator className="flex shrink-0 text-primary">
        <Check className="size-4" />
      </Menu.RadioItemIndicator>
    </Menu.RadioItem>
  );
}

export function ViewSwitcher({views, activeKey}: {views: SwitcherView[]; activeKey: string}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  // Switch overlay: 'in' while the new view loads, 'out' for the exit fade, then gone.
  const [switching, setSwitching] = useState<{view: SwitcherView; phase: 'in' | 'out'; started: boolean} | null>(null);
  useEffect(() => {
    if (!switching || switching.phase === 'out') return;
    // Wait until the switch has actually been pending, so the veil can't vanish before
    // the transition registers; then fade out once the new view has rendered.
    if (pending) {
      if (!switching.started) setSwitching({...switching, started: true});
      return;
    }
    if (switching.started) setSwitching({...switching, phase: 'out'});
  }, [pending, switching]);
  // Remove the overlay after its exit fade. Separate effect keyed on the phase, so
  // the state change above can't cancel this timer.
  // If the switch never registers as pending (e.g. pushing to the URL we're already
  // on), don't wait for the 8 s net — start the exit after a short beat.
  const waiting = switching?.phase === 'in' && !switching.started;
  useEffect(() => {
    if (!waiting) return;
    const t = setTimeout(() => setSwitching((s) => (s && !s.started ? {...s, phase: 'out'} : s)), 1500);
    return () => clearTimeout(t);
  }, [waiting]);
  // Safety net: never leave the veil up if a switch stalls.
  const showing = Boolean(switching);
  useEffect(() => {
    if (!showing) return;
    const t = setTimeout(() => setSwitching(null), 8000);
    return () => clearTimeout(t);
  }, [showing]);
  const leaving = switching?.phase === 'out';
  useEffect(() => {
    if (!leaving) return;
    const t = setTimeout(() => setSwitching(null), 180);
    return () => clearTimeout(t);
  }, [leaving]);
  const active = views.find((v) => v.key === activeKey) ?? views[0];
  const {coop, companies} = groupViews(views);
  const activeBrand = brandFor(active?.companyId);

  function choose(key: string) {
    const next = views.find((v) => v.key === key);
    if (key === activeKey || !next) return;
    setSwitching({view: next, phase: 'in', started: false});
    startTransition(async () => {
      await setActiveView(key); // sets the cookie + revalidates the layout (fresh RSC on push)
      // Land on the new view's home — the current page belongs to the previous view
      // (e.g. Goldline's /uploads isn't part of Zoomy). Kept inside the transition so
      // the switcher stays pending until the new page starts rendering.
      startTransition(() => router.push(homeFor({isCoopAdmin: next.companyId === null, companyId: next.companyId})));
    });
  }

  return (
    <>
    {switching && typeof document !== 'undefined' && createPortal(<SwitchOverlay view={switching.view} leaving={switching.phase === 'out'} />, document.body)}
    {/* Always-present live region: announced reliably (an inserted role=status often isn't). */}
    <span className="sr-only" role="status" aria-live="polite">
      {switching?.phase === 'in' ? `Switching to ${switching.view.companyId ? switching.view.name : 'Coop Admin'}` : ''}
    </span>
    <Menu.Root>
      <Menu.Trigger
        disabled={pending}
        aria-label={active ? `Current view: ${title(active)}${active.companyId ? `, ${roleLabel(active)}` : ''}. Switch view` : 'Switch view'}
        className="group flex h-8 max-w-[16rem] items-center gap-2 rounded-lg border border-border bg-background pr-2 pl-1 text-[13px] font-medium text-foreground outline-none transition-[background-color,transform] duration-150 ease-out hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/40 active:scale-[0.98] data-[popup-open]:bg-muted disabled:opacity-60"
      >
        {activeBrand ? (
          // The company's wordmark stands in for its name (which stays in aria-label).
          <span className="flex items-center pl-1.5">
            <BrandMark brand={activeBrand} size={activeBrand.style === 'thin' ? 11 : 13} />
          </span>
        ) : (
          <>
            {active && <ViewBadge view={active} size="sm" />}
            <span className="truncate max-sm:max-w-[8.5rem]">{active ? title(active) : 'Select view'}</span>
          </>
        )}
        {pending ? (
          <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
        ) : (
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground transition-transform duration-150 ease-out group-data-[popup-open]:rotate-180" />
        )}
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="bottom" align="start" sideOffset={8} className="z-50">
          <Menu.Popup className="w-80 origin-[var(--transform-origin)] rounded-xl border border-border bg-popover p-1.5 text-popover-foreground shadow-lg outline-none transition-[opacity,transform] duration-150 ease-out data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0">
            <Menu.RadioGroup value={activeKey} onValueChange={(value) => choose(String(value))}>
              {coop && (
                <>
                  <ViewItem view={coop} />
                  <Menu.Separator className="mx-1 my-1.5 h-px bg-border" />
                </>
              )}
              {companies.length > 0 && (
                <Menu.Group>
                  {coop && (
                    <Menu.GroupLabel className="px-2 pt-0.5 pb-1 text-[11px] font-medium text-muted-foreground">Companies</Menu.GroupLabel>
                  )}
                  {companies.map((v) => (
                    <ViewItem key={v.key} view={v} />
                  ))}
                </Menu.Group>
              )}
            </Menu.RadioGroup>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
    </>
  );
}

/**
 * The view-switch moment: the page veils and the destination's mark eases in while
 * the new view loads, then the veil fades out over it — a quick crossfade between
 * tenants. Enter 200 ms / exit 160 ms, strong ease-out (exit faster than enter);
 * reduced motion keeps only a short fade. Visual only (aria-hidden); the switcher's
 * persistent live region announces the switch.
 */
function SwitchOverlay({view, leaving}: {view: SwitcherView; leaving: boolean}) {
  const brand = brandFor(view.companyId);
  const name = view.companyId ? view.name : 'Coop Admin';
  return (
    <div
      aria-hidden
      data-leaving={leaving || undefined}
      className="fixed inset-0 z-[60] flex items-center justify-center bg-background/70 backdrop-blur-[3px] transition-opacity duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] starting:opacity-0 data-[leaving]:opacity-0 data-[leaving]:duration-[170ms] motion-reduce:backdrop-blur-none"
    >
      <div className="flex flex-col items-center gap-3 rounded-2xl border border-border bg-popover px-8 py-6 shadow-xl transition-[transform,opacity] duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] starting:scale-[0.96] starting:opacity-0 motion-reduce:transition-opacity motion-reduce:starting:scale-100">
        {brand ? <BrandMark brand={brand} size={brand.style === 'thin' ? 18 : 24} /> : <ViewBadge view={view} />}
        <span className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 aria-hidden className="size-3.5 animate-spin motion-reduce:animate-none" />
          Switching to {name}…
        </span>
      </div>
    </div>
  );
}
