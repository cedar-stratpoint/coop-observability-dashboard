import Link from 'next/link';
import {getDataContext} from '@/src/active-context';
import {canEditData} from '@/src/company';
import {getForecastData} from '@/src/goldline-forecast-data';
import {getRestockRun} from '@/src/goldline-restock-data';
import {manilaDate} from '@/src/goldline-supply';
import {GoldlineRestockInputs} from '@/components/analyst/goldline-restock-inputs';
import {GoldlineRestockRun} from '@/components/analyst/goldline-restock-run';
import {cn} from '@/lib/utils';

export const dynamic = 'force-dynamic';

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

// Goldline Restock (P3). Two tabs: Run (F11), the half month's saved recommendations with
// the owner's decisions; and Inputs (F10), which of last year's months the run reads, which
// lines are ready, and which wait and why. ?store= picks a store (company and store scope
// fenced in the loaders); ?asOf=YYYY-MM-DD previews a run on another date; ?tab=inputs.
export default async function Page(props: {searchParams: Promise<{store?: string; asOf?: string; tab?: string}>}) {
  const ctx = await getDataContext();
  if (!ctx || !ctx.companyId) {
    return (
      <div className="mx-auto flex min-h-[50vh] max-w-md flex-col items-center justify-center gap-2 text-center">
        <h1 className="font-heading text-lg font-semibold">No company in view</h1>
        <p className="text-sm text-muted-foreground">Pick a company you belong to to see its restock.</p>
      </div>
    );
  }
  const {store, asOf, tab} = await props.searchParams;
  const today = manilaDate();
  const runDate = asOf && ISO_DAY.test(asOf) && !Number.isNaN(Date.parse(asOf)) ? asOf : today;
  const scope = ctx.storeScope ?? null;
  const inputs = tab === 'inputs';
  // Window, safety and the run itself are company-wide: only roles without a store scope change them.
  const companyWide = canEditData(ctx.role) && !scope;
  const nav = <RestockTabs inputs={inputs} store={store ?? null} asOf={runDate !== today ? runDate : null} />;

  if (inputs) {
    const data = await getForecastData(ctx.companyId, runDate, store ?? null, scope);
    return <GoldlineRestockInputs data={{...data, company: ctx.companyId, today, preview: runDate !== today, canEditSettings: companyWide, nav}} />;
  }
  const data = await getRestockRun(ctx.companyId, runDate, store ?? null, scope);
  return (
    <GoldlineRestockRun
      data={{...data, company: ctx.companyId, runDate, today, preview: runDate !== today, canDecide: canEditData(ctx.role), canMakeRun: companyWide, nav}}
    />
  );
}

function RestockTabs({inputs, store, asOf}: {inputs: boolean; store: string | null; asOf: string | null}) {
  const href = (tab: 'run' | 'inputs') => {
    const q = new URLSearchParams();
    if (tab === 'inputs') q.set('tab', 'inputs');
    if (store) q.set('store', store);
    if (asOf) q.set('asOf', asOf);
    return q.size ? `/stock/restock?${q}` : '/stock/restock';
  };
  const item = (active: boolean) =>
    cn('border-b-2 px-1 pb-1 text-sm font-medium transition-colors', active ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground');
  return (
    <nav aria-label="Restock" className="flex gap-4">
      <Link href={href('run')} aria-current={!inputs ? 'page' : undefined} className={item(!inputs)}>
        Run
      </Link>
      <Link href={href('inputs')} aria-current={inputs ? 'page' : undefined} className={item(inputs)}>
        Inputs
      </Link>
    </nav>
  );
}
