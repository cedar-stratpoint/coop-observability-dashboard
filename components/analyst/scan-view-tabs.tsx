'use client';

import Link from 'next/link';
import {useEffect, useState} from 'react';
import {LayoutGrid, List, Users} from 'lucide-react';
import {cn} from '@/lib/utils';

export type ScanView = 'file' | 'store' | 'ba';

const TABS: Array<{key: ScanView; label: string; Icon: typeof List}> = [
  {key: 'file', label: 'Per file', Icon: List},
  {key: 'store', label: 'Per store', Icon: LayoutGrid},
  {key: 'ba', label: 'Per BA', Icon: Users},
];

/** The scan's view switch: a segmented control whose highlight slides to the chosen tab. The
 *  highlight moves on click (before the server render lands), then follows the URL, so the switch
 *  answers instantly even while the next view loads. Equal-width tabs keep the slide a pure
 *  translate. */
export function ScanViewTabs({view, hrefs}: {view: ScanView; hrefs: Record<ScanView, string>}) {
  const [selected, setSelected] = useState<ScanView>(view);
  useEffect(() => setSelected(view), [view]);
  const index = Math.max(0, TABS.findIndex((t) => t.key === selected));
  return (
    <div role="tablist" aria-label="View this scan by" className="relative grid grid-cols-3 rounded-xl bg-muted/70 p-1 ring-1 ring-border/70 ring-inset">
      <span
        aria-hidden
        className="pointer-events-none absolute inset-y-1 left-1 rounded-lg bg-background shadow-sm ring-1 ring-border/60 transition-transform duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none"
        style={{width: 'calc((100% - 0.5rem) / 3)', transform: `translateX(${index * 100}%)`}}
      />
      {TABS.map(({key, label, Icon}) => {
        const active = selected === key;
        return (
          <Link
            key={key}
            href={hrefs[key]}
            replace
            role="tab"
            aria-selected={active}
            onClick={() => setSelected(key)}
            className={cn(
              'relative z-10 inline-flex items-center justify-center gap-1.5 rounded-lg px-3.5 py-1.5 text-sm font-medium whitespace-nowrap transition-[color,transform] duration-150 ease-out active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 motion-reduce:transition-none',
              active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <Icon className="size-3.5" aria-hidden /> {label}
          </Link>
        );
      })}
    </div>
  );
}
