// Layer 5 proof runner for the coop_chat_ro database role. LOCAL THROWAWAY SUPABASE (Docker) ONLY.
// Env: SB_URL (http://127.0.0.1:54321), SB_JWT_SECRET (local dev secret), SB_PSQL_CMD
//   e.g. "docker exec -i supabase_db_sb-local psql -U postgres -d postgres -v ON_ERROR_STOP=1"
// Optional: SB_ANON (apikey header). Refuses any non-localhost URL. Exits non-zero on any FAIL.
import { createHmac } from 'node:crypto'
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { assertLocalSupabase } from './local-only.mjs'

const URL_ = process.env.SB_URL, SECRET = process.env.SB_JWT_SECRET, PSQL = process.env.SB_PSQL_CMD, ANON = process.env.SB_ANON
if (!URL_ || !SECRET || !PSQL) throw new Error('set SB_URL, SB_JWT_SECRET, SB_PSQL_CMD')
assertLocalSupabase(URL_)

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const file = (p) => readFileSync(join(root, p), 'utf8')
const FIXTURE = file('scripts/coop-chat-ro-fixture.sql')
const MAIN = file('supabase/coop_chat_readonly.sql')
const STOCK_FIXTURE = file('scripts/coop-stock-fixture.sql')
const STOCK = file('supabase/coop_chat_stock.sql')
const CHECKS = file('supabase/coop_chat_readonly_checks.sql')
const PROOF = file('supabase/coop_chat_readonly_proof.sql')
const SWEEP = file('supabase/coop_chat_readonly_function_sweep.sql')

const CONTRACT = {
  coop_chat_orders: 'id,subtotal,discount,total,oversold,payment_method,status,created_at,edited_at,event_id,pet_type',
  coop_chat_order_items: 'id,order_id,product_id,bundle_id,bundle_group,qty,unit_price,line_total',
  coop_chat_products: 'product_id,name',
  coop_chat_bundles: 'bundle_id,name',
  coop_chat_prices: 'product_id,price',
  coop_chat_price_changes: 'id,product_id,old_price,new_price,changed_at',
  coop_chat_events: 'event_id,name,venue,city,starts_on,ends_on,status,created_at',
  coop_chat_stock_by_location: 'product_id,location,stock',
  coop_chat_sale_movements: 'id,product_id,delta,reason,created_at',
  coop_chat_stock_config: 'key,value',
}
const CUSTOMER = ['customer_handle', 'remarks', 'phone', 'email', 'instagram', 'customer_name', 'client_uuid', 'device_id', 'created_by', 'updated_by', 'changed_by', 'opening_cash', 'closing_cash', 'cash_note', 'organizer']

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
const now = Math.floor(Date.now() / 1000)
const mint = (role) => {
  const h = b64({ alg: 'HS256', typ: 'JWT' }), p = b64({ role, iss: 'supabase', iat: now, exp: now + 300, sub: 'ask-coop' })
  return `${h}.${p}.${createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url')}`
}
const RO = mint('coop_chat_ro'), SR = mint('service_role'), AN = mint('anon'), AU = mint('authenticated')

const sh = (sql, extra = '') => execSync(`${PSQL} ${extra} 2>&1`, { input: sql, encoding: 'utf8', maxBuffer: 1 << 24 })
const q = (sql) => sh(sql, '-t -A -F"|"').trim()

let pass = 0, fail = 0
const rec = (name, ok, detail = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' :: ' + String(detail).slice(0, 200) : ''}`) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function api(method, path, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json', Prefer: 'return=minimal' }
  if (token) headers.Authorization = `Bearer ${token}`
  if (ANON) headers.apikey = ANON
  const r = await fetch(`${URL_}/rest/v1/${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined })
  const t = await r.text(); let j; try { j = JSON.parse(t) } catch { j = t }
  return { status: r.status, body: j, text: t }
}
const reload = async () => { sh("notify pgrst, 'reload config'; notify pgrst, 'reload schema';"); await sleep(2000) }
const writeRpc = (token) => api('POST', 'rpc/fake_write_rpc', { token, body: {} })
const count = () => Number(q('select count(*) from public.pos_orders'))

// ---- setup: clean slate, fixture, apply real SQL twice (idempotency)
sh(`do $$ begin if exists (select 1 from pg_roles where rolname='coop_chat_ro') then alter role coop_chat_ro reset all; end if; end $$;
    alter role authenticator reset pgrst.db_pre_request;`)
