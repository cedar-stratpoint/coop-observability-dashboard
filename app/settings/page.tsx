import {redirect} from 'next/navigation';
import {auth} from '@/auth';
import {getActiveContext, getNavContext} from '@/src/active-context';
import {homeFor, shouldRedirectFromZoomy} from '@/src/company-nav';
import {fetchViewPrefs} from '@/src/company';
import {SettingsTab} from '@/components/analyst/tabs';
import {StartViewSettings} from '@/components/analyst/start-view-settings';

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

  if (zoomy) return <SettingsTab before={startView} />;
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
