// Watsons SKU links found in the September 2026 inventory form scan (Scan2026-10-30_171554,
// 98 pages, Nov 10 2026). The legacy form still prints items that aren't in our catalog
// (mostly marked O/S or crossed out), and Watsons sold most of them all year. This adds
// those items to the catalog and links each to its Watsons SKU, then applies two
// decisions the scan settles by elimination:
//   - 38006188 "EYELASH DEFINING MASCA" is Brown (ELDF03): Black is linked, Blue is ELDF02.
//   - 38006001 "ELISE DIVA LASHES NATURAL HAIR X": Coop's EDNH4312 prints as "N4312",
//     only X4289 and XL5127 start with X, so the suggestion is turned down.
// Uses the same functions as the SKU linking page (linkSku, saveReview, recordDecision),
// so every change shows in the page's activity with Undo, and the checks re-run after.
//
//   npx tsx --conditions=react-server --env-file=.env --env-file=.env.local \
//     scripts/nichido/apply-scan-sku-links.ts                 # plan only (default)
//   ... same ... --apply                                      # make the changes
//
// Note (Nov 10): goldline-ref-data now imports React's `cache`, which the react-server
// condition rejects outside Next. Ran instead with a --require shim that maps
// 'server-only' to an empty module, next/cache to pass-throughs and react.cache to identity.
//
// Idempotent: items already in the catalog are kept, SKUs already linked are skipped.
// Applied on Nichido Staging Nov 10 2026 (25 of 25).
// Targets the Nichido project in NICHIDO_URL; production also needs --prod.

import {dbRefOf, COOP_ENVS} from '../../src/coop-env';
import {nichidoDb} from '../../src/nichido-client';
import {fetchAllRows} from '../../src/pos-fetch-paginate';
import {dismissSuggestion, linkSku, saveReview} from '../../src/goldline-sku-links-data';
import {recordDecision} from '../../src/goldline-sku-undo';
import {runChecks} from '../../src/goldline-checks-data';

const COMPANY = 'goldline';
const CHAIN = 'watsons';
const BY = 'Sept 2026 form scan';
const args = process.argv.slice(2);
const flag = (f: string) => args.includes(f);