sh(FIXTURE)
sh(STOCK_FIXTURE) // the stock tables the three stock views read (local fixture only)
const out1 = sh(MAIN)
rec('apply coop_chat_readonly.sql (first run)', !/ERROR/.test(out1), out1.match(/ERROR.*/)?.[0])
const out2 = sh(MAIN)
rec('apply coop_chat_readonly.sql again (idempotent)', !/ERROR/.test(out2), out2.match(/ERROR.*/)?.[0])
const outStock = sh(STOCK)
rec('apply coop_chat_stock.sql (and again: idempotent)', !/ERROR/.test(outStock) && !/ERROR/.test(sh(STOCK)), outStock.match(/ERROR.*/)?.[0])
rec('hook installed notice', /pgrst\.db_pre_request set to public\.coop_chat_pre_request/.test(out2))
await reload()

// ---- views through PostgREST with the minted token
for (const [view, cols] of Object.entries(CONTRACT)) {
  const r = await api('GET', `${view}?select=*&limit=1`, { token: RO })
  const keys = Array.isArray(r.body) && r.body[0] ? Object.keys(r.body[0]).join(',') : ''
  rec(`read ${view} with exact contract columns`, r.status === 200 && [...keys.split(',')].sort().join() === cols.split(',').sort().join(), `${r.status} ${keys}`)
  const withCust = CUSTOMER.filter((c) => keys.split(',').includes(c))
  rec(`no customer columns in ${view}`, withCust.length === 0, withCust.join())
}
{ const r = await api('GET', 'coop_chat_order_items?select=order_id,qty&order=id.asc&limit=3', { token: RO })
  rec('order=id works on coop_chat_order_items', r.status === 200 && r.body.length === 3, `${r.status}`) }
for (const t of ['pos_orders', 'pos_order_items', 'pos_products', 'pos_bundles', 'pos_prices', 'pos_price_changes', 'pos_events', 'pos_inventory_by_location', 'pos_stock_movements', 'pos_settings']) {
  const r = await api('GET', `${t}?select=*&limit=1`, { token: RO })
  rec(`base table ${t} denied`, r.status >= 400 && !Array.isArray(r.body), `${r.status} ${r.text}`)
}
for (const c of CUSTOMER) {
  const r = await api('GET', `coop_chat_orders?select=${c}`, { token: RO })
  rec(`customer column ${c} absent (400)`, r.status === 400, `${r.status}`)
}
{ const before = count()
  const post = await api('POST', 'coop_chat_orders', { token: RO, body: { total: 1 } })
  const patch = await api('PATCH', 'coop_chat_orders?id=eq.1', { token: RO, body: { total: 0 } })
  const del = await api('DELETE', 'coop_chat_orders?id=eq.1', { token: RO })
  rec('POST view denied', post.status >= 400, post.status)
  rec('PATCH view denied', patch.status >= 400, patch.status)
  rec('DELETE view denied', del.status >= 400, del.status)
  rec('no row changed by write attempts', count() === before && q("select total from public.pos_orders where id=1") === '500') }

// ---- hook: before and after
sh("alter role authenticator reset pgrst.db_pre_request;"); await reload()
{ const n0 = count(); const r = await writeRpc(RO)
  rec('BEFORE hook: write RPC succeeds as coop_chat_ro (documents the risk)', r.status < 300 && count() === n0 + 1, `${r.status} ${r.text}`) }
sh(MAIN); await reload()
{ const n0 = count(); const r = await writeRpc(RO)
  rec('AFTER hook: write RPC fails read-only as coop_chat_ro', r.status >= 400 && /read-only transaction/.test(r.text) && count() === n0, `${r.status} ${r.text}`)
  const rd = await api('GET', 'coop_chat_orders?select=id&limit=1', { token: RO })
  rec('AFTER hook: reads as coop_chat_ro still work', rd.status === 200 && rd.body.length === 1, rd.status) }
for (const [name, tok] of [['service_role', SR], ['anon', AN], ['authenticated', AU]]) {
  const n0 = count(); const r = await writeRpc(tok)
  rec(`AFTER hook: ${name} write RPC unaffected`, r.status < 300 && count() === n0 + 1, `${r.status} ${r.text}`)
}
{ const ins = await api('POST', 'pos_products', { token: SR, body: { product_id: 'PX', name: 'x' } })
  rec('AFTER hook: service_role table insert works', ins.status === 201, ins.status)
  await api('DELETE', 'pos_products?product_id=eq.PX', { token: SR })
  const rd = await api('GET', 'pos_products?select=product_id&limit=1', { token: SR })
  rec('AFTER hook: service_role reads base table', rd.status === 200 && rd.body.length > 0, rd.status) }

