import {cn} from '@/lib/utils';

/** One labelled dropdown. Native select on purpose: it is the control every
 * admin already knows, and it works on a phone without a popover library. */
export function FilterSelect({
  label,
  value,
  onChange,
  options,
  disabled = false,
  title,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: Array<[string, string]>;
  /** A filter whose source could not be read: shown, but it cannot be used (unknown is never "none"). */
  disabled?: boolean;
  title?: string;
}) {
  return (
    <label className={cn('flex items-center gap-1.5 text-xs text-muted-foreground', disabled && 'opacity-60')} title={title}>
      {label}
      <select
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className={cn(
          'h-8 rounded-lg border bg-background px-2 text-xs text-foreground outline-none',
          'focus-visible:border-primary disabled:cursor-not-allowed',
          value === 'all' ? 'border-border' : 'border-primary text-primary',
        )}
      >
        {options.map(([v, l]) => (
          <option value={v} key={v}>
            {l}
          </option>
        ))}
      </select>
    </label>
  );
}
