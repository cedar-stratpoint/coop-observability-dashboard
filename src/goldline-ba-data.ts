import 'server-only';
import {nichidoConfigured, nichidoDb} from './nichido-client';
import {fetchAllRows} from './pos-fetch-paginate';
import {getGlStores} from './goldline-ref-data';
import {runChecks} from './goldline-checks-data';
import {cleanName, normName, parseBaLines, resolveBa, type StoreBa} from './goldline-ba';

// The BA directory (A1): who covers which store from when (store_bas), read when a
// form is saved without a BA name and written from /bas. Assigning a BA also fills in
// that store's saved forms from that date that have no name, then re-runs the store's
// checks, so their flags count against the right BA (Oct 26: every flag counts).
// A name written on a form is never overwritten. Pure rules: src/goldline-ba.ts.

const db = nichidoDb;

export class BaError extends Error {}

const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** Directory rows per store (every assignment, old and current). */
export async function getStoreBas(companyId: string, stores?: string[]): Promise<Map<string, StoreBa[]>> {
  const out = new Map<string, StoreBa[]>();
  if (!nichidoConfigured()) return out;
  const rows = (await fetchAllRows('store_bas', (from, to) => {
    let q = db().from('store_bas').select('store_code,started_on,ended_on,ba:bas(name)').eq('company_id', companyId); // pagination-ok: paged by fetchAllRows (.range below)
    if (stores) q = q.in('store_code', stores);
    return q.order('store_code').order('started_on').range(from, to);
  })) as unknown as Array<{store_code: string; started_on: string; ended_on: string | null; ba: {name: string} | null}>;
  for (const r of rows) {
    if (!r.ba) continue;
    out.set(r.store_code, [...(out.get(r.store_code) ?? []), {name: r.ba.name, started_on: r.started_on, ended_on: r.ended_on}]);
  }
  return out;
}

/** The BA to save on a form: written name completed from the directory, else the store's BA. */
export async function resolveFormBa(companyId: string, store: string, periodEnd: string, written: string | null | undefined): Promise<string | null> {
  try {
    const dir = await getStoreBas(companyId, [store]);
    return resolveBa({written, storeBas: dir.get(store) ?? [], periodEnd}).name;
  } catch (e) {
    // The directory is a convenience: a failed read never blocks saving a form.
    console.error('resolveFormBa', e);
    return cleanName(written ?? '') || null;
  }
}

/** Each store's current BA, and every BA name, for the review screen's BA field. */
export async function getCurrentBas(companyId: string): Promise<{byStore: Record<string, string>; names: string[]}> {
  if (!nichidoConfigured()) return {byStore: {}, names: []};
  try {
    const dir = await getStoreBas(companyId);
    const byStore: Record<string, string> = {};
    const names = new Set<string>();
    for (const [store, rows] of dir) {
      for (const r of rows) names.add(r.name);
      const cur = rows.find((r) => r.ended_on == null);
      if (cur) byStore[store] = cur.name;
    }
    return {byStore, names: [...names].sort()};
  } catch (e) {
    console.error('getCurrentBas', e);
    return {byStore: {}, names: []};
  }
}

export type BaStoreRow = {
  code: string;
  name: string;
  ba: string | null; // current BA
  since: string | null;
  lastForm: string | null; // latest saved cycle's last day
  formsNoBa: number; // saved cycles with no BA name
};
export type BaDirectory = {stores: BaStoreRow[]; bas: string[]};

/** Stores that send forms or have a BA, with their current BA (store-scoped roles: theirs only). */
export async function getBaDirectory(companyId: string, scope: string[] | null): Promise<BaDirectory> {
  if (!nichidoConfigured()) return {stores: [], bas: []};
  const supa = db();
  const [stores, dir, snaps, bas] = await Promise.all([
    getGlStores(companyId),
    getStoreBas(companyId, scope ?? undefined),
    fetchAllRows('inventory_snapshots', (from, to) => {
      let q = supa.from('inventory_snapshots').select('store_code,period_end,consultant').eq('company_id', companyId); // pagination-ok: paged by fetchAllRows (.range below)
      if (scope) q = q.in('store_code', scope);
      return q.order('store_code').order('period_end').range(from, to);
    }) as unknown as Promise<Array<{store_code: string; period_end: string; consultant: string | null}>>,
    fetchAllRows('bas', (from, to) => supa.from('bas').select('name').eq('company_id', companyId).order('name').range(from, to)) as unknown as Promise<Array<{name: string}>>,
  ]);
  const nameOf = new Map(stores.map((s) => [s.store_code, s.name]));
  const codes = new Set([...snaps.map((s) => s.store_code), ...dir.keys()]);
  const rows: BaStoreRow[] = [...codes]
    .filter((c) => !scope || scope.includes(c))
    .map((code) => {
      const mine = snaps.filter((s) => s.store_code === code);
      const cur = (dir.get(code) ?? []).find((a) => a.ended_on == null) ?? null;
      return {
        code,
        name: nameOf.get(code) ?? `Store ${code}`,
        ba: cur?.name ?? null,
        since: cur?.started_on ?? null,
        lastForm: mine.at(-1)?.period_end ?? null,
        formsNoBa: mine.filter((s) => !s.consultant?.trim()).length,
      };
    })
    // Stores whose forms have no BA first, then by store code.
    .sort((a, b) => Number(b.formsNoBa > 0 && !b.ba) - Number(a.formsNoBa > 0 && !a.ba) || a.code.localeCompare(b.code, undefined, {numeric: true}));
  return {stores: rows, bas: bas.map((b) => b.name)};
}

