// The per-SKU-per-store reconciliation matrix (NICH-17). PURE (no network/DB) so it
// unit-tests; the reader builds the inputs in goldline-audit-data.ts.
//
// Three legs, each a check or an x, from Justin's notebook matrix (Nov 23):
//   Watsons    sold at this store this month (Watsons POS Sales Data)
//   Inventory  on this store's inventory form this month WITH stock (on hand > 0; a
//              counted zero is an x, decided Nov 23)
//   PO         printed on the latest activated PO form (the source of truth: on the PO =
//              active, still delivered; not on it = inactive, being phased out)
//
// Eight rows, active (on the PO) first:
//   W I P
//   ✓ ✓ ✓  ok               no action
//   ✓ ✗ ✓  form_missing     Nichido updates the inventory form and confirms
//   ✗ ✓ ✓  no_sales         Watsons to audit and report
//   ✗ ✗ ✓  delivery_check   check the delivery reached the store (added Nov 23)
//   ✓ ✓ ✗  phasing_out      no action; selling through, track until it runs out
//   ✓ ✗ ✗  accounting       flag for accounting (Watsons paid for stock thought lost)
//   ✗ ✓ ✗  watsons_audit    report to Watsons for audit
//   ✗ ✗ ✗  retire_candidate flag for retirement (never auto-retire; history is kept)
//
// It flags; it never retires, deletes or changes a line. Audit only (the MVP).

export type AuditState =
  | 'ok'
  | 'form_missing'
  | 'no_sales'
  | 'delivery_check'
  | 'phasing_out'
  | 'accounting'
  | 'watsons_audit'
  | 'retire_candidate';

/** Display order: the active group first, then the inactive group (the notebook's order). */
export const AUDIT_STATES: AuditState[] = ['ok', 'form_missing', 'no_sales', 'delivery_check', 'phasing_out', 'accounting', 'watsons_audit', 'retire_candidate'];

/** States that need someone to do something (everything but the two "no action" rows). */
export const NEEDS_ACTION: ReadonlySet<AuditState> = new Set(['form_missing', 'no_sales', 'delivery_check', 'accounting', 'watsons_audit', 'retire_candidate']);

export type AuditMeta = {
  label: string;
  action: string;
  /** Who acts on it, for a compact chip. */
  owner: 'None' | 'Nichido' | 'Watsons' | 'Accounting' | 'Admin';
  tone: 'good' | 'warn' | 'crit' | 'neutral' | 'out';
  legs: {watsons: boolean; inventory: boolean; po: boolean};
};

export const AUDIT_META: Record<AuditState, AuditMeta> = {
  ok: {label: 'All good', action: 'No action.', owner: 'None', tone: 'good', legs: {watsons: true, inventory: true, po: true}},
  form_missing: {
    label: 'Not on the form',
    action: 'Selling and still delivered, but not on the inventory form. Nichido updates the form and confirms.',
    owner: 'Nichido',
    tone: 'warn',
    legs: {watsons: true, inventory: false, po: true},
  },
  no_sales: {
    label: 'No Watsons sales',
    action: 'On the form and still delivered, but Watsons recorded no sale. Watsons to audit and report.',
    owner: 'Watsons',
    tone: 'warn',
    legs: {watsons: false, inventory: true, po: true},
  },
  delivery_check: {
    label: 'Check delivery',
    action: 'On the PO, but not on the form and not selling. Check the delivery reached the store.',
    owner: 'Nichido',
    tone: 'crit',
    legs: {watsons: false, inventory: false, po: true},
  },
  phasing_out: {
    label: 'Phasing out',
    action: 'No action. Not on the PO but still selling. Keep tracking until it runs out.',
    owner: 'None',
    tone: 'neutral',
    legs: {watsons: true, inventory: true, po: false},
  },
  accounting: {
    label: 'For accounting',
    action: 'Not delivered and not on the form, but selling. Flag for accounting: Watsons paid for stock thought lost.',
    owner: 'Accounting',
    tone: 'crit',
    legs: {watsons: true, inventory: false, po: false},
  },
  watsons_audit: {
    label: 'Watsons audit',
    action: 'Not on the PO and no sales, but still on the form. Report to Watsons for audit.',
    owner: 'Watsons',
    tone: 'warn',
    legs: {watsons: false, inventory: true, po: false},
  },
  retire_candidate: {
    label: 'Retire candidate',
    action: 'Not on the PO, out of stock and not selling. Flag for retirement. Retiring keeps its history.',
    owner: 'Admin',
    tone: 'out',
    legs: {watsons: false, inventory: false, po: false},
  },
};

