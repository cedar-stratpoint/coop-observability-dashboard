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
//                     into `vSept26` AND, when it is a different version, into the NEWEST version (the one the page reads): only rows that version is missing, never
//                     overwriting a value (BHR-06 review M3)
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
const keyOf = (r) => `${String(r.month).slice(0, 10)}|${r.metric}`;

/** Every (month, metric) one version holds, paged (a version holds more rows than one read returns). */
async function keysOf(sb, versionId) {
  const keys = new Set();
  for (let from = 0; ; from += 1000) {
    const r = await sb.from('plan_targets').select('month,metric').eq('plan_version', versionId).order('month').order('metric').range(from, from + 999);
    if (r.error) throw new Error(`cannot read plan_targets: ${r.error.message}`);
    for (const row of r.data ?? []) keys.add(keyOf(row));
    if ((r.data ?? []).length < 1000) return keys;
  }
}
/** Insert rows a version is missing. ignoreDuplicates: a row already there (an admin edit) is never overwritten. */
async function addMissing(sb, versionId, rows) {
  for (const part of chunks(rows, BATCH)) {
    const r = await sb.from('plan_targets').upsert(part.map((t) => ({plan_version: versionId, ...t})), {onConflict: 'plan_version,month,metric', ignoreDuplicates: true});
    if (r.error) throw new Error(`plan_targets write failed: ${r.error.message}`);
  }
}

/**
 * Load the workbook targets into the version `label` (created on --apply when absent), then into the NEWEST version too when that is a different one
 * (a target-edit version made before these sheet rows existed): the page reads the newest version (src/plan-data.ts), so its missing rows would wait.
 * Both only ADD missing (month, metric) rows; no existing value is ever overwritten. `apply` false = count only, write nothing.
 * Returns counts, never a figure: {base: {label, missing, added}, latest: null (the base is the newest) | {label, missing, added}}.
 */
export async function loadTargets(sb, targetRows, {label = LABEL, reason = REASON, apply = false, log = console.log} = {}) {
  const ver = await sb.from('plan_versions').select('id').eq('label', label).limit(1);
  if (ver.error) throw new Error(`cannot read plan_versions (is supabase/plan_report.sql applied?): ${ver.error.message}`);
  let baseId = ver.data?.[0]?.id ?? null;
  const baseHave = baseId === null ? new Set() : await keysOf(sb, baseId);
  const baseMissing = targetRows.filter((t) => !baseHave.has(keyOf(t)));
  log(`database: version ${label} ${baseId === null ? 'is not there yet' : 'exists'}, ${targetRows.length - baseMissing.length} of ${targetRows.length} target rows present`);
  if (apply && baseId === null) {
    const ins = await sb.from('plan_versions').insert({label, reason, created_by: 'seed'}).select('id').single();
    if (ins.error) throw new Error(`cannot insert the plan version: ${ins.error.message}`);
    baseId = ins.data.id;
  }
  if (apply) await addMissing(sb, baseId, baseMissing);
  const base = {label, missing: baseMissing.length, added: apply ? baseMissing.length : 0};

  const newest = await sb.from('plan_versions').select('id,label').order('id', {ascending: false}).limit(1);
  if (newest.error) throw new Error(`cannot read plan_versions: ${newest.error.message}`);
  const top = newest.data?.[0];
  if (!top || top.id === baseId) return {base, latest: null};
  const have = await keysOf(sb, top.id);
  const missing = targetRows.filter((t) => !have.has(keyOf(t)));
  log(`database: the newest version ${top.label} (the one the page reads) is missing ${missing.length} of ${targetRows.length} target rows${missing.length ? ' (they are added from the workbook; its own values are kept)' : ''}`);
  if (apply) await addMissing(sb, top.id, missing);
  return {base, latest: {label: top.label, missing: missing.length, added: apply ? missing.length : 0}};
}

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
  try {
    const r = await loadTargets(sb, rows.targetRows, {apply});
    console.log(apply
      ? `applied: added ${r.base.added} rows to ${r.base.label}${r.latest ? `, ${r.latest.added} to the newest version ${r.latest.label}` : ''}; nothing overwritten, no actuals written`
      : 'dry run: nothing written. Add --apply to write.');
  } catch (e) { fail(e.message); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main(process.argv.slice(2), process.env);
