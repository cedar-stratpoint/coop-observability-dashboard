// Shopee export import, command line. One code path with the API (src/shopee-import/). See knowledge/tasks/2026-10-22-shopee-import-data-engineering-plan.md.
//
//   npm run shopee:import -- plan <file or folder>... [--only-new] [--restate "reason"] [--include-superseded]
//   npm run shopee:import -- apply <importId>... | --all-staged  [--confirm-host <host>]
//   npm run shopee:import -- undo <importId> --reason "..."        [--confirm-host <host>]
//   npm run shopee:import -- coverage
//   npm run shopee:import -- reconcile        (each stored digest's Shopee revenue against the imported daily sales; changes nothing)
//
// `plan` is a dry run: it writes only inert staged rows that the app never reads. Nothing changes what the app shows until `apply`.
// Needs SUPABASE_URL_ARCHIVE and SUPABASE_SERVICE_ROLE_KEY_ARCHIVE in the environment (this script does not read .env files).
// apply and undo against a database that is not on this machine need --confirm-host <that host>, so a wrong environment cannot be hit by habit.
import {readdirSync, readFileSync, statSync} from 'node:fs';
import path from 'node:path';
import {createClient} from '@supabase/supabase-js';
import {reportsByWeek, weeksCoverage} from '../src/shopee-import/coverage';
import {classifyFile, isIgnored} from '../src/shopee-import/files';
import {applyRun, planFile, undoRun} from '../src/shopee-import/pipeline';
import {reconcileDigests} from '../src/shopee-import/reconcile';
import {loadConfirmedByDay, loadDigestsForReconcile, supabaseImportStore} from '../src/shopee-import/store-supabase';

const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (name: string): boolean => argv.includes(`--${name}`);
const opt = (name: string): string | null => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
};
const positional = (): string[] => {
  const out: string[] = [];
  for (let i = 1; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) {
      if (['restate', 'reason', 'confirm-host', 'today'].includes(argv[i].slice(2))) i += 1;
    } else out.push(argv[i]);
  }
  return out;
};

const phToday = (): string => new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10);
const money = (n: number): string => `₱${n.toLocaleString('en-US', {maximumFractionDigits: 2})}`;

function walk(root: string, includeSuperseded: boolean): string[] {
  if (statSync(root).isFile()) return [root];
  const out: string[] = [];
  const visit = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      if (isIgnored(path.relative(root, full).split(path.sep).join('/'), includeSuperseded)) continue;
      if (statSync(full).isDirectory()) visit(full);
      else out.push(full);
    }
  };
  visit(root);
  return out;
}

