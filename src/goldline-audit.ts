// The per-SKU-per-store reconciliation matrix (NICH-17). PURE (no network/DB) so it
// unit-tests; the reader builds the inputs in goldline-audit-data.ts.
//
// Three legs from Justin's notebook matrix (Nov 23), each YES, NO or UNKNOWN (Nov 24):
//   Watsons    sold at this store this month (net units > 0, Watsons POS Sales Data)
//   Inventory  counted on this store's form this month with stock (on hand > 0): the written
//              ending, else stockroom + drawer + selling area (onHandOf, the app's one rule).
//              A counted zero is a no; a row with nothing written is unknown.
//   PO         printed on the latest activated PO form (on it = active; not = phasing out)
//
// Unknown is never shown as a no: a month whose sales aren't loaded, a product with no
// Watsons SKU link, a store with no count, a page not uploaded. Any unknown leg means the
// row reads "Can't tell yet" with the reason, and no recommendation is made.
//
//   W I P   state             recommendation
//   ✓ ✓ ✓   ok                Keep
//   ✓ ✗ ✓   form_missing      Add to form           (Restock when it was counted zero)
//   ✗ ✓ ✓   no_sales          Watsons to audit
//   ✗ ✗ ✓   delivery_check    Check delivery
//   ✓ ✓ ✗   phasing_out       Retire, sell through  (Nov 24, was "no action")
//   ✓ ✗ ✗   accounting        Send to accounting    (Flag to retire when counted zero: it sold out)
//   ✗ ✓ ✗   watsons_audit     Report to Watsons
//   ✗ ✗ ✗   retire_candidate  Flag to retire
//
// It recommends; it never retires, deletes or changes a line.

/** The Store picker's every-store choice, and its page size (the server pages it). */
export const ALL_STORES = 'all';
export const ALL_PAGE = 25;

export type Leg = 'yes' | 'no' | 'unknown';

export type WhyUnknown = 'month_not_loaded' | 'store_not_in_file' | 'not_linked' | 'no_count' | 'page_missing' | 'blank' | 'no_po_form';

export const WHY_LABEL: Record<WhyUnknown, string> = {
  month_not_loaded: 'Watsons sales not loaded for this month',
  store_not_in_file: 'Store not in this month’s Watsons file',
  not_linked: 'No Watsons SKU linked',
  no_count: 'Store has no count this month',
  page_missing: 'Form page not uploaded',
  blank: 'Blank on the form',
  no_po_form: 'No PO form in use',
};

export type MatrixState =
  | 'ok'
  | 'form_missing'
  | 'no_sales'
  | 'delivery_check'
  | 'phasing_out'
  | 'accounting'
  | 'watsons_audit'
  | 'retire_candidate';
export type AuditState = MatrixState | 'unknown';

/** Notebook order: the active group first, then the inactive group. */
export const MATRIX_STATES: MatrixState[] = ['ok', 'form_missing', 'no_sales', 'delivery_check', 'phasing_out', 'accounting', 'watsons_audit', 'retire_candidate'];
/** Every state a row can be in; "Can't tell yet" last. */
export const AUDIT_STATES: AuditState[] = [...MATRIX_STATES, 'unknown'];
export const isAuditState = (s: unknown): s is AuditState => AUDIT_STATES.includes(s as AuditState);

/** States that ask someone to do something. "Can't tell yet" is missing data, not a step. */
export const NEEDS_ACTION: ReadonlySet<AuditState> = new Set<AuditState>(['form_missing', 'no_sales', 'delivery_check', 'phasing_out', 'accounting', 'watsons_audit', 'retire_candidate']);

export type AuditMeta = {
  /** The recommendation, and the state's name everywhere. */
  label: string;
  action: string;
  owner: 'None' | 'Nichido' | 'Watsons' | 'Accounting' | 'Admin';
  tone: 'good' | 'warn' | 'crit' | 'neutral' | 'out' | 'unknown';
  legs: {watsons: Leg; inventory: Leg; po: Leg};
};

const L = (watsons: Leg, inventory: Leg, po: Leg) => ({watsons, inventory, po});