// ---- existing-hook case: must be skipped, not overwritten
sh(`create or replace function public.other_hook() returns void language sql as 'select 1';
    alter role authenticator set pgrst.db_pre_request = 'public.other_hook';`)
{ const out = sh(MAIN)
  const now_ = q("select c from pg_db_role_setting s join pg_roles r on r.oid=s.setrole cross join unnest(s.setconfig) c where r.rolname='authenticator' and c like 'pgrst.db_pre_request=%'")
  rec('existing hook: skipped with notice', /SKIPPED: authenticator already has a different pgrst\.db_pre_request/.test(out), out.match(/SKIPPED.{0,60}/)?.[0])
  rec('existing hook: not overwritten', now_ === 'pgrst.db_pre_request=public.other_hook', now_) }
sh(`alter role authenticator reset pgrst.db_pre_request; drop function public.other_hook();`)
sh(MAIN); await reload()
rec('hook restored after existing-hook case', q("select count(*) from pg_db_role_setting s join pg_roles r on r.oid=s.setrole cross join unnest(s.setconfig) c where r.rolname='authenticator' and c='pgrst.db_pre_request=public.coop_chat_pre_request'") === '1')

// ---- checks.sql through psql
const stmts = CHECKS.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').split(/;\s*(?:\n|$)/).map((s) => s.trim()).filter(Boolean)
rec('checks.sql has 5 queries', stmts.length === 5, stmts.length)
const [qa, qb, qc, qd, qe] = stmts.map((s) => q(s + ';'))
const rowsA = qa.split('\n').filter(Boolean)
rec('(a) lists the definer fixture function and the hook', rowsA.some((l) => /fake_write_rpc\(\)\|t\|/.test(l)) && rowsA.some((l) => /coop_chat_pre_request\(\)\|f\|/.test(l)), qa)
rec('(a) release check: definer functions callable only with hook installed', rowsA.every((l) => !/\|t\|/.test(l)) || /public\.coop_chat_pre_request/.test(qc))
rec('(b) exactly SELECT on the ten views', qb.split('\n').sort().join() === Object.keys(CONTRACT).sort().map((v) => `public|${v}|SELECT`).join(), qb)
rec('(c) hook set to coop_chat_pre_request', /pgrst\.db_pre_request=public\.coop_chat_pre_request/.test(qc), qc)
rec('(d) role cannot login/inherit/bypass', qd === 'coop_chat_ro|f|f|f|f|f|f', qd)
rec('(e) ten views match the contract', qe.split('\n').length === 10 && qe.split('\n').every((l) => l.endsWith('|t')), qe)

// ---- proof.sql through psql
const proofBefore = count()
const proofOut = sh(PROOF)
const passes = (proofOut.match(/NOTICE:\s+PASS/g) || []).length, fails = (proofOut.match(/NOTICE:\s+FAIL/g) || []).length
rec('proof.sql: all PASS lines, no FAIL', passes >= 48 && fails === 0 && !/ERROR/.test(proofOut), `${passes} PASS, ${fails} FAIL`)
rec('proof.sql rolled back (row count unchanged)', count() === proofBefore)

// ---- optional sweep: dry run changes nothing, apply revokes PUBLIC only
const canExec = (r) => q(`select has_function_privilege('${r}','public.fake_write_rpc()','execute')`) === 't'
const dry = sh(SWEEP)
rec('sweep dry run prints the statement and changes nothing', /DRY RUN would run: revoke execute on function public\.fake_write_rpc\(\)/.test(dry) && canExec('coop_chat_ro'))
sh(SWEEP.replace('apply boolean := false;', 'apply boolean := true;'))
rec('sweep apply: coop_chat_ro cannot execute the definer function', !canExec('coop_chat_ro'))
rec('sweep apply: anon, authenticated, service_role still can', ['anon', 'authenticated', 'service_role'].every(canExec))
{ const n0 = count(); const r = await writeRpc(AN); rec('sweep apply: anon write RPC still works over HTTP', r.status < 300 && count() === n0 + 1, r.status)
  const rr = await writeRpc(RO); rec('sweep apply: coop_chat_ro RPC denied over HTTP', rr.status >= 400, `${rr.status} ${rr.text}`) }
sh('grant execute on function public.fake_write_rpc() to public;')

console.log(`\n${pass} PASS, ${fail} FAIL`)
process.exit(fail ? 1 : 0)
