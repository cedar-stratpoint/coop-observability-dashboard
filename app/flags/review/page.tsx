import {getDataContext} from '@/src/active-context';
import {flagLines} from '@/src/goldline-flag-lines-data';
import {parseFlagFilter} from '@/src/goldline-flag-lines';
import {FlagLines} from '@/components/analyst/flag-lines';
import {redirect} from 'next/navigation';
import {flagsHubEnabled} from '@/src/goldline-flag-hub';

export const dynamic = 'force-dynamic';

// Every flag with its page and row, why, store and BA (NICH-43 §3, §4). Store-limited roles see
// their stores only.
export default async function Page(props: {searchParams: Promise<Record<string, string | string[] | undefined>>}) {
  const sp = await props.searchParams;
  const one = (k: string) => (typeof sp[k] === 'string' ? (sp[k] as string) : null);
  // The Flags hub folds this list into All flags; old links keep their filters.
  if (flagsHubEnabled()) {
    const keep = new URLSearchParams();
    for (const k of ['store', 'month', 'source', 'q']) {
      const v = one(k);
      if (v) keep.set(k, v);
    }
    redirect(`/flags${keep.size ? `?${keep}` : ''}`);
  }
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
  const data = await flagLines(ctx.companyId, scope);
  const initial = parseFlagFilter({store: one('store'), month: one('month'), source: one('source'), status: one('status'), q: one('q')});
  return <FlagLines data={data} initial={initial} />;
}
