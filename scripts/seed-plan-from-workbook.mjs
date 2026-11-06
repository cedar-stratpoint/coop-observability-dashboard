#!/usr/bin/env node
// PRIVATE LOADER for the Business Health Report plan. The repo is public and holds NO plan figure: the numbers are read from the
// Cedar Tree business plan workbook (a local file the owner keeps) and written straight to the database through the service role.
//
//   node scripts/seed-plan-from-workbook.mjs "<path to workbook.xlsx>"            dry run (default): parse, print counts, change nothing
//   node scripts/seed-plan-from-workbook.mjs "<path to workbook.xlsx>" --apply    write
//   ... --allow-hosted-staging  AND  env PLAN_LOADER_ALLOW_HOSTED=staging          needed for any non-local URL (never PROD)
//
// Env: SUPABASE_URL_ARCHIVE and SUPABASE_SERVICE_ROLE_KEY_ARCHIVE (the local stack: `set -a; . scripts/local-supabase/.local-env; set +a`).
// What it loads, all idempotent (a re-run changes nothing, and never overwrites a value an admin edited):
//   plan_versions     one version `vSept26`
//   plan_targets      a target series for EVERY value row of the Business Plan sheet, rows 4 to 125 (src/plan-sheet.json); settings and market sizing repeat their one value every month
// It writes NO actual: every workbook value is a plan figure (BHR-06, knowledge/lessons/plan-workbook-is-targets-only.md). Actuals are typed by an admin or read from Coop's sources.
// It prints counts only, never a figure.
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createClient} from '@supabase/supabase-js';
import {isLocalSupabaseUrl} from './local-only.mjs';
import {readWorkbook} from './plan-workbook.mjs';

export const LABEL = 'vSept26';
const REASON = 'Cedar Tree Brands Business Plan, September 2026 workbook';
const COVERAGE_NOTE = 'one constant in the workbook (row 45), repeated for every month';
const BATCH = 500;

/** Pure. The parsed workbook -> the rows to insert. Nothing here knows a number. */
export function buildRows({months, targets, assumptions}) {
  const targetRows = [];
  for (const [metric, series] of Object.entries(targets)) series.forEach((value, i) => { if (value !== null) targetRows.push({month: months[i], metric, value, note: metric === 'coverage' ? COVERAGE_NOTE : null}); });
  for (const [metric, value] of Object.entries(assumptions)) if (!(metric in targets)) months.forEach((month) => targetRows.push({month, metric, value, note: 'scalar workbook input, repeated for every month'}));
  return {targetRows};
}

/** Pure. Why this URL may not be written to, or null when it may. A non-local project needs BOTH the flag and the env switch. Never echoes the URL. */
export function urlRefusal(url, {allowHostedFlag, env}) {
  if (typeof url !== 'string' || url.trim() === '') return 'SUPABASE_URL_ARCHIVE is not set';
  if (isLocalSupabaseUrl(url)) return null;
  if (allowHostedFlag && env.PLAN_LOADER_ALLOW_HOSTED === 'staging') return null;
  return 'the Supabase URL is not local: pass --allow-hosted-staging AND set PLAN_LOADER_ALLOW_HOSTED=staging, and only for the STAGING project (never PROD)';
}

const chunks = (a, n) => Array.from({length: Math.ceil(a.length / n)}, (_, i) => a.slice(i * n, (i + 1) * n));
const fail = (msg) => { console.error(`seed-plan-from-workbook: ${msg}`); process.exit(1); };

async function main(argv, env) {
  const file = argv.find((a) => !a.startsWith('--'));
  const apply = argv.includes('--apply');
  if (!file) fail('usage: node scripts/seed-plan-from-workbook.mjs "<workbook.xlsx>" [--apply] [--allow-hosted-staging]');
  const parsed = await readWorkbook(path.resolve(file));
  const rows = buildRows(parsed);
  console.log(`workbook ok: ${parsed.months.length} months, ${Object.keys(parsed.targets).length} target metrics, ${Object.keys(parsed.assumptions).length} scalar inputs, no actuals (the itemised rows' targets are sheet rows r33-r38, r52-r54, r69, r70)`);

  const url = env.SUPABASE_URL_ARCHIVE, key = env.SUPABASE_SERVICE_ROLE_KEY_ARCHIVE;
  const refusal = urlRefusal(url, {allowHostedFlag: argv.includes('--allow-hosted-staging'), env});
  if (refusal) { if (apply) fail(refusal); console.log(`dry run, no database check: ${refusal}`); return; }
  if (!key) { if (apply) fail('SUPABASE_SERVICE_ROLE_KEY_ARCHIVE is not set'); console.log('dry run, no database check: no service key'); return; }
  const sb = createClient(url, key, {auth: {persistSession: false}});

  const ver = await sb.from('plan_versions').select('id').eq('label', LABEL).limit(1);
  if (ver.error) fail(`cannot read plan_versions (is supabase/plan_report.sql applied?): ${ver.error.message}`);
  let versionId = ver.data?.[0]?.id ?? null;
  const have = versionId === null ? 0 : (await sb.from('plan_targets').select('metric', {count: 'exact', head: true}).eq('plan_version', versionId)).count ?? 0;
  console.log(`database: version ${LABEL} ${versionId === null ? 'is not there yet' : 'exists'}, ${have} of ${rows.targetRows.length} target rows present`);
  if (!apply) { console.log('dry run: nothing written. Add --apply to write.'); return; }

  if (versionId === null) {
    const ins = await sb.from('plan_versions').insert({label: LABEL, reason: REASON, created_by: 'seed'}).select('id').single();
    if (ins.error) fail(`cannot insert the plan version: ${ins.error.message}`);
    versionId = ins.data.id;
  }
  for (const part of chunks(rows.targetRows, BATCH)) {
    const r = await sb.from('plan_targets').upsert(part.map((t) => ({plan_version: versionId, ...t})), {onConflict: 'plan_version,month,metric', ignoreDuplicates: true});
    if (r.error) fail(`plan_targets write failed: ${r.error.message}`);
  }
  const after = (await sb.from('plan_targets').select('metric', {count: 'exact', head: true}).eq('plan_version', versionId)).count ?? 0;
  console.log(`applied: version ${LABEL} now has ${after} target rows, no actuals written`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main(process.argv.slice(2), process.env);
