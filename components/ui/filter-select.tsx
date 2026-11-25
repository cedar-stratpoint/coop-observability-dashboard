'use client';

import type {ReactNode} from 'react';
import {Select} from '@base-ui/react/select';
import {Check, ChevronDown} from 'lucide-react';
import {cn} from '@/lib/utils';

// A compact, themed dropdown for list filters (replaces the OS-drawn <select> menu).
// The trigger is a pill that tints when it holds anything but its default ("All …"),
// so a glance at the filter row shows what's narrowing the list. Base UI handles
// keyboard, typeahead and focus; the popup scales in from the trigger.

export type FilterOption<V extends string> = {
  value: V;
  label: string;
  /** A CSS color for a small dot before the label (e.g. a status color). */
  dot?: string;
};

const EASE = 'ease-[cubic-bezier(0.23,1,0.32,1)]';

/** Shared pill look for filter triggers (FilterSelect, the date-range filter). */
export const FILTER_PILL = cn(
  'group inline-flex h-8 max-w-full items-center gap-2 rounded-full border bg-background pr-2 pl-3 text-xs font-medium outline-none select-none',
  'transition-[border-color,background-color,color,scale] duration-150',
  EASE,
  'pointer-fine:hover:border-foreground/25 active:scale-[0.97] active:duration-100 motion-reduce:active:scale-100',
  'focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40',
  'data-[popup-open]:border-foreground/30 data-[popup-open]:bg-muted/60',
);
export const FILTER_PILL_IDLE = 'border-border text-muted-foreground pointer-fine:hover:text-foreground';
export const FILTER_PILL_ACTIVE = 'border-primary/45 bg-primary/10 text-foreground pointer-fine:hover:border-primary/70';

/** Shared popup surface: scales in from the trigger, fades out a touch faster. */
export const FILTER_POPUP = cn(
  'origin-[var(--transform-origin)] rounded-xl border bg-popover p-1 text-popover-foreground outline-none',
  'shadow-[0_16px_40px_-16px_color-mix(in_oklab,var(--foreground)_35%,transparent)]',
  'transition-[opacity,scale] duration-150',
  EASE,
  'data-[starting-style]:scale-[0.96] data-[starting-style]:opacity-0 data-[ending-style]:scale-[0.98] data-[ending-style]:opacity-0 data-[ending-style]:duration-100',
  'motion-reduce:data-[starting-style]:scale-100 motion-reduce:data-[ending-style]:scale-100',
);

function Dot({color}: {color: string}) {
  return <span aria-hidden className="size-2 shrink-0 rounded-full" style={{background: color}} />;
}

export function FilterSelect<V extends string>({
  value,
  onValueChange,
  options,
  defaultValue,
  label,
  icon,
  className,
}: {
  value: V;
  onValueChange: (next: V) => void;
  options: Array<FilterOption<V>>;
  /** The "no filter" value; any other value tints the trigger. */
  defaultValue: V;
  /** Accessible name, e.g. "Filter by status". */
  label: string;
  icon?: ReactNode;
  className?: string;
}) {
  const active = value !== defaultValue;
  const current = options.find((o) => o.value === value);
  return (
    <Select.Root
      items={options.map((o) => ({value: o.value, label: o.label}))}
      value={value}
      onValueChange={(v) => v != null && onValueChange(v as V)}
    >
      <Select.Trigger aria-label={label} className={cn(FILTER_PILL, active ? FILTER_PILL_ACTIVE : FILTER_PILL_IDLE, className)}>
        {current?.dot && active ? <Dot color={current.dot} /> : icon}
        <Select.Value className="truncate" />
        <Select.Icon className="flex">
          <ChevronDown aria-hidden className={cn('size-3.5 text-muted-foreground transition-transform duration-200 group-data-[popup-open]:rotate-180', EASE)} />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Positioner alignItemWithTrigger={false} side="bottom" align="start" sideOffset={6} className="z-50 outline-none select-none">
          <Select.Popup className={cn(FILTER_POPUP, 'min-w-[max(var(--anchor-width),12rem)]')}>
            <Select.List className="max-h-[min(20rem,var(--available-height))] overflow-y-auto overscroll-contain">
              {options.map((o) => (
                <Select.Item
                  key={o.value}
                  value={o.value}
                  className={cn(
                    'flex cursor-default items-center gap-2.5 rounded-lg py-2 pr-2.5 pl-2.5 text-sm outline-none select-none',
                    'text-foreground/85 transition-colors duration-100 data-[highlighted]:bg-muted data-[highlighted]:text-foreground data-[selected]:text-foreground',
                  )}
                >
                  {o.dot ? <Dot color={o.dot} /> : <span aria-hidden className="size-2 shrink-0" />}
                  <Select.ItemText className="flex-1">{o.label}</Select.ItemText>
                  <Select.ItemIndicator className="flex">
                    <Check aria-hidden className="size-3.5 text-primary" />
                  </Select.ItemIndicator>
                </Select.Item>
              ))}
            </Select.List>
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  );
}
