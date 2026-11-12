'use client';

import {useCallback, useRef, useState} from 'react';
import {createPortal} from 'react-dom';
import {Popover} from '@base-ui/react/popover';
import {Info} from 'lucide-react';
import {cn} from '@/lib/utils';

const TIP_W = 220;

/** A small ⓘ trigger that reveals an explanatory tooltip on hover/focus. The
 *  bubble is portaled to <body> with fixed positioning + viewport clamping, so
 *  it is never cropped by an ancestor's overflow or the screen edge. */
export function InfoTip({text, className}: {text: string; className?: string}) {
  const ref = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<{top: number; left: number} | null>(null);

  const show = useCallback(() => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    // Center under the icon, but clamp so the bubble stays fully on screen.
    const half = TIP_W / 2;
    const left = Math.min(Math.max(r.left + r.width / 2, half + 8), window.innerWidth - half - 8);
    setPos({top: r.bottom + 7, left});
  }, []);
  const hide = useCallback(() => setPos(null), []);

  return (
    <span className={cn('inline-flex align-middle', className)}>
      <button
        ref={ref}
        type="button"
        aria-label={text}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        className="inline-flex items-center rounded-full text-muted-foreground/55 outline-none transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-primary/40"
      >
        <Info className="size-[13px]" />
      </button>
      {pos &&
        typeof document !== 'undefined' &&
        createPortal(
          <span
            role="tooltip"
            style={{position: 'fixed', top: pos.top, left: pos.left, width: 'max-content', maxWidth: TIP_W, transform: 'translateX(-50%)'}}
            className="pointer-events-none z-[200] rounded-lg bg-foreground px-2.5 py-1.5 text-[11px] font-normal normal-case leading-snug tracking-normal text-background shadow-lg"
          >
            {text}
          </span>,
          document.body,
        )}
    </span>
  );
}

/** The ⓘ for a longer explainer (a list of what each value means): a popover that opens on hover or on a tap, so a phone can read it
 *  too, and stays open while the pointer is over it. Scales in from its trigger. */
export function InfoPop({label, children, className}: {label: string; children: React.ReactNode; className?: string}) {
  return (
    <Popover.Root>
      <Popover.Trigger
        openOnHover
        delay={120}
        aria-label={label}
        className={cn(
          'inline-flex items-center rounded-full align-middle text-muted-foreground/55 outline-none transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-primary/40 data-[popup-open]:text-foreground',
          className,
        )}
      >
        <Info className="size-[13px]" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="start" sideOffset={6} collisionPadding={8} className="z-[200]">
          <Popover.Popup className="w-72 max-w-[calc(100vw-16px)] origin-[var(--transform-origin)] space-y-1.5 rounded-lg border bg-popover p-3 text-left text-xs font-normal normal-case leading-snug tracking-normal text-popover-foreground shadow-md outline-none transition-[opacity,transform] duration-150 ease-out data-[ending-style]:scale-[0.97] data-[ending-style]:opacity-0 data-[starting-style]:scale-[0.97] data-[starting-style]:opacity-0">
            {children}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
