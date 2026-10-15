// DEV-ONLY: times the Goldline page loaders, one run per request (reload to sample).
// Shows timings only, never data. 404 in production.
import {notFound} from 'next/navigation';
import {getBoardData} from '@/src/goldline-board-data';
import {getCountSources} from '@/src/goldline-inventory-data';
import {getOpsData} from '@/src/goldline-ops-data';
import {getProductData} from '@/src/goldline-product-data';
import {getGoldlineAnalytics, getGoldlineOverviewData} from '@/src/goldline-analytics';

export const dynamic = 'force-dynamic';

async function time(fn: () => Promise<unknown>) {
  const runs: number[] = [];
  for (let i = 0; i < 1; i++) {
    const s = performance.now();
    await fn();
    runs.push(Math.round(performance.now() - s));
  }
  return runs;
}

export default async function Page() {
  if (process.env.NODE_ENV !== 'development') notFound();
  const C = 'goldline';
  const rows: Array<[string, number[]]> = [
    ['Inventory board (board + count sources, parallel)', await time(() => Promise.all([getBoardData(C, null), getCountSources(C, '1', null)]))],
    ['Action feed / health (getOpsData)', await time(() => getOpsData(C, null))],
    ['Product page (getProductData)', await time(() => getProductData(C, 'TWC01152', null))],
    ['Overview (getGoldlineOverviewData)', await time(() => getGoldlineOverviewData(C))],
    ['Stores (getGoldlineAnalytics)', await time(() => getGoldlineAnalytics(C))],
  ];
  return (
    <pre className="p-6 font-mono text-sm">
      {rows.map(([n, r]) => `${n.padEnd(52)} ${r.join(' / ')} ms`).join('\n')}
    </pre>
  );
}
