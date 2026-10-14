'use client';

import {cn} from '@/lib/utils';

/**
 * A compact segmented pill toggle (the "Revenue | Units" / "Top | Bottom" style
 * used across the sales analytics). One shared implementation so every toggle on
 * the dashboard reads and animates identically.
 */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: readonly {value: T; label: string}[];
  value: T;
  onChange: (value: T) => void;
  ariaLabel?: string;
}) {
  return (
    <div role="group" aria-label={ariaLabel} className="inline-flex rounded-md border p-0.5 text-xs">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          aria-pressed={value === opt.value}
          className={cn(
            'rounded-[5px] px-2.5 py-1 font-medium transition-colors duration-150 ease-out active:scale-[0.97]',
            value === opt.value ? 'bg-muted text-foreground shadow-xs' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
