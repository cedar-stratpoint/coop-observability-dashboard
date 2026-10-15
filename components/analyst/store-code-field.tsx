'use client';

import {useState} from 'react';
import type {StoreOption} from '@/src/goldline-data';
import {SearchableSelect} from '@/components/analyst/searchable-select';
import {cn} from '@/lib/utils';

// Store picker for an inventory count: a searchable list of the company's stores
// ("1 · CUBAO"), with "Other store code…" for a store that isn't listed yet — so an
// upload is never blocked on the store list. A code that came from page 1's printed
// header (or an old upload) and isn't in the list opens in "other" mode with it filled.

const OTHER = '__other__';

export function StoreCodeField({
  value,
  onChange,
  stores,
  disabled,
  className,
}: {
  value: string;
  onChange: (code: string) => void;
  stores: StoreOption[];
  disabled?: boolean;
  className?: string;
}) {
  const listed = stores.some((s) => s.code === value);
  const [other, setOther] = useState(Boolean(value) && !listed);
  const showOther = other || (Boolean(value) && !listed);

  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)}>
      <div className={cn('w-56', disabled && 'pointer-events-none opacity-60')}>
        <SearchableSelect
          ariaLabel="Store"
          value={showOther ? OTHER : value}
          placeholder={stores.length ? 'Choose a store…' : 'No stores listed yet'}
          onChange={(v) => {
            if (v === OTHER) {
              setOther(true);
              if (listed) onChange('');
              return;
            }
            setOther(false);
            onChange(v);
          }}
          options={[
            ...stores.map((s) => ({value: s.code, label: `${s.code} · ${s.name}`})),
            {value: OTHER, label: 'Other store code…', hint: 'not in the list yet'},
          ]}
          className="h-9"
        />
      </div>
      {showOther && (
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          autoFocus={other && !value}
          aria-label="Store code"
          placeholder="Store code"
          className="h-9 w-28 rounded-md border border-border bg-background px-2.5 text-sm outline-none transition-colors hover:border-foreground/25 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40 disabled:opacity-60"
        />
      )}
    </div>
  );
}
