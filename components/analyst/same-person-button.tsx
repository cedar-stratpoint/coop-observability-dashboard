'use client';

// RET-15 Slice B: "Same person" on a row of Ask Coop's matches table (website CRM x event leads). One click saves an
// owner-approved link; the customer's record is unchanged, the Website CRM table just shows the booth's Instagram and event.
import {useState, useTransition} from 'react';
import {cn} from '@/lib/utils';
import {linkPeople} from '../../src/customer-links-actions';
import {samePersonOffer} from '../../src/customer-links';
import type {MetricRow} from '../../src/chat/result-types';

const BTN = 'rounded-md border border-border px-2 py-0.5 text-[11px] font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50 motion-reduce:transition-none outline-none focus-visible:ring-2 focus-visible:ring-ring/50';

export function SamePersonCell({row}: {row: MetricRow}) {
  const offer = samePersonOffer(row);
  const [state, setState] = useState<'idle' | 'linked'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  if (offer === null) return null;
  if (offer === 'exact') return <span className="whitespace-nowrap text-[11px] text-muted-foreground">Already matched</span>;
  if (state === 'linked') return <span className="whitespace-nowrap text-[11px] font-medium text-foreground">Linked ✓</span>;
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
        {pending ? 'Linking…' : 'Same person'}
      </button>
      {error && <span role="alert" className="max-w-[16rem] whitespace-normal text-[11px] text-muted-foreground">{error}</span>}
    </span>
  );
}
