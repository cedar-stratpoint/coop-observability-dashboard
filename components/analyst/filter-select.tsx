import {cn} from '@/lib/utils';

/** One labelled dropdown. Native select on purpose: it is the control every
 * admin already knows, and it works on a phone without a popover library. */
export function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: Array<[string, string]>;
}) {
  return (
    <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
      {label}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={cn(
          'h-8 rounded-lg border bg-background px-2 text-xs text-foreground outline-none',
          'focus-visible:border-primary',
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
