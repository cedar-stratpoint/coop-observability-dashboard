import Link from 'next/link';
import {ArrowLeft} from 'lucide-react';
import {requireZoomyData} from '@/src/active-context';
import {getShopeeSyncStatus} from '@/src/shopee-sync-data';
import {ShopeeSyncMacs} from '@/components/analyst/shopee-sync-macs';

export const dynamic = 'force-dynamic';

// Settings > Sync worker (and My sync Macs). This route is outside the Zoomy-only Settings guard (see app/settings/layout.tsx), and the sync is Zoomy data,
// so it guards itself. The reader returns null for anyone not signed in or not on ALLOWED_EMAILS.
export default async function Page() {
  await requireZoomyData();
  const status = await getShopeeSyncStatus();
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-6 md:px-6">
      <header className="flex flex-col gap-2">
        <Link href="/settings" className="inline-flex w-fit items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground">
          <ArrowLeft className="size-3.5" aria-hidden /> Settings
        </Link>
        <h1 className="font-serif text-3xl font-normal tracking-tight">Sync worker</h1>
        <p className="max-w-[60ch] text-sm text-muted-foreground">
          Sync loads the missing Shopee days from the one cloud worker. Nobody types the Shopee password in Coop: when Shopee asks, an admin signs in in the worker&apos;s own browser. A Mac you add yourself is a secondary path (up to 2 Macs each and 3 for the team).
        </p>
      </header>
      {status ? <ShopeeSyncMacs status={status} at={new Date().toISOString()} /> : <p className="rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground">You are not allowed to use Shopee sync with this account.</p>}
    </div>
  );
}
