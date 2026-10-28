import {getDataContext} from '@/src/active-context';
import {canEditData} from '@/src/company';
import {getForecastData} from '@/src/goldline-forecast-data';
import {manilaDate} from '@/src/goldline-supply';
import {GoldlineRestockInputs} from '@/components/analyst/goldline-restock-inputs';

export const dynamic = 'force-dynamic';

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

// Goldline Restock (P3). Today it shows the forecast inputs (F10): which of last year's
// months the next run reads, which lines are ready, and which wait and why. F11 adds the
// recommended quantities and approvals here. ?store= picks a store (company and store
// scope fenced in the loader); ?asOf=YYYY-MM-DD previews a run on another date.
export default async function Page(props: {searchParams: Promise<{store?: string; asOf?: string}>}) {
  const ctx = await getDataContext();
  if (!ctx || !ctx.companyId) {
    return (
      <div className="mx-auto flex min-h-[50vh] max-w-md flex-col items-center justify-center gap-2 text-center">
        <h1 className="font-heading text-lg font-semibold">No company in view</h1>
        <p className="text-sm text-muted-foreground">Pick a company you belong to to see its restock.</p>
      </div>
    );
  }
  const {store, asOf} = await props.searchParams;
  const today = manilaDate();
  const runDate = asOf && ISO_DAY.test(asOf) && !Number.isNaN(Date.parse(asOf)) ? asOf : today;
  const scope = ctx.storeScope ?? null;
  const data = await getForecastData(ctx.companyId, runDate, store ?? null, scope);

  return (
    <GoldlineRestockInputs
      data={{
        ...data,
        company: ctx.companyId,
        today,
        preview: runDate !== today,
        // Window and safety are company-wide: only roles without a store scope edit them.
        canEditSettings: canEditData(ctx.role) && !scope,
      }}
    />
  );
}
