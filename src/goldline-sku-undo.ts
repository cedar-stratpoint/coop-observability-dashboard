import 'server-only';
import {nichidoDb} from './nichido-client';
import {fetchAllRows} from './pos-fetch-paginate';
import {CHAIN_FIELDS, diffSnaps, driftedRows, NOTE_FIELDS, PRODUCT_FIELDS, REVIEW_FIELDS, undoEffectGroups, type Row, type Snap} from './goldline-sku-undo-diff';

// Undo for SKU linking (Oct 29), the database half. `recordDecision` wraps one action:
// snapshot, run, snapshot again, and log only the rows that changed (f2e). `undoDecision`
// restores those rows to `before`, but only if the entry is still the latest on its SKU or
// item and every row still equals `after`. The pure diffing and wording live in
// goldline-sku-undo-diff.ts.

const CHAIN = 'watsons';
const db = nichidoDb;

export type DecisionTarget = 'sku' | 'item';
export type DecisionAction = 'approved' | 'rejected' | 'linked' | 'unlinked' | 'remark' | 'decommissioned' | 'restored' | 'note';
/** The latest decision on a SKU or an item, for the page: undo it, or show that it was undone. */
export type DecisionInfo = {
  id: number;
  action: DecisionAction;
  summary: string | null;
  by: string | null;
  at: string;
  undoneBy: string | null;
  undoneAt: string | null;
  effects: string[]; // what undoing will do to this SKU or item, one sentence each
  elsewhere: string[]; // what it puts back on other SKUs or items (a reject's re-matching)
};

export class UndoError extends Error {}

const pick = (r: Row, fields: readonly string[]) => Object.fromEntries(fields.map((f) => [f, r[f] ?? null]));

/** Everything a decision can touch: all items' link and retire fields, all suggestions, and this key's decision or note. */
async function snapshot(companyId: string, target: DecisionTarget, key: string): Promise<Snap> {
  const supa = db();
  const [products, chain, review, note] = await Promise.all([
    fetchAllRows('products', (from, to) => supa.from('products').select(`item_code,${PRODUCT_FIELDS.join(',')}`).eq('company_id', companyId).order('item_code').range(from, to)) as Promise<Row[]>,
    fetchAllRows('chain_skus', (from, to) =>
      supa.from('chain_skus').select(`sku_code,${CHAIN_FIELDS.join(',')}`).eq('company_id', companyId).eq('chain', CHAIN).order('sku_code').range(from, to),
    ) as Promise<Row[]>,
    target === 'sku'
      ? supa.from('sku_link_reviews').select(REVIEW_FIELDS.join(',')).eq('company_id', companyId).eq('chain', CHAIN).eq('sku_code', key).maybeSingle()
      : Promise.resolve({data: null, error: null}),
    target === 'item' ? supa.from('item_notes').select(NOTE_FIELDS.join(',')).eq('company_id', companyId).eq('item_code', key).maybeSingle() : Promise.resolve({data: null, error: null}),
  ]);
  if (review.error) throw new Error(`snapshot review: ${review.error.message}`);
  if (note.error) throw new Error(`snapshot note: ${note.error.message}`);
  return {
    products: Object.fromEntries(products.map((p) => [String(p.item_code), pick(p, PRODUCT_FIELDS)])),
    chain: Object.fromEntries(chain.map((c) => [String(c.sku_code), pick(c, CHAIN_FIELDS)])),
    review: target === 'sku' ? {[key]: review.data ? pick(review.data as unknown as Row, REVIEW_FIELDS) : null} : {},
    notes: target === 'item' ? {[key]: note.data ? pick(note.data as unknown as Row, NOTE_FIELDS) : null} : {},
  };
}

/** Run one decision and log what it changed. Returns the log id (null when nothing changed). */
export async function recordDecision(
  companyId: string,
  d: {target: DecisionTarget; key: string; action: DecisionAction; summary?: string | null; by: string | null},
  fn: () => Promise<unknown>,
): Promise<number | null> {
  const before = await snapshot(companyId, d.target, d.key);
  await fn();
  const after = await snapshot(companyId, d.target, d.key);
  const diff = diffSnaps(before, after);
  if (!diff.changed) return null;
  const res = await db()
    .from('sku_decision_log')
    .insert({company_id: companyId, target: d.target, key: d.key, action: d.action, summary: d.summary ?? null, done_by: d.by, before: diff.before, after: diff.after})
    .select('id')
    .single();
  // The decision itself is saved; a missing log only means it can't be undone.
  if (res.error) {
    console.error('sku_decision_log insert failed', res.error.message);
    return null;
  }
  return Number((res.data as {id: number}).id);
}