async function main(): Promise<void> {
  const url = process.env.SUPABASE_URL_ARCHIVE;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY_ARCHIVE;
  if (!url || !key) throw new Error('Set SUPABASE_URL_ARCHIVE and SUPABASE_SERVICE_ROLE_KEY_ARCHIVE (this command does not read .env files).');
  const host = new URL(url).hostname;
  const local = host === '127.0.0.1' || host === 'localhost';
  console.log(`database: ${host}${local ? ' (this machine)' : ''}`);
  const store = supabaseImportStore(createClient(url, key, {auth: {persistSession: false}}));
  const needsHost = (): void => {
    if (!local && opt('confirm-host') !== host) throw new Error(`This changes what the app shows on ${host}. Add --confirm-host ${host} to continue.`);
  };

  if (cmd === 'plan') {
    const files = positional().flatMap((p) => walk(p, flag('include-superseded')));
    const known = files.filter((f) => classifyFile(path.basename(f)).type !== null).sort((a, b) => (classifyFile(path.basename(a)).period?.from ?? '').localeCompare(classifyFile(path.basename(b)).period?.from ?? ''));
    if (known.length === 0) throw new Error('No Shopee export files found there.');
    const ids: string[] = [];
    const tally: Record<string, number> = {};
    for (const f of known) {
      const o = await planFile({store, bytes: readFileSync(f), filename: path.basename(f), today: opt('today') ?? phToday(), importedBy: process.env.USER ?? null, onlyNew: flag('only-new'), restate: opt('restate')});
      tally[o.status] = (tally[o.status] ?? 0) + 1;
      if (o.status === 'staged') {
        ids.push(o.importId);
        console.log(`\n${o.filename}: ${o.periodFrom} to ${o.periodTo}  [${o.importId}]`);
        console.log(`  new ${o.plan.newDays.length}, unchanged ${o.plan.unchanged.length}, changed ${o.plan.changed.length}${o.plan.keptCurrent.length ? `, kept as loaded ${o.plan.keptCurrent.length}` : ''}${o.plan.frozenBlocked.length ? `, frozen ${o.plan.frozenBlocked.length}` : ''}${o.openSkipped.length ? `, open days left out ${o.openSkipped.join(', ')}` : ''}`);
        for (const c of o.plan.changed) console.log(`  changed ${c.day}: ${money(c.before)} to ${money(c.after)} (${c.pct}%)`);
        for (const fl of o.plan.flags) console.log(`  FLAG ${fl.code}: ${fl.message}`);
      } else if (o.status === 'staged_report') {
        ids.push(o.importId);
        console.log(`\n${o.filename}: ${o.reportType} ${o.periodFrom} to ${o.periodTo}  [${o.importId}]`);
        console.log(`  ${o.rows} rows  ${Object.entries(o.summary).map(([k, v]) => `${k} ${v.toLocaleString('en-US')}`).join(', ')}${o.coveragePct === null ? '' : `, covers ${o.coveragePct}% of the shop's confirmed sales`}${o.openSkipped.length ? `, open days left out ${o.openSkipped.join(', ')}` : ''}${o.rawStored ? '' : '  (original file NOT kept)'}`);
      } else if (o.status === 'rejected') {
        console.log(`\n${o.filename}: REJECTED  [${o.importId}]`);
        for (const x of o.failures) console.log(`  ${x.code}: ${x.message}`);
      } else if (o.status === 'unsupported') console.log(`\n${o.filename}: skipped (${o.message})`);
      else if (o.status === 'already_loaded') console.log(`\n${o.filename}: already loaded [${o.importId}]`);
      else console.log(`\n${o.filename}: nothing new or changed`);
    }
    console.log(`\n${Object.entries(tally).map(([k, v]) => `${v} ${k}`).join(', ')}.`);
    if (ids.length) console.log(`To load the staged ones: apply ${ids.length === 1 ? ids[0] : '--all-staged'}${local ? '' : ' --confirm-host ' + host}`);
    return;
  }

  if (cmd === 'apply') {
    needsHost();
    const ids = flag('all-staged') ? (await store.listRuns('staged')).map((r) => r.importId) : positional();
    if (ids.length === 0) throw new Error('Nothing to apply: give import ids or --all-staged.');
    let failed = 0;
    for (const id of ids) {
      const r = await applyRun(store, id);
      if (!r.ok) {
        failed += 1;
        console.log(`${id}: NOT APPLIED (${r.code}) ${r.message}`);
        continue;
      }
      const x = r.receipt;
      if (x.reportType !== 'sales_overview') {
        console.log(`${id}: ${x.reportType} ${x.periodFrom} to ${x.periodTo}: loaded  ${Object.entries(x.summary ?? {}).map(([k, v]) => `${k} ${v.toLocaleString('en-US')}`).join(', ')}`);
        continue;
      }
      console.log(`${id}: ${x.periodFrom} to ${x.periodTo}: ${x.newDays} new days, ${x.changedDays} changed, confirmed sales ${money(x.loadedConfirmed)}${x.matchesFileTotal === true ? ' (matches the file total)' : x.matchesFileTotal === false ? ' (DOES NOT match the file total)' : ''}${x.reconciled ? '' : ' (a newer import overlaps this span)'}`);
    }
    if (failed) process.exitCode = 1;
    return;
  }

  if (cmd === 'undo') {
    needsHost();
    const id = positional()[0];
    if (!id) throw new Error('Give the import id to undo.');
    const r = await undoRun(store, id, opt('reason') ?? '');
    console.log(r.message);
    if (!r.ok) process.exitCode = 1;
    return;
  }

  if (cmd === 'coverage') {
    const days = await store.loadLoadedDays();
    const weeks = weeksCoverage(days, new Date(Date.parse(`${opt('today') ?? phToday()}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10)); // up to yesterday: today is an open day
    if (weeks.length === 0) console.log('Nothing loaded yet.');
    const reports = reportsByWeek(await store.loadReportPeriods(), weeks.map((w) => w.weekStart));
    const mark = (st: string): string => (st === 'full' ? 'yes' : st === 'partial' ? 'part' : '-');
    console.log('week                      sales            ads  sku  traffic  funnel');
    for (const w of weeks) {
      const r = reports[w.weekStart];
      console.log(`${w.weekStart} to ${w.weekEnd}  ${w.status.padEnd(8)} ${w.daysLoaded}/7  ${mark(r.ads).padStart(5)} ${mark(r.sku_detail).padStart(4)} ${mark(r.traffic).padStart(8)} ${mark(r.product_overview).padStart(7)}${w.missing.length ? `  sales missing ${w.missing.join(', ')}` : ''}`);
    }
    return;
  }

  if (cmd === 'reconcile') {
    const sb = createClient(url, key, {auth: {persistSession: false}});
    const lines = reconcileDigests(await loadDigestsForReconcile(sb), await loadConfirmedByDay(sb));
    if (lines.length === 0) console.log('No stored digests.');
    const pad = (x: string, n: number): string => x.padEnd(n);
    for (const l of lines) {
      const gap = l.gap === null ? '' : `  gap ${l.gap >= 0 ? '+' : '-'}${money(Math.abs(l.gap))} (${l.gapPct}%)`;
      const miss = l.daysMissing && l.status !== 'no_facts' ? `  ${l.daysMissing} days not imported` : '';
      console.log(`${l.from} to ${l.to}  ${pad(l.status, 17)} digest ${l.digestRevenue === null ? '-' : money(l.digestRevenue)}  imported ${l.factsRevenue === null ? '-' : money(l.factsRevenue)}${gap}${miss}  [by ${l.basis}]`);
    }
    return;
  }

  console.log('Commands: plan <paths...> | apply <importId...> | undo <importId> --reason "..." | coverage | reconcile');
  process.exitCode = 1;
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