export const AUDIT_META: Record<AuditState, AuditMeta> = {
  ok: {label: 'Keep', action: 'Selling, counted and still delivered. Nothing to do.', owner: 'None', tone: 'good', legs: L('yes', 'yes', 'yes')},
  form_missing: {
    label: 'Add to form',
    action: 'Selling and still delivered, but not in the store’s count. Nichido updates the inventory form and confirms.',
    owner: 'Nichido',
    tone: 'warn',
    legs: L('yes', 'no', 'yes'),
  },
  no_sales: {
    label: 'Watsons to audit',
    action: 'Counted and still delivered, but Watsons recorded no sale. Watsons audits and reports.',
    owner: 'Watsons',
    tone: 'warn',
    legs: L('no', 'yes', 'yes'),
  },
  delivery_check: {
    label: 'Check delivery',
    action: 'On the PO form, but no stock counted and no sale. Check the delivery reached the store.',
    owner: 'Nichido',
    tone: 'crit',
    legs: L('no', 'no', 'yes'),
  },
  phasing_out: {
    label: 'Retire, sell through',
    action: 'Not on the PO form, still in stock and selling. Stop ordering and sell what is left. An admin retires it once stock is zero at every store.',
    owner: 'Nichido',
    tone: 'neutral',
    legs: L('yes', 'yes', 'no'),
  },
  accounting: {
    label: 'Send to accounting',
    action: 'Not on the PO form and not in the store’s count, but selling. Watsons paid for stock thought lost.',
    owner: 'Accounting',
    tone: 'crit',
    legs: L('yes', 'no', 'no'),
  },
  watsons_audit: {
    label: 'Report to Watsons',
    action: 'Not on the PO form and no sale, but still counted at the store. Report to Watsons for audit.',
    owner: 'Watsons',
    tone: 'warn',
    legs: L('no', 'yes', 'no'),
  },
  retire_candidate: {
    label: 'Flag to retire',
    action: 'Not on the PO form, counted zero and no sale. Retiring is an admin’s step and keeps its history.',
    owner: 'Admin',
    tone: 'out',
    legs: L('no', 'no', 'no'),
  },
  unknown: {
    label: 'Can’t tell yet',
    action: 'A mark is missing its data, so there is no recommendation. Each line says what is missing.',
    owner: 'None',
    tone: 'unknown',
    legs: L('unknown', 'unknown', 'unknown'),
  },
};

export type AuditCell = {
  item_code: string;
  watsons: Leg;
  inventory: Leg;
  po: Leg;
  /** Why any leg is unknown (empty when the row has a recommendation). */
  why: WhyUnknown[];
  /** Net units Watsons sold this month (null when unknown). */
  units: number | null;
  /** Ending on hand from the form (null when blank, not counted or not on it). */
  onHand: number | null;
  /** The product has a row on this month's form (even 0 or blank). */
  onForm: boolean;
  state: AuditState;
  /** This line's recommendation (the state's label, refined for a counted zero). */
  reco: string;
  /** For "Can't tell yet": the two recommendations it is between, when only one mark is missing. */
  between: string[];
};

export type AuditInput = {
  item_code: string;
  /** Net units, or why they aren't known. */
  watsons: number | WhyUnknown;
  /** On hand: a number, or why it isn't known. `absent` = not printed on this store's form. */
  inventory: number | 'absent' | WhyUnknown;
  po: boolean | 'no_po_form';
  onForm: boolean;
  /** Already retired in Coop: nothing left to flag once it is out of stock. */
  retired?: boolean;
};

/** Classify one SKU's three legs. Any unknown leg = "Can't tell yet". */
export function auditState(watsons: Leg, inventory: Leg, po: Leg): AuditState {
  if (watsons === 'unknown' || inventory === 'unknown' || po === 'unknown') return 'unknown';
  const w = watsons === 'yes';
  const i = inventory === 'yes';
  if (po === 'yes') return w ? (i ? 'ok' : 'form_missing') : i ? 'no_sales' : 'delivery_check';
  return w ? (i ? 'phasing_out' : 'accounting') : i ? 'watsons_audit' : 'retire_candidate';
}

/** The line's recommendation. A counted zero that sold is sold out, not missing from the form. */
function recommend(state: AuditState, countedZero: boolean): string {
  if (countedZero && state === 'form_missing') return 'Restock';
  if (countedZero && state === 'accounting') return AUDIT_META.retire_candidate.label;
  return AUDIT_META[state].label;
}

