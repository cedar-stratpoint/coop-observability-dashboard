import 'server-only';
import {unstable_cache} from 'next/cache';
import {nichidoConfigured, nichidoDb} from './nichido-client';
import {fetchAllRows} from './pos-fetch-paginate';
import {getGlCatalog, glTags} from './goldline-ref-data';
import {GOLDLINE_BUCKET} from './goldline-data';
import {itemDisplayName} from './goldline-item-name';
import {matchPoForm, poFormPhrases, type PoFormCell, type PoPhrase} from './goldline-po-form';

// The PO form (NICH-17, PO leg): reads and writes for po_forms / po_form_items on the
// Nichido project. The active form's item codes are "on the PO"; everything else in the
// catalog is inactive. See supabase/nichido/p4_po_form.sql for the rules.

export class PoFormError extends Error {}

export type PoFormStatus = 'draft' | 'active' | 'superseded';

export type PoFormRow = {
  id: string;
  file_name: string;
  file_kind: 'xlsx' | 'pdf';
  status: PoFormStatus;
  lines_read: number;
  unmatched: PoPhrase[];
  uploaded_by: string | null;
  uploaded_at: string;
  activated_by: string | null;
  activated_at: string | null;
};

export type PoFormItemRow = {item_code: string; source_text: string | null; score: number | null; by_hand: boolean};

/** The active form's id and item codes, or null when no form has been activated yet. */
export type ActivePoSet = {id: string; fileName: string; activatedAt: string | null; items: Set<string>};

const db = () => nichidoDb();
const FORM_COLS = 'id,file_name,file_kind,status,lines_read,unmatched,uploaded_by,uploaded_at,activated_by,activated_at';

/** The active PO form's product set (cached; tagged gl-po-form). Null = none activated. */
export async function getActivePoSet(companyId: string): Promise<ActivePoSet | null> {
  if (!nichidoConfigured()) return null;
  const raw = await unstable_cache(
    async () => {
      // pagination-ok: at most one active form per company (partial unique index).
      const {data: forms, error} = await db().from('po_forms').select('id,file_name,activated_at').eq('company_id', companyId).eq('status', 'active').limit(1);
      if (error) throw new Error(`po_forms read failed: ${error.message}`);
      const form = forms?.[0];
      if (!form) return null;
      const items = (await fetchAllRows('po_form_items', (from, to) =>
        db().from('po_form_items').select('item_code').eq('po_form_id', form.id).order('item_code').range(from, to),
      )) as unknown as Array<{item_code: string}>;
      return {id: form.id as string, fileName: form.file_name as string, activatedAt: (form.activated_at as string | null) ?? null, items: items.map((i) => i.item_code)};
    },
    ['gl-po-form-active', companyId],
    {tags: [glTags.poForm(companyId)], revalidate: 600},
  )();
  return raw ? {...raw, items: new Set(raw.items)} : null;
}

export async function listPoForms(companyId: string): Promise<PoFormRow[]> {
  // pagination-ok: PO forms are uploaded a few times a year; the 50 newest are plenty.
  const {data, error} = await db().from('po_forms').select(FORM_COLS).eq('company_id', companyId).order('uploaded_at', {ascending: false}).limit(50);
  if (error) throw new Error(`po_forms read failed: ${error.message}`);
  return (data ?? []) as unknown as PoFormRow[];
}

export async function poFormItems(formId: string): Promise<PoFormItemRow[]> {
  return (await fetchAllRows('po_form_items', (from, to) =>
    db().from('po_form_items').select('item_code,source_text,score,by_hand').eq('po_form_id', formId).order('item_code').range(from, to),
  )) as unknown as PoFormItemRow[];
}

/**
 * Read an uploaded PO form into a draft: phrases → catalog matches → po_forms (draft) +
 * po_form_items. The original file is kept in the uploads bucket. Returns the draft id.
 */
export async function createPoFormDraft(
  companyId: string,
  input: {fileName: string; kind: 'xlsx' | 'pdf'; bytes: Uint8Array; contentType: string; cells: PoFormCell[]; by: string | null},
): Promise<{id: string; matched: number; unmatched: number}> {
  const catalog = await getGlCatalog(companyId);
  if (!catalog.length) throw new PoFormError('The product catalog is empty, so nothing can be matched yet.');
  const phrases = poFormPhrases(input.cells);
  if (phrases.length < 5) throw new PoFormError('Hardly any product lines were found. Is this the PO form?');
  const result = matchPoForm(phrases, catalog.map((p) => ({item_code: p.item_code, product_line: p.product_line, variant: p.variant})));

  const unmatched = result.unmatched.slice(0, 300).map((u) => ({heading: u.heading, shade: u.shade, text: u.text.slice(0, 300), page: u.page}));
  const {data: form, error} = await db()
    .from('po_forms')
    .insert({company_id: companyId, file_name: input.fileName.slice(0, 200), file_kind: input.kind, status: 'draft', lines_read: phrases.length, unmatched, uploaded_by: input.by})
    .select('id')
    .single();
  if (error || !form) throw new Error(`po_forms insert failed: ${error?.message}`);
  const id = form.id as string;

  const rows = result.matches.map((m) => ({po_form_id: id, company_id: companyId, item_code: m.item_code, source_text: m.phrase.text.slice(0, 300), score: m.score, by_hand: false}));
  for (let i = 0; i < rows.length; i += 500) {
    const {error: e} = await db().from('po_form_items').insert(rows.slice(i, i + 500));
    if (e) throw new Error(`po_form_items insert failed: ${e.message}`);
  }

  // Keep the original file (best effort: the read already succeeded).
  const safe = input.fileName.replace(/[^\w.\- ]+/g, '_').slice(0, 120);
  const path = `${companyId}/po-forms/${id}/${safe}`;
  const up = await db().storage.from(GOLDLINE_BUCKET).upload(path, input.bytes, {contentType: input.contentType, upsert: true});
  if (!up.error) await db().from('po_forms').update({storage_path: path}).eq('id', id);
  else console.warn('po form file not stored', up.error.message);

  return {id, matched: rows.length, unmatched: unmatched.length};
}