// Printed on the legacy form (line, name and price as printed), scan page in brackets.
type NewItem = {item: string; line: string; variant: string; price: number; sku: string; page: number};
const NEW_ITEMS: NewItem[] = [
  {item: '24HRTEEP', line: '24 Hr Tattoo Effect Eyeliner Pen', variant: 'Tattoo Effect Eyeliner Pen TO1 Black', price: 238, sku: '39003347', page: 7},
  {item: 'ELDF02', line: 'Eyelash Defining Mascara', variant: 'Eyelash Defining Mascara Blue', price: 130, sku: '38006187', page: 8},
  {item: 'NGFEP', line: 'Make-Up Collection', variant: 'Glam Face & Eye Palette 317-A', price: 140, sku: '38006221', page: 1},
  {item: 'LEL091', line: 'Liquid Eyeliner Small', variant: 'Liquid Eyeliner Small Black', price: 88, sku: '38006197', page: 7},
  {item: 'HFMBLS', line: 'Hydration Facial Mist', variant: 'Hydration Facial Mist + Blue Light Shield', price: 299, sku: '70059294', page: 8},
  {item: 'FP01201', line: 'Final Powder', variant: 'So Natural', price: 200, sku: '38006075', page: 2},
  {item: 'MPMLSCB06', line: 'Mineral Powder Matte Lipstick with Collagen Booster', variant: 'Matte Lipstick Sugar Rush', price: 250, sku: '70061440', page: 1},
  {item: 'JLLS05', line: 'Juicy Lips Lipstick', variant: 'Juicy Lips Lipstick Rasp Berry Float', price: 88, sku: '38006123', page: 4},
  {item: 'MPMLSCB07', line: 'Mineral Powder Matte Lipstick with Collagen Booster', variant: 'Matte Lipstick Georgia', price: 250, sku: '70061444', page: 1},
  {item: 'PP01115', line: 'Pressed Powder', variant: 'Natural', price: 125, sku: '38006097', page: 2},
  {item: 'BC01191', line: 'Beauty Cake', variant: 'Rose Beige', price: 80, sku: '38006060', page: 2},
  {item: 'MUSE', line: 'Make-Up Collection', variant: 'Sweet Escape Eyeshadow Palette', price: 388, sku: '70044210', page: 1},
  {item: 'JLLS06', line: 'Juicy Lips Lipstick', variant: 'Juicy Lips Lipstick Tangerine Pop', price: 88, sku: '38006124', page: 4},
  {item: 'BGSL02', line: 'Body Glimmer Powder', variant: 'Sun Lite', price: 120, sku: '38006063', page: 2},
  {item: 'BGPL01', line: 'Body Glimmer Powder', variant: 'Pink Lite', price: 120, sku: '38006062', page: 2},
  {item: 'FLBES', line: 'Full Lash and Brow Enhancer Serum', variant: 'Full Lash and Brow Enhancer Serum', price: 339, sku: '70059295', page: 8},
  {item: 'EFTT1112', line: 'Elise Futuristic Lashes', variant: 'Elise Futuristic Lashes W1112', price: 238, sku: '38006008', page: 4},
  {item: '24HRMESGDE', line: '24HR Mineralized Eyebrow Sculpting Gel', variant: 'Eyebrow Sculpting Gel Double Espresso', price: 288, sku: '70060637', page: 7},
  {item: '24HRMESGM', line: '24HR Mineralized Eyebrow Sculpting Gel', variant: 'Eyebrow Sculpting Gel Macchiato', price: 288, sku: '70060638', page: 7},
  {item: 'JLLS02', line: 'Juicy Lips Lipstick', variant: 'Juicy Lips Lipstick Berry Freeze', price: 88, sku: '38006120', page: 4},
  {item: 'MUR', line: 'Make-Up Remover', variant: 'Make-Up Remover', price: 198, sku: '39001507', page: 8},
  {item: 'EFTT1064', line: 'Elise Futuristic Lashes', variant: 'Elise Futuristic Lashes B1064', price: 238, sku: '38006003', page: 4},
  {item: 'EFTT1676', line: 'Elise Futuristic Lashes', variant: 'Elise Futuristic Lashes G1676', price: 238, sku: '38006004', page: 4},
];

const remarkFor = (n: NewItem) => `Printed on the legacy inventory form (Sept 2026 scan, page ${n.page}) as ${n.item}, ${n.variant}, P${n.price}. Added to the catalog and linked from the scan.`;
const ELDF03 = {sku: '38006188', item: 'ELDF03', remark: 'Watsons name is cut off. Black (ELDF01) is linked to 38006186 and the Sept 2026 scan (page 8) confirms Blue is ELDF02 (38006187), so this is Brown.'};
const DIVA_X = {
  sku: '38006001',
  expect: 'EDNH4312',
  remark: 'Turned down from the Sept 2026 scan: EDNH4312 prints as "N4312". Only X4289 (EDNH4289) and XL5127 (EDNH5127) start with X, so this SKU is one of those two. Ask Justin which.',
};

