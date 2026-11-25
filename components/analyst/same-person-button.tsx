'use client';

// RET-15 Slice B: "Same person" on a row of Ask Coop's matches table (website CRM x event leads). One click saves an
// owner-approved link; the customer's record is unchanged, the Website CRM table just shows the booth's Instagram and event.
import {useState, useTransition} from 'react';
import {Check, Link2} from 'lucide-react';
import {cn} from '@/lib/utils';
import {linkPeople} from '../../src/customer-links-actions';
import {samePersonOffer} from '../../src/customer-links';
import type {MetricRow} from '../../src/chat/result-types';

// A real button, not a chip: filled in the brand colour with an icon, a hover and a press, so it reads as an action at a glance.
const BTN = 'inline-flex items-center gap-1 whitespace-nowrap rounded-md bg-primary px-2.5 py-1 text-[11px] font-semibold text-primary-foreground shadow-sm transition-[background-color,transform] duration-150 hover:bg-primary/90 active:scale-[0.97] disabled:cursor-wait disabled:opacity-60 motion-reduce:transition-none outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-1';

export function SamePersonCell({row}: {row: MetricRow}) {
  const offer = samePersonOffer(row);
  const [state, setState] = useState<'idle' | 'linked'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  if (offer === null) return null;
  if (offer === 'exact') return <span className="whitespace-nowrap text-[11px] text-muted-foreground">Already matched</span>;
  if (state === 'linked') return <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-md bg-primary/10 px-2 py-1 text-[11px] font-semibold text-primary"><Check className="size-3" aria-hidden />Linked</span>;
  return (
    <span className="flex flex-col items-start gap-0.5">
      <button
        type="button"
        disabled={pending}
        className={cn(BTN)}
        onClick={() =>
          start(async () => {
            const r = await linkPeople(offer.link);
            if (r.ok) {
              setError(null);
              setState('linked');
            } else setError(r.error);
          })
        }
      >
        <Link2 className="size-3" aria-hidden />
        {pending ? 'Linking…' : 'Same person'}
      </button>
      {error && <span role="alert" className="max-w-[16rem] whitespace-normal text-[11px] text-muted-foreground">{error}</span>}
    </span>
  );
}
