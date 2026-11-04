// Phase 4 — the per-SKU-per-store audit matrix (NICH-17). For a store and month, each
// SKU gets a yes/no (check / x) on two legs we actually have — present in the inventory
// form, and sold in Watsons — and the action that follows. The PO leg (the real source
// of truth) is not built yet, so it is left out; this is the inventory × Watsons subset
// of Justin's matrix. PURE (no network/DB) so it unit-tests; the reader builds the
// inputs in goldline-audit-data.ts.

/** The matrix cell state for one SKU in one store/month. */
export type AuditState =
  | 'matched' // in the form AND sold in Watsons — nothing to do
  | 'no_sales' // counted in the form, but Watsons recorded no sale — Watsons to audit
  | 'not_counted'; // sold in Watsons, but not in the form — flag for accounting

/** One SKU row of the matrix. */
export type AuditCell = {
  item_code: string;
  inForm: boolean;
  inWatsons: boolean;
  /** Units Watsons sold this month (0 when not sold). */
  units: number;
  /** Ending on hand from the form (null when not counted). */
  onHand: number | null;
  state: AuditState;
};

export type AuditInput = {
  item_code: string;
  inForm: boolean;
  inWatsons: boolean;
  units?: number | null;
  onHand?: number | null;
};

/**
 * The action label for a state — the plain-language "what to do", matching the
 * NICH-17 matrix (minus the PO rows, which need PO data):
 *   matched      → no action
 *   no_sales     → in the form but no Watsons sale: report to Watsons to audit
 *   not_counted  → sold in Watsons but not in the form: flag for accounting
 */
export const AUDIT_ACTION: Record<AuditState, string> = {
  matched: 'No action',
  no_sales: 'In the form, no Watsons sale. Report to Watsons to audit.',
  not_counted: 'Sold in Watsons, not in the form. Flag for accounting.',
};

/** Short status word for a cell (for a pill). */
export const AUDIT_LABEL: Record<AuditState, string> = {
  matched: 'Matched',
  no_sales: 'No sales',
  not_counted: 'Not counted',
};

/** Classify one SKU's two legs into a matrix state. */
export function auditState(inForm: boolean, inWatsons: boolean): AuditState {
  if (inForm && inWatsons) return 'matched';
  if (inForm && !inWatsons) return 'no_sales';
  return 'not_counted'; // !inForm && inWatsons (a row with neither leg is never emitted)
}

/**
 * Build the matrix rows for one store/month from per-SKU presence. Only SKUs that
 * appear in at least one leg are emitted (a SKU in neither has nothing to audit).
 * Rows are sorted mismatches-first (not_counted, then no_sales, then matched), then by
 * item code, so the rows that need attention read at the top.
 */
export function auditMatrix(inputs: AuditInput[]): AuditCell[] {
  const order: Record<AuditState, number> = {not_counted: 0, no_sales: 1, matched: 2};
  return inputs
    .filter((i) => i.inForm || i.inWatsons)
    .map((i) => ({
      item_code: i.item_code,
      inForm: i.inForm,
      inWatsons: i.inWatsons,
      units: Number(i.units ?? 0) || 0,
      onHand: i.onHand ?? null,
      state: auditState(i.inForm, i.inWatsons),
    }))
    .sort((a, b) => order[a.state] - order[b.state] || a.item_code.localeCompare(b.item_code));
}

/** Tally of the matrix states, for the header summary. */
export function auditSummary(cells: AuditCell[]): {matched: number; no_sales: number; not_counted: number; total: number} {
  const s = {matched: 0, no_sales: 0, not_counted: 0, total: cells.length};
  for (const c of cells) s[c.state]++;
  return s;
}
