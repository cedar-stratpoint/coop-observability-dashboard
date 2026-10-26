'use client';

import {useState, useTransition} from 'react';
import {useRouter} from 'next/navigation';
import {RefreshCw} from 'lucide-react';
import {updateSpinLeads} from '@/src/spin-leads-actions';
import {cn} from '@/lib/utils';

/**
 * Pull new spin-the-wheel leads from the storefront (Shopify, via the CRM
 * worker) into Coop, replacing the CSV export + import. Adds only leads Coop
 * doesn't have; pressing it again is harmless.
 */
export function LeadsUpdateButton() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [status, setStatus] = useState<{tone: 'ok' | 'error'; text: string} | null>(null);

  const onUpdate = () =>
    startTransition(async () => {
      setStatus(null);
      const res = await updateSpinLeads();
      if (!res.ok) return setStatus({tone: 'error', text: res.error});
      const parts = [
        res.added && `${res.added} new lead${res.added === 1 ? '' : 's'} added`,
        res.named && `${res.named} name${res.named === 1 ? '' : 's'} filled in`,
      ].filter(Boolean);
      setStatus({tone: 'ok', text: parts.length ? parts.join(', ') : 'Already up to date'});
      router.refresh();
    });

  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {status && (
        <span role="status" className={cn('text-xs', status.tone === 'error' ? 'text-destructive' : 'text-muted-foreground')}>
          {status.text}
        </span>
      )}
      <button
        type="button"
        onClick={onUpdate}
        disabled={pending}
        className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground disabled:opacity-60"
      >
        <RefreshCw className={cn('size-3', pending && 'animate-spin motion-reduce:animate-none')} />
        {pending ? 'Updating…' : 'Update leads'}
      </button>
    </div>
  );
}
