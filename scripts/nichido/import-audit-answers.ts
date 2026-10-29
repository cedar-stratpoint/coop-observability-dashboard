// Read a filled Nichido Data Audit PDF (the SKU linking worksheet sent to Justin) and
// turn its answers into Coop decisions: approve or reject Coop's suggested matches, link
// the items written in by hand, and keep the notes as remarks. Uses the same functions
// as the SKU linking page, so every decision lands in sku_link_reviews with who made it.
//
//   npx tsx --conditions=react-server --env-file=.env --env-file=.env.local \
//     scripts/nichido/import-audit-answers.ts <filled.pdf> --by "Justin"            # plan only (default)
//   ... same ... --apply                                                             # make the changes
//
// Plan only by default. Links marked "Looks wrong" and items marked "Not sold at
// Watsons" are listed for a person; nothing is unlinked automatically. Answers whose
// suggestion changed since the report was printed are skipped, never guessed.
// Targets the Nichido project in NICHIDO_URL; production also needs --prod.
// (--conditions=react-server lets the server-only data modules load outside Next.)

import fs from 'node:fs';
import {PDFCheckBox, PDFDocument, PDFRadioGroup, PDFTextField} from 'pdf-lib';
import {dbRefOf, COOP_ENVS} from '../../src/coop-env';
import {nichidoDb} from '../../src/nichido-client';
import {fetchAllRows} from '../../src/pos-fetch-paginate';
import {dismissSuggestion, linkSku, saveReview} from '../../src/goldline-sku-links-data';
import {runChecks} from '../../src/goldline-checks-data';
import {parseAuditFields, planAudit, type FieldValue, type LinkState} from '../../src/goldline-audit-answers';

const COMPANY = 'goldline';
const CHAIN = 'watsons';
const args = process.argv.slice(2);
const flag = (f: string) => args.includes(f);
const opt = (f: string) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : undefined;
};

async function readFields(path: string): Promise<Record<string, FieldValue>> {
  const doc = await PDFDocument.load(fs.readFileSync(path));
  const out: Record<string, FieldValue> = {};
  for (const f of doc.getForm().getFields()) {
    if (f instanceof PDFRadioGroup) out[f.getName()] = f.getSelected() ?? null;
    else if (f instanceof PDFCheckBox) out[f.getName()] = f.isChecked();
    else if (f instanceof PDFTextField) out[f.getName()] = f.getText() ?? '';
  }
  return out;
}

async function linkState(): Promise<LinkState> {
  const db = nichidoDb();
  const [products, chain] = await Promise.all([
    fetchAllRows('products', (from, to) => db.from('products').select('item_code,sku_code').eq('company_id', COMPANY).order('item_code').range(from, to)) as unknown as Promise<
      Array<{item_code: string; sku_code: string | null}>
    >,
    fetchAllRows('chain_skus', (from, to) =>
      db.from('chain_skus').select('sku_code,suggested_item_code').eq('company_id', COMPANY).eq('chain', CHAIN).order('sku_code').range(from, to),
    ) as unknown as Promise<Array<{sku_code: string; suggested_item_code: string | null}>>,
  ]);
  const linked = products.filter((p) => p.sku_code?.trim());
  return {
    linkedItemBySku: new Map(linked.map((p) => [p.sku_code!.trim(), p.item_code])),
    skuByItem: new Map(linked.map((p) => [p.item_code, p.sku_code!.trim()])),
    suggestionBySku: new Map(chain.filter((c) => c.suggested_item_code).map((c) => [c.sku_code, c.suggested_item_code!])),
    knownSkus: new Set(chain.map((c) => c.sku_code)),
    knownItems: new Set(products.map((p) => p.item_code.toUpperCase())),
  };
}

async function main() {
  const file = args.find((a) => a.toLowerCase().endsWith('.pdf'));
  const by = opt('--by');
  if (!file || !by) throw new Error('Usage: import-audit-answers.ts <filled.pdf> --by "<who filled it in>" [--apply] [--prod]');
  const ref = dbRefOf(process.env.NICHIDO_URL);
  const env = COOP_ENVS.find((e) => e.nichidoRef === ref);
  if (!ref) throw new Error('NICHIDO_URL is not set.');
  if (env?.key === 'production' && !flag('--prod')) throw new Error('NICHIDO_URL is the PRODUCTION Nichido project; pass --prod to confirm.');
  console.log(`Nichido project: ${env?.label ?? 'unknown'} (${ref})`);

  const answers = parseAuditFields(await readFields(file));
  const plan = planAudit(answers, await linkState());
  const answered = answers.matches.filter((m) => m.answer).length + answers.picks.filter((p) => p.itemCode).length + answers.formItems.filter((c) => c.atWatsons || c.watsonsCode).length;
  console.log(`\nAnswered: ${answered} rows · flagged links: ${answers.flagged.length}\n`);

  const label = {approve: 'Approve', reject: 'Reject ', link: 'Link   ', remark: 'Remark '} as const;
  console.log(`Will do (${plan.actions.length}):`);
  for (const a of plan.actions) {
    const what = a.kind === 'remark' ? a.sku : `${a.sku} → ${a.item}`;
    console.log(`  ${label[a.kind]}  ${what}${a.remark ? `   "${a.remark}"` : ''}`);
  }
  if (plan.skipped.length) {
    console.log(`\nSkipped (${plan.skipped.length}):`);
    for (const s of plan.skipped) console.log(`  ${s.where}: ${s.why}`);
  }
  if (plan.forUs.length) {
    console.log(`\nFor a person (${plan.forUs.length}):`);
    for (const f of plan.forUs) console.log(`  ${f.where}: ${f.what}`);
  }

  if (!flag('--apply')) {
    console.log('\nPlan only. Re-run with --apply to make these changes.');
    return;
  }
  const who = `${by} (audit PDF)`;
  let done = 0;
  for (const a of plan.actions) {
    try {
      if (a.kind === 'approve') {
        await linkSku(COMPANY, a.sku, a.item);
        await saveReview(COMPANY, a.sku, {action: 'approved', itemCode: a.item, remark: a.remark, by: who});
      } else if (a.kind === 'reject') {
        const rejected = await dismissSuggestion(COMPANY, a.sku, a.item);
        await saveReview(COMPANY, a.sku, {action: 'rejected', itemCode: rejected, remark: a.remark, by: who});
      } else if (a.kind === 'link') {
        await linkSku(COMPANY, a.sku, a.item);
        await saveReview(COMPANY, a.sku, {action: 'linked', itemCode: a.item, remark: a.remark, by: who});
      } else {
        await saveReview(COMPANY, a.sku, {action: null, remark: a.remark, by: who});
      }
      done++;
    } catch (e) {
      console.error(`  Failed: ${a.kind} ${a.sku}: ${e instanceof Error ? e.message : e}`);
    }
  }
  console.log(`\nApplied ${done} of ${plan.actions.length}.`);
  if (plan.actions.some((a) => a.kind !== 'remark')) {
    await runChecks(COMPANY);
    console.log('Form vs. sales checks re-run.');
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
