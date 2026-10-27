import {redirect} from 'next/navigation';
import {auth} from '@/auth';
import {getActiveContext, getNavContext} from '@/src/active-context';
import {homeFor, shouldRedirectFromZoomy} from '@/src/company-nav';
import {fetchViewPrefs} from '@/src/company';
import {SettingsTab} from '@/components/analyst/tabs';
import {StartViewSettings} from '@/components/analyst/start-view-settings';
import Link from 'next/link';
import {Laptop} from 'lucide-react';

export const dynamic = 'force-dynamic';

// Settings. Two independent sections:
//  • Starting view — only for people who hold more than one view (any view).
//  • Zoomy's digest preferences — only in the Zoomy view (they're Zoomy-specific;
//    this used to be guarded by the Zoomy-only layout).
// A non-Zoomy view with a single role has nothing to configure → its home.
export default async function Page() {
  const [ctx, nav, session] = await Promise.all([getActiveContext(), getNavContext(), auth()]);
  const zoomy = !shouldRedirectFromZoomy(ctx);
  const multi = Boolean(nav && nav.views.length > 1);
  if (!zoomy && !multi) redirect(homeFor(ctx));

  const prefs = multi ? await fetchViewPrefs(session?.user?.email) : null;
  const startView =
    multi && nav ? (
      <StartViewSettings views={nav.views} defaultView={prefs?.defaultView ?? null} lastView={prefs?.lastView ?? null} />
    ) : null;

  const syncLink = (
    <Link href="/settings/shopee-sync" className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3 transition-colors hover:border-foreground/25">
      <Laptop className="size-4 text-muted-foreground" aria-hidden />
      <span className="flex flex-col">
        <span className="text-sm font-medium text-foreground">Sync worker</span>
        <span className="text-[13px] text-muted-foreground">The cloud worker that loads Shopee days, and the Macs you add (My sync Macs).</span>
      </span>
    </Link>
  );
  if (zoomy)
    return (
      <SettingsTab
        before={
          <div className="flex flex-col gap-4">
            {startView}
            {syncLink}
          </div>
        }
      />
    );
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-heading text-xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">Choose where you land when you sign in.</p>
      </header>
      {startView}
    </div>
  );
}
