import {getDataContext} from '@/src/active-context';
import {canEditData} from '@/src/company';
import {getFlagsData} from '@/src/goldline-flags-data';
import {flagLines} from '@/src/goldline-flag-lines-data';
import {parseFlagFilter} from '@/src/goldline-flag-lines';
import {flagsHubEnabled} from '@/src/goldline-flag-hub';
import {GoldlineFlags} from '@/components/analyst/goldline-flags';
import {FlagsHub} from '@/components/analyst/flags-hub';
import {FlagsHubShell} from '@/components/analyst/flags-hub-shell';

export const dynamic = 'force-dynamic';

type Search = Record<string, string | string[] | undefined>;

// Flag queue and adjustments (Goldline · F7, F5). Store-scoped roles see their stores only.
// With GOLDLINE_FLAGS_HUB=1 this is the Flags hub: All flags first (every check, reader and
// reviewer flag), BA scorecard second (?view=ba). Each view reads only what it shows.
export default async function Page(props: {searchParams: Promise<Search>}) {
  const sp = await props.searchParams;
  const one = (k: string) => (typeof sp[k] === 'string' ? (sp[k] as string) : null);
  const ctx = await getDataContext();
  if (!ctx || !ctx.companyId) {
    return (
      <div className="mx-auto flex min-h-[50vh] max-w-md flex-col items-center justify-center gap-2 text-center">
        <h1 className="font-heading text-lg font-semibold">No company in view</h1>
        <p className="text-sm text-muted-foreground">Pick a company you belong to to see its flags.</p>
      </div>
    );
  }
  const scope = Array.isArray(ctx.storeScope) ? ctx.storeScope : null;
  const canEdit = canEditData(ctx.role);
  const hub = flagsHubEnabled();

  if (hub && one('view') !== 'ba') {
    const data = await flagLines(ctx.companyId, scope);
    const initial = parseFlagFilter({store: one('store'), month: one('month'), source: one('source'), status: 'all', q: one('q')});
    // The open tile (?kind=) and its page (?p=) are read on the client: opening a tile is a
    // pushed Back step in the same page, not a new request.
    return (
      <FlagsHubShell view="all" company={ctx.companyId} canEdit={canEdit}>
        <FlagsHub data={data} initial={initial} company={ctx.companyId} canEdit={canEdit} />
      </FlagsHubShell>
    );
  }

  const data = await getFlagsData(ctx.companyId, scope);
  // Deep link from the BA scorecard: ?open=<store|YYYY-MM|BA> opens that tile.
  const openKey = one('open');
  const open = openKey && data.tiles.some((t) => t.key === openKey) ? openKey : null;
  const m = one('month');
  const month = m && /^\d{4}-\d{2}$/.test(m) ? m : (open?.split('|')[1] ?? null);
  const board = <GoldlineFlags company={ctx.companyId} data={data} canEdit={canEdit} initialOpen={open} initialMonth={month} embedded={hub} />;
  return hub ? (
    <FlagsHubShell view="ba" company={ctx.companyId} canEdit={canEdit}>
      {board}
    </FlagsHubShell>
  ) : (
    board
  );
}
