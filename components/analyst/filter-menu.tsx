'use client';

// Shared filter-bar primitives (Hick's law): a row of stable category triggers,
// each keeping its choices behind its own dropdown, plus a row of removable
// "applied" pills so the active state never has to be decoded from the controls.
// Transactions drives these with URL hrefs; Inventory drives them with callbacks
// (its Line/Status/Location filters are client-side over the loaded rows).

import {useState} from 'react';
import {Popover} from '@base-ui/react/popover';
import {Check, ChevronDown, X, type LucideIcon} from 'lucide-react';
import {cn} from '@/lib/utils';

export const POPUP =
  'z-50 origin-[var(--transform-origin)] rounded-lg border bg-popover text-popover-foreground shadow-md outline-none transition-[opacity,transform] duration-150 ease-out data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0';

/** Shared look for every category trigger: a stable label, plus a dot when applied. */
export function triggerClass(active: boolean) {
  return cn(
    'inline-flex h-8 items-center gap-1.5 rounded-lg border bg-card px-3 text-xs font-medium transition-[color,border-color,transform] duration-150 ease-out active:scale-[0.97] data-[popup-open]:border-foreground/30 data-[popup-open]:text-foreground',
    active ? 'border-primary/40 text-foreground' : 'text-muted-foreground hover:border-foreground/20 hover:text-foreground',
  );
}

export function TriggerContent({icon: Icon, label, active}: {icon: LucideIcon; label: string; active: boolean}) {
  return (
    <>
      <Icon className="size-3.5" aria-hidden />
      {label}
      {active && (
        <>
          <span className="size-1.5 rounded-full bg-primary" aria-hidden />
          <span className="sr-only">(applied)</span>
        </>
      )}
      <ChevronDown className="size-3 opacity-60" aria-hidden />
    </>
  );
}

export type FilterOption = {value: string | null; label: string; count?: number};

/**
 * Single-choice dropdown driven by a callback. The first option with value null
 * is the "any" row; a divider separates it from the real choices. An optional
 * count renders right-aligned so a status menu doubles as a triage readout.
 */
export function FilterMenu({
  icon,
  label,
  options,
  selected,
  onSelect,
  width = 'w-48',
}: {
  icon: LucideIcon;
  label: string;
  options: FilterOption[];
  selected: string | null;
  onSelect: (value: string | null) => void;
  width?: string;
}) {
  const [open, setOpen] = useState(false);
  const active = selected != null;
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger className={triggerClass(active)}>
        <TriggerContent icon={icon} label={label} active={active} />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="start" sideOffset={6}>
          <Popover.Popup className={cn(POPUP, width, 'max-h-80 overflow-y-auto p-1')}>
            {options.map((o, i) => {
              const isActive = o.value === selected;
              return (
                <div key={o.value ?? 'any'}>
                  <button
                    type="button"
                    onClick={() => {onSelect(o.value); setOpen(false);}}
                    aria-pressed={isActive}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-muted',
                      isActive ? 'font-medium text-foreground' : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    <span className="min-w-0 flex-1 truncate">{o.label}</span>
                    {o.count != null && <span className="font-mono text-[10px] tabular-nums text-muted-foreground">{o.count}</span>}
                    <Check className={cn('size-3.5 shrink-0 text-primary', !isActive && 'invisible')} aria-hidden />
                  </button>
                  {i === 0 && o.value === null && <div className="mx-2 my-1 h-px bg-border" />}
                </div>
              );
            })}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

export type AppliedFilter = {key: string; category: string; value: string; onRemove: () => void};

/** The applied-filter readback: one removable pill per filter, then Clear all. */
export function AppliedFilters({pills, onClearAll}: {pills: AppliedFilter[]; onClearAll: () => void}) {
  if (pills.length === 0) return null;
  return (
    <ul aria-label="Applied filters" className="flex flex-wrap items-center gap-2">
      {pills.map((p) => (
        <li
          key={p.key}
          className="inline-flex h-7 max-w-full items-center gap-1.5 rounded-full border border-primary/25 bg-primary/8 pr-1 pl-3 text-xs transition-[opacity,transform] duration-150 ease-out starting:scale-95 starting:opacity-0"
        >
          <span className="shrink-0 text-muted-foreground">{p.category}</span>
          <span className="min-w-0 truncate font-medium text-foreground">{p.value}</span>
          <button
            type="button"
            onClick={p.onRemove}
            aria-label={`Remove ${p.category} filter: ${p.value}`}
            title={`Remove ${p.category} filter`}
            className="grid size-5 shrink-0 place-items-center rounded-full text-muted-foreground transition-[color,background-color,transform] duration-150 ease-out hover:bg-primary/15 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none active:scale-90"
          >
            <X className="size-3" aria-hidden />
          </button>
        </li>
      ))}
      <li>
        <button
          type="button"
          onClick={onClearAll}
          className="inline-flex h-7 items-center rounded-md px-2 text-xs font-medium text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline"
        >
          Clear all
        </button>
      </li>
    </ul>
  );
}