async function formOf(companyId: string, formId: string): Promise<{status: PoFormStatus}> {
  // pagination-ok: one row by primary key.
  const {data, error} = await db().from('po_forms').select('status').eq('company_id', companyId).eq('id', formId).maybeSingle();
  if (error) throw new Error(`po_forms read failed: ${error.message}`);
  if (!data) throw new PoFormError('That PO form was not found.');
  return data as {status: PoFormStatus};
}

/** Put a product on, or take it off, a draft or the active form (by hand). */
export async function setPoFormItem(companyId: string, formId: string, item: string, on: boolean): Promise<void> {
  const f = await formOf(companyId, formId);
  if (f.status === 'superseded') throw new PoFormError('An older PO form can’t be changed.');
  if (on) {
    const {error} = await db()
      .from('po_form_items')
      .upsert({po_form_id: formId, company_id: companyId, item_code: item, source_text: null, score: null, by_hand: true}, {onConflict: 'po_form_id,item_code', ignoreDuplicates: true});
    if (error) throw new Error(`po_form_items upsert failed: ${error.message}`);
  } else {
    const {error} = await db().from('po_form_items').delete().eq('po_form_id', formId).eq('item_code', item);
    if (error) throw new Error(`po_form_items delete failed: ${error.message}`);
  }
}

export async function activatePoForm(companyId: string, formId: string, by: string | null): Promise<void> {
  const {error} = await db().rpc('activate_po_form', {p_company: companyId, p_form: formId, p_by: by});
  if (error) {
    if (/po_form_not_found/.test(error.message)) throw new PoFormError('That PO form was not found.');
    if (/po_form_superseded/.test(error.message)) throw new PoFormError('A newer PO form already replaced this one.');
    throw new Error(`activate_po_form failed: ${error.message}`);
  }
}

/** Throw away a draft that was never activated. */
export async function discardPoFormDraft(companyId: string, formId: string): Promise<void> {
  const f = await formOf(companyId, formId);
  if (f.status !== 'draft') throw new PoFormError('Only a draft can be discarded.');
  const {error} = await db().from('po_forms').delete().eq('company_id', companyId).eq('id', formId);
  if (error) throw new Error(`po_forms delete failed: ${error.message}`);
}

/** The variant minus its leading words that repeat the product line. */
export function shadeOf(line: string | null, variant: string | null): string {
  const lineWords = new Set((line ?? '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean));
  const words = (variant ?? '').trim().split(/\s+/).filter(Boolean);
  let k = 0;
  while (k < words.length - 1 && lineWords.has(words[k].toLowerCase().replace(/[^a-z0-9]/g, ''))) k++;
  return words.slice(k).join(' ');
}

// ── The page's view model ────────────────────────────────────────────────────────────

export type PoFormProduct = {
  item_code: string;
  name: string;
  /** The variant without the product line's own words ("Midnight Matte"), for a row under its line. */
  shade: string;
  line: string;
  onForm: boolean;
  /** On the currently active form (to show what a draft would change). */
  onActive: boolean;
  source: string | null;
  byHand: boolean;
  retired: boolean;
};

export type PoFormView = {
  configured: boolean;
  forms: PoFormRow[];
  /** The form being shown: the requested draft, else the active one, else the newest. */
  current: PoFormRow | null;
  active: PoFormRow | null;
  products: PoFormProduct[];
  /** Draft vs active: products the draft adds and drops. */
  diff: {added: number; dropped: number} | null;
};

export async function poFormView(companyId: string, formId: string | null): Promise<PoFormView> {
  if (!nichidoConfigured()) return {configured: false, forms: [], current: null, active: null, products: [], diff: null};
  const [forms, catalog] = await Promise.all([listPoForms(companyId), getGlCatalog(companyId)]);
  const active = forms.find((f) => f.status === 'active') ?? null;
  const current = (formId && forms.find((f) => f.id === formId)) || active || forms[0] || null;
  const [items, activeItems] = await Promise.all([
    current ? poFormItems(current.id) : Promise.resolve([]),
    active && current && active.id !== current.id ? poFormItems(active.id) : Promise.resolve(null),
  ]);
  const byItem = new Map(items.map((i) => [i.item_code, i]));
  const activeSet = new Set((activeItems ?? (active && current?.id === active.id ? items : [])).map((i) => i.item_code));
  const products: PoFormProduct[] = catalog
    .filter((p) => !p.hidden)
    .map((p) => {
      const it = byItem.get(p.item_code);
      return {
        item_code: p.item_code,
        name: itemDisplayName(p.product_line, p.variant, p.item_code),
        shade: shadeOf(p.product_line, p.variant) || p.item_code,
        line: p.product_line ?? 'Other',
        onForm: Boolean(it),
        onActive: activeSet.has(p.item_code),
        source: it?.source_text ?? null,
        byHand: Boolean(it?.by_hand),
        retired: Boolean(p.retired_at),
      };
    });
  const diff =
    current && current.status === 'draft' && active
      ? {added: products.filter((p) => p.onForm && !p.onActive).length, dropped: products.filter((p) => !p.onForm && p.onActive).length}
      : null;
  return {configured: true, forms, current, active, products, diff};
}
