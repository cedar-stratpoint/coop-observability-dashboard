// Copy Goldline's data (gl_* rows + goldline-uploads files) from the Coop archive
// project to the dedicated Nichido project. One-off per environment; safe to re-run.
//
//   npx tsx --env-file=.env --env-file=.env.local scripts/nichido/migrate-goldline.ts            # plan only (default)
//   npx tsx --env-file=.env --env-file=.env.local scripts/nichido/migrate-goldline.ts --apply    # copy
//   npx tsx --env-file=.env --env-file=.env.local scripts/nichido/migrate-goldline.ts --verify   # compare both sides
//
// Reads SUPABASE_URL_ARCHIVE / SUPABASE_SERVICE_ROLE_KEY_ARCHIVE (source) and NICHIDO_URL /
// NICHIDO_SERVICE_ROLE_KEY (target) from the environment; it does not read .env files
// itself, hence the --env-file flags (later files win). The two projects must be the
// same Coop environment (src/coop-env.ts); production also needs --prod.
//
// Rows keep their ids and are upserted on the primary key in FK order, so a re-run
// changes nothing or catches up rows written since the last run. Files keep their exact
// storage paths, so gl_uploads.storage_path stays valid. Nothing is ever deleted on
// either side. Schema must already exist (supabase/nichido/goldline_schema.sql); after
// --apply, run supabase/nichido/goldline_post_copy.sql to move the id sequences on.
import {createHash} from 'node:crypto';
import {createClient, type SupabaseClient} from '@supabase/supabase-js';
import {fetchAllRows} from '../../src/pos-fetch-paginate';
import {dbRefOf, envForDbRef, nichidoPairOk} from '../../src/coop-env';

const COMPANY = 'goldline';
const BUCKET = 'goldline-uploads';
const CHUNK = 500;

// FK order: parents before children.
const TABLES: Array<{name: string; pk: string[]}> = [
  {name: 'gl_stores', pk: ['company_id', 'store_code']},
  {name: 'gl_products', pk: ['company_id', 'item_code']},
  {name: 'gl_upload_batches', pk: ['id']},
  {name: 'gl_uploads', pk: ['id']},
  {name: 'gl_extractions', pk: ['id']},
  {name: 'gl_inventory', pk: ['id']},
  {name: 'gl_sales', pk: ['id']},
  {name: 'gl_supply_settings', pk: ['company_id']},
  {name: 'gl_line_lead_times', pk: ['company_id', 'product_line']},
  {name: 'gl_store_transit', pk: ['company_id', 'store_code']},
  {name: 'gl_warehouse_stock', pk: ['company_id', 'item_code']},
  {name: 'gl_shipments', pk: ['id']},
  {name: 'gl_price_changes', pk: ['id']},
];

type Row = Record<string, unknown>;
type FileEntry = {path: string; size: number; mimetype: string | null};

const flag = (f: string) => process.argv.includes(f);
const mode = flag('--apply') ? 'apply' : flag('--verify') ? 'verify' : 'plan';

function clients(): {src: SupabaseClient; dst: SupabaseClient; label: string} {
  const su = process.env.SUPABASE_URL_ARCHIVE;
  const sk = process.env.SUPABASE_SERVICE_ROLE_KEY_ARCHIVE;
  const du = process.env.NICHIDO_URL;
  const dk = process.env.NICHIDO_SERVICE_ROLE_KEY;
  if (!su || !sk || !du || !dk) throw new Error('Set SUPABASE_URL_ARCHIVE, SUPABASE_SERVICE_ROLE_KEY_ARCHIVE, NICHIDO_URL and NICHIDO_SERVICE_ROLE_KEY.');
  const env = envForDbRef(dbRefOf(su));
  if (!env) throw new Error(`Archive ${dbRefOf(su)} is not a known Coop environment.`);
  if (!nichidoPairOk(su, du)) throw new Error(`Nichido ${dbRefOf(du)} is not the ${env.label} Nichido project (${env.nichidoRef}).`);
  if (env.key === 'production' && !flag('--prod')) throw new Error('Source is the PRODUCTION archive; pass --prod to confirm.');
  const opts = {auth: {persistSession: false}};
  return {src: createClient(su, sk, opts), dst: createClient(du, dk, opts), label: `${env.label}: ${dbRefOf(su)} → ${dbRefOf(du)}`};
}

async function readAll(db: SupabaseClient, table: string, pk: string[]): Promise<Row[]> {
  return fetchAllRows(table, (from, to) => {
    let q = db.from(table).select('*').eq('company_id', COMPANY);
    for (const c of pk) q = q.order(c, {ascending: true});
    return q.range(from, to);
  });
}