export type LogRow = {id: number; target: DecisionTarget; key: string; action: DecisionAction; summary: string | null; done_by: string | null; done_at: string; before: Snap; after: Snap; undone_by: string | null; undone_at: string | null};

/** Every logged decision, newest first (the page reads it once for Undo and for activity). */
export async function readDecisionLog(companyId: string): Promise<LogRow[]> {
  const supa = db();
  return (await fetchAllRows('sku_decision_log', (from, to) =>
    supa.from('sku_decision_log').select('id,target,key,action,summary,done_by,done_at,before,after,undone_by,undone_at').eq('company_id', companyId).order('id', {ascending: false}).range(from, to),
  )) as unknown as LogRow[];
}

/** The latest decision per SKU and per item, keyed `sku:CODE` / `item:CODE`. */
export function latestFromLog(rows: LogRow[]): Record<string, DecisionInfo> {
  const out: Record<string, DecisionInfo> = {};
  for (const r of rows) {
    const k = `${r.target}:${r.key}`;
    if (out[k]) continue; // newest first: the first one seen is the latest
    const g = r.undone_at ? {here: [], elsewhere: []} : undoEffectGroups(r.before, r.after, {target: r.target, key: r.key});
    out[k] = {
      id: Number(r.id),
      action: r.action,
      summary: r.summary,
      by: r.done_by,
      at: r.done_at,
      undoneBy: r.undone_by,
      undoneAt: r.undone_at,
      effects: g.here,
      elsewhere: g.elsewhere,
    };
  }
  return out;
}

/** Undo one logged decision. Returns what it was about, so checks can re-run for SKUs. */
export async function undoDecision(companyId: string, id: number, by: string | null): Promise<{target: DecisionTarget; key: string}> {
  const supa = db();
  const got = await supa.from('sku_decision_log').select('id,target,key,before,after,undone_at').eq('company_id', companyId).eq('id', id).maybeSingle();
  if (got.error) throw new Error(got.error.message);
  const e = got.data as unknown as Pick<LogRow, 'id' | 'target' | 'key' | 'before' | 'after' | 'undone_at'> | null;
  if (!e) throw new UndoError('That decision isn’t in the log.');
  if (e.undone_at) throw new UndoError('That decision was already undone.');
  const latest = await supa.from('sku_decision_log').select('id').eq('company_id', companyId).eq('target', e.target).eq('key', e.key).order('id', {ascending: false}).limit(1);
  if (latest.error) throw new Error(latest.error.message);
  if (Number(latest.data?.[0]?.id) !== Number(e.id)) throw new UndoError('Something newer was decided here since. Only the latest decision can be undone.');
  const current = await snapshot(companyId, e.target, e.key);
  if (driftedRows(e.after, current).length) throw new UndoError('This changed since the decision, so undoing it could overwrite later work. Use the normal actions instead.');

  const b = e.before;
  for (const [item, row] of Object.entries(b.products)) {
    const r = await supa.from('products').update(row).eq('company_id', companyId).eq('item_code', item);
    if (r.error) throw new Error(`undo product ${item}: ${r.error.message}`);
  }
  for (const [sku, row] of Object.entries(b.chain)) {
    const r = await supa.from('chain_skus').update(row).eq('company_id', companyId).eq('chain', CHAIN).eq('sku_code', sku);
    if (r.error) throw new Error(`undo suggestion ${sku}: ${r.error.message}`);
  }
  for (const [sku, row] of Object.entries(b.review)) {
    const r = row
      ? await supa.from('sku_link_reviews').upsert({company_id: companyId, chain: CHAIN, sku_code: sku, ...row}, {onConflict: 'company_id,chain,sku_code'})
      : await supa.from('sku_link_reviews').delete().eq('company_id', companyId).eq('chain', CHAIN).eq('sku_code', sku);
    if (r.error) throw new Error(`undo decision ${sku}: ${r.error.message}`);
  }
  for (const [item, row] of Object.entries(b.notes)) {
    const r = row
      ? await supa.from('item_notes').upsert({company_id: companyId, item_code: item, ...row}, {onConflict: 'company_id,item_code'})
      : await supa.from('item_notes').delete().eq('company_id', companyId).eq('item_code', item);
    if (r.error) throw new Error(`undo note ${item}: ${r.error.message}`);
  }
  const mark = await supa.from('sku_decision_log').update({undone_by: by, undone_at: new Date().toISOString()}).eq('company_id', companyId).eq('id', id);
  if (mark.error) throw new Error(`undo mark: ${mark.error.message}`);
  return {target: e.target, key: e.key};
}