/** One SKU row of the matrix. */
export type AuditCell = {
  item_code: string;
  inWatsons: boolean;
  /** On the form with stock (on hand > 0). */
  inInventory: boolean;
  onPo: boolean;
  /** Units Watsons sold this month (0 when not sold). */
  units: number;
  /** Ending on hand from the form (null when the product isn't on this month's form). */
  onHand: number | null;
  /** The product is on this month's form at all (even with 0 or blank). */
  onForm: boolean;
  state: AuditState;
};

export type AuditInput = {
  item_code: string;
  units?: number | null;
  /** Ending on hand from this month's form; undefined = not on the form. */
  onHand?: number | null;
  onForm: boolean;
  onPo: boolean;
};

/** Classify one SKU's three legs into a matrix state. */
export function auditState(inWatsons: boolean, inInventory: boolean, onPo: boolean): AuditState {
  if (onPo) {
    if (inWatsons) return inInventory ? 'ok' : 'form_missing';
    return inInventory ? 'no_sales' : 'delivery_check';
  }
  if (inWatsons) return inInventory ? 'phasing_out' : 'accounting';
  return inInventory ? 'watsons_audit' : 'retire_candidate';
}

/**
 * Build the matrix rows for one store/month. Which SKUs get a row:
 *   • every product on the PO (an active product the store should carry), and
 *   • any product on this month's form or sold this month, on the PO or not.
 * So an inactive product with nothing anywhere (row 8) only shows when it's still printed
 * on the store's form (a counted zero or a blank): the "stock hit zero" signal. Rows sort
 * by the notebook order, then by item code.
 */
export function auditMatrix(inputs: AuditInput[]): AuditCell[] {
  const order = new Map(AUDIT_STATES.map((s, i) => [s, i]));
  return inputs
    .filter((i) => i.onPo || i.onForm || Number(i.units ?? 0) > 0)
    .map((i) => {
      const units = Number(i.units ?? 0) || 0;
      const onHand = i.onForm ? (i.onHand ?? null) : null;
      const inWatsons = units > 0;
      const inInventory = onHand != null && onHand > 0;
      return {item_code: i.item_code, inWatsons, inInventory, onPo: i.onPo, units, onHand, onForm: i.onForm, state: auditState(inWatsons, inInventory, i.onPo)};
    })
    .sort((a, b) => order.get(a.state)! - order.get(b.state)! || a.item_code.localeCompare(b.item_code));
}

export type AuditSummary = Record<AuditState, number> & {total: number; needsAction: number};

/** Tally of the matrix states, for the header summary. */
export function auditSummary(cells: Array<{state: AuditState}>): AuditSummary {
  const s = Object.fromEntries(AUDIT_STATES.map((k) => [k, 0])) as Record<AuditState, number>;
  let needsAction = 0;
  for (const c of cells) {
    s[c.state]++;
    if (NEEDS_ACTION.has(c.state)) needsAction++;
  }
  return {...s, total: cells.length, needsAction};
}

/** Per product across stores: how many stores fall in each state (the "By product" view). */
export type ProductRollup = {item_code: string; counts: Record<AuditState, number>; stores: number; needsAction: number; onPo: boolean};

export function productRollup(rows: Array<{item_code: string; state: AuditState; onPo: boolean}>): ProductRollup[] {
  const by = new Map<string, ProductRollup>();
  for (const r of rows) {
    let p = by.get(r.item_code);
    if (!p) {
      p = {item_code: r.item_code, counts: Object.fromEntries(AUDIT_STATES.map((k) => [k, 0])) as Record<AuditState, number>, stores: 0, needsAction: 0, onPo: r.onPo};
      by.set(r.item_code, p);
    }
    p.counts[r.state]++;
    p.stores++;
    if (NEEDS_ACTION.has(r.state)) p.needsAction++;
  }
  return [...by.values()].sort((a, b) => Number(b.onPo) - Number(a.onPo) || b.needsAction - a.needsAction || a.item_code.localeCompare(b.item_code));
}