// Key-sorted JSON so the same row hashes the same on both sides.
const canon = (v: unknown): string =>
  v && typeof v === 'object' && !Array.isArray(v)
    ? `{${Object.keys(v as Row).sort().map((k) => `${JSON.stringify(k)}:${canon((v as Row)[k])}`).join(',')}}`
    : Array.isArray(v) ? `[${v.map(canon).join(',')}]` : JSON.stringify(v);
const keyOf = (r: Row, pk: string[]) => pk.map((c) => String(r[c])).join('|');
const hashRows = (rows: Row[]) => createHash('sha256').update(rows.map(canon).join('\n')).digest('hex').slice(0, 16);

async function listFiles(db: SupabaseClient, prefix = ''): Promise<FileEntry[]> {
  const out: FileEntry[] = [];
  for (let offset = 0; ; offset += 1000) {
    const {data, error} = await db.storage.from(BUCKET).list(prefix, {limit: 1000, offset, sortBy: {column: 'name', order: 'asc'}});
    if (error) throw new Error(`list ${prefix || '/'}: ${error.message}`);
    for (const e of data ?? []) {
      const path = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.id === null) out.push(...(await listFiles(db, path))); // a folder
      else out.push({path, size: Number(e.metadata?.size ?? 0), mimetype: (e.metadata?.mimetype as string) ?? null});
    }
    if ((data ?? []).length < 1000) return out;
  }
}

async function copyTable(src: SupabaseClient, dst: SupabaseClient, t: {name: string; pk: string[]}) {
  const rows = await readAll(src, t.name, t.pk);
  const have = new Map((await readAll(dst, t.name, t.pk)).map((r) => [keyOf(r, t.pk), canon(r)]));
  const todo = rows.filter((r) => have.get(keyOf(r, t.pk)) !== canon(r));
  if (mode === 'apply') {
    for (let i = 0; i < todo.length; i += CHUNK) {
      const {error} = await dst.from(t.name).upsert(todo.slice(i, i + CHUNK), {onConflict: t.pk.join(',')});
      if (error) throw new Error(`${t.name} upsert: ${error.message}`);
    }
  }
  console.log(`  ${t.name.padEnd(20)} source ${String(rows.length).padStart(5)}  ${mode === 'apply' ? 'written' : 'to write'} ${todo.length}`);
}

async function copyFiles(src: SupabaseClient, dst: SupabaseClient) {
  const files = await listFiles(src);
  const have = new Map((await listFiles(dst)).map((f) => [f.path, f.size]));
  const todo = files.filter((f) => have.get(f.path) !== f.size);
  if (mode === 'apply') {
    for (const f of todo) {
      const {data, error} = await src.storage.from(BUCKET).download(f.path);
      if (error || !data) throw new Error(`download ${f.path}: ${error?.message}`);
      const up = await dst.storage.from(BUCKET).upload(f.path, data, {upsert: true, contentType: f.mimetype ?? undefined});
      if (up.error) throw new Error(`upload ${f.path}: ${up.error.message}`);
    }
  }
  console.log(`  ${`storage:${BUCKET}`.padEnd(20)} source ${String(files.length).padStart(5)}  ${mode === 'apply' ? 'written' : 'to write'} ${todo.length}`);
}

async function verify(src: SupabaseClient, dst: SupabaseClient): Promise<boolean> {
  let ok = true;
  for (const t of TABLES) {
    const [a, b] = await Promise.all([readAll(src, t.name, t.pk), readAll(dst, t.name, t.pk)]);
    const same = a.length === b.length && hashRows(a) === hashRows(b);
    ok &&= same;
    console.log(`  ${same ? 'OK  ' : 'DIFF'} ${t.name.padEnd(20)} ${a.length} / ${b.length}  ${hashRows(a)} / ${hashRows(b)}`);
  }
  const [fa, fb] = await Promise.all([listFiles(src), listFiles(dst)]);
  const sig = (fs: FileEntry[]) => fs.map((f) => `${f.path}:${f.size}`).sort().join('\n');
  const same = sig(fa) === sig(fb);
  ok &&= same;
  const bytes = (fs: FileEntry[]) => fs.reduce((n, f) => n + f.size, 0);
  console.log(`  ${same ? 'OK  ' : 'DIFF'} ${`storage:${BUCKET}`.padEnd(20)} ${fa.length} / ${fb.length} files  ${bytes(fa)} / ${bytes(fb)} bytes`);
  return ok;
}

async function main() {
  const {src, dst, label} = clients();
  console.log(`Goldline → Nichido (${mode}) ${label}`);
  if (mode === 'verify') {
    const ok = await verify(src, dst);
    console.log(ok ? 'All tables and files match.' : 'Differences found.');
    process.exit(ok ? 0 : 1);
  }
  for (const t of TABLES) await copyTable(src, dst, t);
  await copyFiles(src, dst);
  console.log(mode === 'apply' ? 'Done. Now run supabase/nichido/goldline_post_copy.sql, then --verify.' : 'Plan only; pass --apply to copy.');
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
