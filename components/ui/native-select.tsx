import * as React from 'react';
import {ChevronDown} from 'lucide-react';
import {cn} from '@/lib/utils';

// A native <select> with the browser's own arrow hidden and a drawn chevron inset
// from the edge. Browsers paint their arrow flush against the right padding, so a
// plain `px-2` select looks cramped next to our buttons and inputs. Keeps native
// behavior (keyboard, mobile pickers, form semantics); only the chrome changes.
export function NativeSelect({className, wrapperClassName, children, ...props}: React.ComponentProps<'select'> & {wrapperClassName?: string}) {
  return (
    <span className={cn('relative inline-flex', wrapperClassName)}>
      <select
        className={cn(
          'h-8 w-full appearance-none rounded-md border border-border bg-background pr-8 pl-2.5 text-sm text-foreground outline-none transition-colors',
          'hover:border-foreground/25 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40 disabled:opacity-50',
          className,
        )}
        {...props}
      >
        {children}
      </select>
      <ChevronDown
        aria-hidden
        className="pointer-events-none absolute top-1/2 right-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
      />
    </span>
  );
}