async function main() {
  const ref = dbRefOf(process.env.NICHIDO_URL);
  const env = COOP_ENVS.find((e) => e.nichidoRef === ref);
  if (!ref) throw new Error('NICHIDO_URL is not set.');
  if (env?.key === 'production' && !flag('--prod')) throw new Error('NICHIDO_URL is the PRODUCTION Nichido project; pass --prod to confirm.');
  console.log(`Nichido project: ${env?.label ?? 'unknown'} (${ref})\n`);

  const db = nichidoDb();
  const [products, chain] = await Promise.all([
    fetchAllRows('products', (from, to) => db.from('products').select('item_code,sku_code').eq('company_id', COMPANY).order('item_code').range(from, to)) as unknown as Promise<
      Array<{item_code: string; sku_code: string | null}>
    >,
    fetchAllRows('chain_skus', (from, to) =>
      db.from('chain_skus').select('sku_code,suggested_item_code').eq('company_id', COMPANY).eq('chain', CHAIN).order('sku_code').range(from, to),
    ) as unknown as Promise<Array<{sku_code: string; suggested_item_code: string | null}>>,
  ]);
  const itemSku = new Map(products.map((p) => [p.item_code, p.sku_code?.trim() || null]));
  const skuHolder = new Map(products.filter((p) => p.sku_code?.trim()).map((p) => [p.sku_code!.trim(), p.item_code]));
  const suggestion = new Map(chain.map((c) => [c.sku_code, c.suggested_item_code]));

  type Step = {kind: 'add' | 'link' | 'reject'; sku: string; item: string; remark: string};
  const steps: Step[] = [];
  const skipped: string[] = [];
  for (const n of NEW_ITEMS) {
    if (!suggestion.has(n.sku)) skipped.push(`${n.sku}: not in the Watsons list`);
    else if (skuHolder.get(n.sku) === n.item) skipped.push(`${n.sku}: already linked to ${n.item}`);
    else if (skuHolder.has(n.sku)) skipped.push(`${n.sku}: linked to ${skuHolder.get(n.sku)}, not ${n.item}. Left for a person`);
    else if (itemSku.get(n.item)) skipped.push(`${n.item}: already linked to ${itemSku.get(n.item)}. Left for a person`);
    else steps.push({kind: itemSku.has(n.item) ? 'link' : 'add', sku: n.sku, item: n.item, remark: remarkFor(n)});
  }
  if (skuHolder.has(ELDF03.sku) || itemSku.get(ELDF03.item)) skipped.push(`${ELDF03.sku}: ${ELDF03.item} or the SKU is already linked`);
  else steps.push({kind: 'link', sku: ELDF03.sku, item: ELDF03.item, remark: ELDF03.remark});
  if (suggestion.get(DIVA_X.sku) === DIVA_X.expect) steps.push({kind: 'reject', sku: DIVA_X.sku, item: DIVA_X.expect, remark: DIVA_X.remark});
  else skipped.push(`${DIVA_X.sku}: suggestion is ${suggestion.get(DIVA_X.sku) ?? 'none'}, not ${DIVA_X.expect}`);

  const label = {add: 'Add + link', link: 'Link      ', reject: 'Reject    '} as const;
  console.log(`Will do (${steps.length}):`);
  for (const s of steps) console.log(`  ${label[s.kind]}  ${s.sku} → ${s.item}`);
  if (skipped.length) console.log(`\nSkipped (${skipped.length}):\n${skipped.map((s) => `  ${s}`).join('\n')}`);
  if (!flag('--apply')) {
    console.log('\nPlan only. Re-run with --apply to make these changes.');
    return;
  }

  // New catalog items first, outside the logged decisions: Undo on a link then only unlinks.
  const toAdd = NEW_ITEMS.filter((n) => steps.some((s) => s.kind === 'add' && s.item === n.item));
  if (toAdd.length) {
    const ins = await db
      .from('products')
      .upsert(
        toAdd.map((n) => ({company_id: COMPANY, item_code: n.item, product_line: n.line, variant: n.variant, unit_price: n.price, is_bestseller: false, hidden: false})),
        {onConflict: 'company_id,item_code', ignoreDuplicates: true},
      );
    if (ins.error) throw new Error(`catalog insert failed: ${ins.error.message}`);
    console.log(`\nAdded ${toAdd.length} items to the catalog.`);
  }

  let done = 0;
  for (const s of steps) {
    try {
      if (s.kind === 'reject') {
        await recordDecision(COMPANY, {target: 'sku', key: s.sku, action: 'rejected', summary: s.item, by: BY}, async () => {
          const rejected = await dismissSuggestion(COMPANY, s.sku, s.item);
          await saveReview(COMPANY, s.sku, {action: 'rejected', itemCode: rejected, remark: s.remark, by: BY});
        });
      } else {
        await recordDecision(COMPANY, {target: 'sku', key: s.sku, action: 'linked', summary: s.item, by: BY}, async () => {
          await linkSku(COMPANY, s.sku, s.item);
          await saveReview(COMPANY, s.sku, {action: 'linked', itemCode: s.item, remark: s.remark, by: BY});
        });
      }
      done++;
    } catch (e) {
      console.error(`  Failed: ${s.kind} ${s.sku} → ${s.item}: ${e instanceof Error ? e.message : e}`);
    }
  }
  console.log(`Applied ${done} of ${steps.length}.`);
  // A link decides which sales count for an item, so the form vs. sales checks follow it.
  await runChecks(COMPANY);
  console.log('Checks re-run.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
