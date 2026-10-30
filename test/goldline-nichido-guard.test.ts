import {readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';

// Goldline's tables and goldline-uploads bucket live in the Nichido project (named
// without the archive's gl_ prefix; supabase/nichido/goldline_schema.sql). Any module
// that touches them must go through src/nichido-client.ts; one that built its own
// client from the archive env would read and write the archive's old gl_* copy, or a
// same-named table that is not Goldline's.

const ROOT = join(__dirname, '..');
const SCAN = ['src', 'app', 'components'];
const NICHIDO_TABLES = ['stores', 'products', 'sales', 'inventory', 'inventory_snapshots', 'uploads', 'extractions', 'upload_batches',
  'supply_settings', 'line_lead_times', 'store_transit', 'warehouse_stock', 'shipments', 'price_changes', 'chain_skus', 'forecast_settings', 'restock_runs', 'recommendations'];
const NICHIDO_FUNCTIONS = ['commit_batch', 'sales_rollup', 'sales_by_sku', 'count_sources', 'record_shipment', 'cancel_shipment', 'set_price', 'forecast_months', 'forecast_history', 'forecast_item_history', 'store_scope', 'sales_units', 'upsert_sales', 'sku_months', 'save_restock_run', 'decide_recommendations'];
const q = (call: string, names: string[]) => `\\.${call}\\(\\s*['"\`](?:${names.join('|')})['"\`]`;
// Storage is Goldline's only when it names the goldline-uploads bucket (other features,
// e.g. the Shopee importer, keep their own buckets in the archive).
const NICHIDO_QUERY = new RegExp(`${q('from', NICHIDO_TABLES)}|${q('rpc', NICHIDO_FUNCTIONS)}|\\.storage\\.from\\(\\s*GOLDLINE_BUCKET`);
const GL_ACCESS = new RegExp(`${NICHIDO_QUERY.source}|GOLDLINE_BUCKET|goldline-uploads`);

function files(dir: string): string[] {
  return readdirSync(join(ROOT, dir), {withFileTypes: true}).flatMap((e) => {
    const rel = join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : files(rel);
    return /\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [rel] : [];
  });
}

describe('Goldline data goes through the Nichido client', () => {
  const all = SCAN.flatMap(files).map((f) => ({f, src: readFileSync(join(ROOT, f), 'utf8')}));
  const goldline = all.filter(({f, src}) => f !== join('src', 'nichido-client.ts') && GL_ACCESS.test(src));

  it('finds the Goldline data modules', () => {
    expect(goldline.length).toBeGreaterThanOrEqual(5);
  });

  it('no Goldline module reads the archive env or builds its own client', () => {
    const bad = goldline.filter(({src}) => /SUPABASE_(URL|SERVICE_ROLE_KEY)_ARCHIVE|createClient\(/.test(src)).map(({f}) => f);
    expect(bad).toEqual([]);
  });

  it('every module that queries a Nichido table or function imports the Nichido client', () => {
    const queries = goldline.filter(({src}) => NICHIDO_QUERY.test(src));
    const missing = queries.filter(({src}) => !src.includes("from './nichido-client'")).map(({f}) => f);
    expect(missing).toEqual([]);
  });

  it('nothing still queries the old gl_ names (those are the archive copy)', () => {
    const old = all.filter(({src}) => /\.(from|rpc)\(\s*['"`]gl_/.test(src)).map(({f}) => f);
    expect(old).toEqual([]);
  });
});
