import {getClosedTargets, getGmvActualsSynced, getMonthCloses, getPlan, getPlanVersions, getTypedLines} from '@/src/plan-data';
import {planEditor} from '@/src/plan-auth';
import {currentMonthKey, overlayClosedTargets} from '@/src/plan-compute';
import {phDay} from '@/src/custom-range';
import {HealthReportView} from '@/components/analyst/health-report-view';

export const dynamic = 'force-dynamic';
export const metadata = {title: 'Business Health Report · Coop'};

export default async function HealthReportPage() {
  const livePlan = await getPlan();
  const nowKey = currentMonthKey(new Date());
  // Today's Manila month picks the cards and the mobile window. GMV actuals are computed per request from Coop's readers (BHR-02); a source that
  // fails or has no data for a month leaves that cell empty ("waiting"). Cost lines, stock bought, funding and one-time payments are the workbook's input rows, typed by admins (BHR-03) and read here fresh; cash, margins, coverage, customers and CAC are derived from them.
  const [{gmv, webSyncedAt}, typed, closes, editor, versions] = await Promise.all([getGmvActualsSynced(livePlan.months, nowKey), getTypedLines(livePlan.months), getMonthCloses(), planEditor(), getPlanVersions()]);
  // Website orders are cached until an admin presses Refresh (BHR-09); webSyncedAt is when the CRM Worker was read, null when it failed.
  // A closed month is judged against the plan version it closed under (BHR-05), not the newest one.
  const plan = closes ? overlayClosedTargets(livePlan, closes, await getClosedTargets(closes)) : livePlan;
  // No inputs unless the saved lines could be read: nobody types blind over numbers the page failed to load.
  return <HealthReportView plan={plan} nowKey={nowKey} gmv={gmv} closes={closes ?? {}} today={phDay(Date.now())}
    lines={typed?.lines ?? {}}
    canEdit={editor !== null && typed !== null && closes !== null}
    versions={versions}
    syncedAt={webSyncedAt} canSync={editor !== null}
    linesNotice={typed === null || closes === null ? 'The typed cost lines or the closed months could not be read, so they are hidden and cannot be edited right now.' : null} />;
}
