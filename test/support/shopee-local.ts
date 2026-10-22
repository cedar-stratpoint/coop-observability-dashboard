// Local-stack helper: loads a fictional Sales Overview span through the REAL pipeline (plan, then apply) into the local database, and removes
// it afterwards. Uses far-past 2025 dates so it never touches the days a real backfill may have loaded locally.
import type {SupabaseClient} from '@supabase/supabase-js';
import {applyRun, planFile} from '../../src/shopee-import/pipeline';
import {supabaseImportStore} from '../../src/shopee-import/store-supabase';
import {salesOverviewFile, week} from './shopee-fixture';

export async function loadFictionalSpan(sb: SupabaseClient, from: string, salesConfirmed: number[]): Promise<{importId: string; cleanup: () => Promise<void>}> {
  const store = supabaseImportStore(sb);
  const last = week(from, salesConfirmed).slice(-1)[0].day;
  const name = `sales_overview_${from.replaceAll('-', '')}-${last.replaceAll('-', '')}.xlsx`;
  const bytes = await salesOverviewFile(week(from, salesConfirmed));
  const o = await planFile({store, bytes, filename: name, today: '2026-10-22', importedBy: 'local-test'});
  if (o.status !== 'staged') throw new Error(`expected a staged import, got ${o.status}`);
  const done = await applyRun(store, o.importId);
  if (!done.ok) throw new Error(done.message);
  return {
    importId: o.importId,
    cleanup: async () => {
      await sb.from('marketplace_daily_observations').delete().eq('import_id', o.importId);
      await sb.from('import_runs').delete().eq('import_id', o.importId);
    },
  };
}
