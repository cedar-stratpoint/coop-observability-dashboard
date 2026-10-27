// product_channel_alias review loop, command line (terminal first, no UI). Plan: knowledge/tasks/2026-10-22-cross-channel-sku-and-calculation-build-plan.md.
//
//   npm run sku:aliases -- propose [--website-json <file>] [--out <file.csv>]   writes the review CSV (exact SKU matches = auto, the rest = proposals)
//   npm run sku:aliases -- apply <file.csv> [--confirm-host <host>]             writes auto rows and rows marked confirmed = yes; skips and says why for the rest
//   npm run sku:aliases -- coverage [--website-json <file>]                     how many seen identifiers per channel have an alias
//
// --website-json is a saved response of the CRM's GET /api/products/sales (curl it yourself with the read token; this script never calls the CRM).
// Needs SUPABASE_URL_ARCHIVE and SUPABASE_SERVICE_ROLE_KEY_ARCHIVE in the environment. apply against a database that is not on this machine needs
// --confirm-host <that host>. See scripts/sku-aliases.example.csv for the CSV shape (synthetic).
import {readFileSync, writeFileSync} from 'node:fs';
import {createClient} from '@supabase/supabase-js';
import {fetchAllRows} from '../src/pos-fetch-paginate';
import {aliasRowsFromDb} from '../src/sku-compare-readers';
import {coverage, parseCsv, proposeAliases, rowsToApply, toCsv, type Observed, type PosProduct} from '../src/sku-alias-csv';

const argv = process.argv.slice(2);
const cmd = argv[0];
const opt = (name: string): string | null => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
};

async function main(): Promise<void> {
  const url = process.env.SUPABASE_URL_ARCHIVE;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY_ARCHIVE;
  if (!url || !key) throw new Error('Set SUPABASE_URL_ARCHIVE and SUPABASE_SERVICE_ROLE_KEY_ARCHIVE (this command does not read .env files).');
  const host = new URL(url).hostname;
  const sb = createClient(url, key, {auth: {persistSession: false}});

  const products = async (): Promise<PosProduct[]> => {
    const data = await fetchAllRows('pos_products', (a, b) => sb.from('pos_products').select('product_id,name').order('product_id').range(a, b));
    return data.map((r) => ({product_id: String(r.product_id), name: String(r.name)}));
  };
  const observed = async (): Promise<Observed[]> => {
    const out: Observed[] = [];
    const data = await fetchAllRows('marketplace_sku_weekly', (a, b) => sb.from('marketplace_sku_weekly').select('item_id,product,variation_id,sku').order('period_from').order('seq').range(a, b));
    for (const r of data) {
      if (r.sku) out.push({channel: 'shopee', alias_type: 'sku', alias_value: String(r.sku), label: String(r.product)});
      else if (r.variation_id === null) out.push({channel: 'shopee', alias_type: 'title', alias_value: String(r.product), label: String(r.product)});
    }
    const file = opt('website-json');
    if (file) {
      const body = JSON.parse(readFileSync(file, 'utf8')) as {products?: Record<string, unknown>[]};
      for (const p of body.products ?? []) {
        const label = String(p.title ?? '');
        if (p.sku) out.push({channel: 'website', alias_type: 'sku', alias_value: String(p.sku), label});
        else if (p.variant_id) out.push({channel: 'website', alias_type: 'variant_id', alias_value: String(p.variant_id), label});
        else if (label) out.push({channel: 'website', alias_type: 'title', alias_value: label, label});
      }
    }
    return out;
  };

  if (cmd === 'propose') {
    const rows = proposeAliases(await observed(), await products());
    const out = opt('out') ?? 'sku-alias-review.csv';
    writeFileSync(out, toCsv(rows));
    const auto = rows.filter((r) => r.source === 'auto').length;
    console.log(`${rows.length} identifiers: ${auto} exact matches (auto), ${rows.length - auto} to review. Edit product_id and set confirmed to yes, then apply. Wrote ${out} (it holds shop data: do not commit it).`);
  } else if (cmd === 'apply') {
    const file = argv[1];
    if (!file || file.startsWith('--')) throw new Error('apply needs the CSV path');
    const local = ['localhost', '127.0.0.1', '::1'].includes(host);
    if (!local && opt('confirm-host') !== host) throw new Error(`This is ${host}, not this machine. Re-run with --confirm-host ${host} to write there.`);
    const {apply, skipped} = rowsToApply(parseCsv(readFileSync(file, 'utf8')), await products(), new Date().toISOString());
    const have = await fetchAllRows('product_channel_alias', (a, b) => sb.from('product_channel_alias').select('channel,alias_type,alias_value,product_id,valid_from').order('id').range(a, b));
    const seen = new Set(have.map((r) => [r.channel, r.alias_type, String(r.alias_value).toLowerCase(), r.product_id, r.valid_from ?? ''].join('|')));
    const fresh = apply.filter((r) => !seen.has([r.channel, r.alias_type, r.alias_value.toLowerCase(), r.product_id, r.valid_from ?? ''].join('|')));
    if (fresh.length) {
      const {error: e} = await sb.from('product_channel_alias').insert(fresh.map(({label: _l, ...row}) => row));
      if (e) throw new Error(`insert: ${e.message}`);
    }
    console.log(`Wrote ${fresh.length} new aliases (${apply.length - fresh.length} already there). Skipped ${skipped.length}.`);
    for (const s of skipped) console.log(`  row ${s.row}: ${s.reason}`);
  } else if (cmd === 'coverage') {
    const data = await fetchAllRows('product_channel_alias', (a, b) => sb.from('product_channel_alias').select('channel,alias_type,alias_value').order('id').range(a, b));
    const cov = coverage(await observed(), aliasRowsFromDb(data));
    for (const [ch, c] of Object.entries(cov)) console.log(`${ch}: ${c.mapped} of ${c.observed} identifiers mapped`);
  } else {
    throw new Error('Usage: sku-aliases.ts propose | apply <file.csv> | coverage');
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