/** Why a refined recommendation differs from its state's usual step. */
export function recoAction(c: Pick<AuditCell, 'state' | 'reco'>): string {
  if (c.state === 'form_missing' && c.reco === 'Restock') return 'Selling and still delivered, but counted zero. It sold out, so restock it.';
  if (c.state === 'accounting' && c.reco === AUDIT_META.retire_candidate.label) return 'Not on the PO form and counted zero after selling: it has sold through.';
  return AUDIT_META[c.state].action;
}

/** Build one row, or null when there is nothing to say about this product at this store. */
export function auditCell(i: AuditInput): AuditCell | null {
  const why: WhyUnknown[] = [];
  let watsons: Leg;
  if (typeof i.watsons === 'number') watsons = i.watsons > 0 ? 'yes' : 'no';
  else {
    watsons = 'unknown';
    why.push(i.watsons);
  }
  let inventory: Leg;
  if (typeof i.inventory === 'number') inventory = i.inventory > 0 ? 'yes' : 'no';
  else if (i.inventory === 'absent') inventory = 'no';
  else {
    inventory = 'unknown';
    why.push(i.inventory);
  }
  let po: Leg;
  if (i.po === 'no_po_form') {
    po = 'unknown';
    why.push('no_po_form');
  } else po = i.po ? 'yes' : 'no';

  // Nothing anywhere and not on the store's form: no row.
  if (po === 'no' && watsons !== 'yes' && !i.onForm && (inventory === 'no' || i.inventory === 'no_count')) return null;
  // A store with no count has nothing to reconcile except what it sold.
  if (i.inventory === 'no_count' && watsons !== 'yes') return null;
  const state = auditState(watsons, inventory, po);
  if (state === 'retire_candidate' && i.retired) return null;

  const onHand = typeof i.inventory === 'number' ? i.inventory : null;
  const between: string[] = [];
  if (state === 'unknown' && why.length === 1) {
    const at = (v: Leg) =>
      auditState(watsons === 'unknown' ? v : watsons, inventory === 'unknown' ? v : inventory, po === 'unknown' ? v : po);
    between.push(AUDIT_META[at('yes')].label, AUDIT_META[at('no')].label);
  }
  return {
    item_code: i.item_code,
    watsons,
    inventory,
    po,
    why,
    units: typeof i.watsons === 'number' ? i.watsons : null,
    onHand,
    onForm: i.onForm,
    state,
    reco: recommend(state, onHand != null && onHand <= 0),
    between,
  };
}

export const WHY_ORDER: WhyUnknown[] = ['month_not_loaded', 'store_not_in_file', 'no_count', 'page_missing', 'blank', 'not_linked', 'no_po_form'];

/** `why`: how many "Can't tell yet" lines miss each kind of data (a line can miss two). */
export type AuditSummary = Record<AuditState, number> & {total: number; needsAction: number; why: Record<WhyUnknown, number>};

/** Tally of the states and of what the unknown lines are missing, for the grid. */
export function auditSummary(cells: Array<{state: AuditState; why?: WhyUnknown[]}>): AuditSummary {
  const s = Object.fromEntries(AUDIT_STATES.map((k) => [k, 0])) as Record<AuditState, number>;
  const why = Object.fromEntries(WHY_ORDER.map((k) => [k, 0])) as Record<WhyUnknown, number>;
  let needsAction = 0;
  for (const c of cells) {
    s[c.state]++;
    if (NEEDS_ACTION.has(c.state)) needsAction++;
    if (c.state === 'unknown') for (const w of c.why ?? []) why[w]++;
  }
  return {...s, total: cells.length, needsAction, why};
}

const TONE_RANK: Record<AuditMeta['tone'], number> = {crit: 0, warn: 1, neutral: 2, out: 3, good: 4, unknown: 5};

/** The states that need a step and have rows, most urgent first (the primary tiles). */
export function rankedSteps(summary: Record<AuditState, number>): AuditState[] {
  return AUDIT_STATES.filter((s) => NEEDS_ACTION.has(s) && summary[s] > 0).sort(
    (a, b) => TONE_RANK[AUDIT_META[a].tone] - TONE_RANK[AUDIT_META[b].tone] || summary[b] - summary[a],
  );
}

/** The state a page opens on: the most urgent step, else what is still missing data. */
export const openingState = (summary: Record<AuditState, number>): AuditState => rankedSteps(summary)[0] ?? (summary.unknown > 0 ? 'unknown' : 'ok');

// ── Searching, sorting and paging the rows (shared by the browser and the server) ────