/** Find a BA by name (any case, spacing or dots), or add one. */
async function baId(companyId: string, name: string, by: string | null): Promise<{id: string; name: string}> {
  const supa = db();
  const all = (await fetchAllRows('bas', (from, to) => supa.from('bas').select('id,name').eq('company_id', companyId).order('id').range(from, to))) as unknown as Array<{id: string; name: string}>;
  const hit = all.find((b) => normName(b.name) === normName(name));
  if (hit) return hit;
  const res = await supa.from('bas').insert({company_id: companyId, name, created_by: by}).select('id,name').single();
  if (res.error) throw new Error(`add BA failed: ${res.error.message}`);
  return res.data as {id: string; name: string};
}

/**
 * Make `name` the store's BA from `from`. The current assignment ends the day before
 * (or is replaced when it started on or after `from`). Saved forms for the store from
 * that date with no BA name get this one. Returns how many form rows were filled.
 */
export async function assignBa(
  companyId: string,
  scope: string[] | null,
  input: {store: string; name: string; from: string; by: string | null},
  rerun = true,
): Promise<{filled: number; unchanged: boolean}> {
  const name = cleanName(input.name);
  if (name.length < 2 || name.length > 80) throw new BaError('Enter the BA’s full name.');
  if (scope && !scope.includes(input.store)) throw new BaError(`Store ${input.store} is outside your access.`);
  const supa = db();
  const store = await supa.from('stores').select('store_code').eq('company_id', companyId).eq('store_code', input.store).maybeSingle();
  if (!store.data) throw new BaError(`Store ${input.store} isn’t in the store list.`);
  const ba = await baId(companyId, name, input.by);

  const open = await supa.from('store_bas').select('id,ba_id,started_on').eq('company_id', companyId).eq('store_code', input.store).is('ended_on', null).maybeSingle();
  if (open.error) throw new Error(open.error.message);
  let unchanged = false;
  if (open.data && open.data.ba_id === ba.id && open.data.started_on <= input.from) unchanged = true;
  else {
    if (open.data) {
      const res =
        open.data.started_on < input.from
          ? await supa.from('store_bas').update({ended_on: addDays(input.from, -1)}).eq('id', open.data.id)
          : await supa.from('store_bas').delete().eq('id', open.data.id);
      if (res.error) throw new Error(`end assignment failed: ${res.error.message}`);
    }
    const ins = await supa.from('store_bas').insert({company_id: companyId, store_code: input.store, ba_id: ba.id, started_on: input.from, created_by: input.by});
    if (ins.error) throw new Error(`assign failed: ${ins.error.message}`);
  }

  // Fill saved forms from that date that have no BA name (never overwrite a written one).
  const fill = await supa
    .from('inventory') // pagination-ok: an update that returns a count, not rows
    .update({consultant: ba.name}, {count: 'exact'})
    .eq('company_id', companyId)
    .eq('store_code', input.store)
    .gte('period_end', input.from)
    .or('consultant.is.null,consultant.eq.');
  if (fill.error) throw new Error(`fill forms failed: ${fill.error.message}`);
  const filled = fill.count ?? 0;
  if (rerun && filled) await runChecks(companyId, [input.store]).catch((e) => console.error('runChecks after assignBa', e));
  return {filled, unchanged};
}

/** Paste "store code, BA name" lines (e.g. Justin's list): assign each from `from`. */
export async function importBas(
  companyId: string,
  scope: string[] | null,
  input: {text: string; from: string; by: string | null},
): Promise<{assigned: number; filled: number; errors: string[]}> {
  const {rows, errors} = parseBaLines(input.text);
  if (!rows.length) throw new BaError(errors.length ? `Couldn’t read: ${errors.slice(0, 3).join(' · ')}` : 'Paste one “store code, BA name” per line.');
  if (rows.length > 1000) throw new BaError('Paste up to 1,000 lines at a time.');
  let assigned = 0;
  let filled = 0;
  const touched = new Set<string>();
  for (const r of rows) {
    try {
      const res = await assignBa(companyId, scope, {store: r.store, name: r.name, from: input.from, by: input.by}, false);
      assigned++;
      filled += res.filled;
      if (res.filled) touched.add(r.store);
    } catch (e) {
      if (e instanceof BaError) errors.push(`${r.store}: ${e.message}`);
      else throw e;
    }
  }
  if (touched.size) await runChecks(companyId, [...touched]).catch((e) => console.error('runChecks after importBas', e));
  return {assigned, filled, errors};
}