export type AuditSort = 'reco' | 'product' | 'store' | 'units' | 'onHand';
export const AUDIT_SORTS: AuditSort[] = ['reco', 'product', 'store', 'units', 'onHand'];
/** `why`: with state "Can't tell yet", only the lines missing this kind of data. */
export type AuditQuery = {state: AuditState; why: WhyUnknown | null; q: string; sort: AuditSort; dir: 'asc' | 'desc'; page: number};
export const isWhy = (s: unknown): s is WhyUnknown => WHY_ORDER.includes(s as WhyUnknown);

/** "YYX", "yx?", "✓✓✗" → a Watsons · Inventory · PO pattern. X or N is no; ? is unknown. */
export function parsePattern(q: string): {watsons: Leg; inventory: Leg; po: Leg} | null {
  const t = q.trim().replace(/[\s·,-]+/g, '');
  const ch = [...t];
  if (ch.length !== 3) return null;
  const legs = ch.map((c): Leg | null => (/[y✓]/i.test(c) ? 'yes' : /[xn✗]/i.test(c) ? 'no' : c === '?' ? 'unknown' : null));
  if (legs.some((l) => l == null)) return null;
  return {watsons: legs[0]!, inventory: legs[1]!, po: legs[2]!};
}

/** A pattern with no ? is one of the eight states, so the page can just select its tile. */
export function patternState(q: string): MatrixState | null {
  const p = parsePattern(q);
  if (!p) return null;
  const s = auditState(p.watsons, p.inventory, p.po);
  return s === 'unknown' ? null : s;
}

export type SearchableRow = AuditCell & {product: string | null; store: string; storeName: string | null};

const ORDER = new Map(AUDIT_STATES.map((s, i) => [s, i]));

/** The rows a query shows, in order (every page; slice for one). Nulls always sort last. */
export function auditRows<T extends SearchableRow>(rows: T[], query: Pick<AuditQuery, 'state' | 'q' | 'sort' | 'dir'> & {why?: WhyUnknown | null}): T[] {
  const needle = query.q.trim().toLowerCase();
  const p = needle ? parsePattern(needle) : null;
  const hit = (r: T) =>
    p
      ? r.watsons === p.watsons && r.inventory === p.inventory && r.po === p.po
      : needle
        ? r.item_code.toLowerCase().includes(needle) || (r.product ?? '').toLowerCase().includes(needle) || (r.storeName ?? '').toLowerCase().includes(needle) || r.store.toLowerCase() === needle
        : r.state === query.state && (query.state !== 'unknown' || !query.why || r.why.includes(query.why));
  const sign = query.dir === 'desc' ? -1 : 1;
  const name = (r: T) => (r.product ?? r.item_code).toLowerCase();
  const num = (a: number | null, b: number | null) => (a == null ? (b == null ? 0 : 1) : b == null ? -1 : sign * (a - b));
  const text = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return rows.filter(hit).sort((a, b) => {
    let d = 0;
    if (query.sort === 'units') d = num(a.units, b.units);
    else if (query.sort === 'onHand') d = num(a.onHand, b.onHand);
    else if (query.sort === 'product') d = sign * text(name(a), name(b));
    else if (query.sort === 'store') d = sign * a.store.localeCompare(b.store, undefined, {numeric: true});
    else d = sign * (ORDER.get(a.state)! - ORDER.get(b.state)! || text(a.reco, b.reco));
    return d || text(name(a), name(b)) || a.store.localeCompare(b.store, undefined, {numeric: true});
  });
}

// ── Per product across stores (the "By product" view) ────────────────────────────────

export type ProductRollup = {item_code: string; counts: Record<AuditState, number>; stores: number; needsAction: number; po: Leg};

export function productRollup(rows: Array<{item_code: string; state: AuditState; po: Leg}>): ProductRollup[] {
  const by = new Map<string, ProductRollup>();
  for (const r of rows) {
    let p = by.get(r.item_code);
    if (!p) {
      p = {item_code: r.item_code, counts: Object.fromEntries(AUDIT_STATES.map((k) => [k, 0])) as Record<AuditState, number>, stores: 0, needsAction: 0, po: r.po};
      by.set(r.item_code, p);
    }
    p.counts[r.state]++;
    p.stores++;
    if (NEEDS_ACTION.has(r.state)) p.needsAction++;
  }
  return [...by.values()].sort((a, b) => b.needsAction - a.needsAction || b.stores - a.stores || a.item_code.localeCompare(b.item_code));
}
