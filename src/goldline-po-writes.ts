import 'server-only';
import {nichidoDb} from './nichido-client';

// Server-only writes for purchase orders (F12): make a run's POs (each approved line
// ships through record_shipment; the owner's decision on the Restock run is the only
// one), and the received section.
// Callers (app/stock/actions.ts) have already authorized the company, role and store
// scope; every function in p3d_purchase_orders.sql is still company- and store-fenced.

const db = nichidoDb;

export type PoErrorCode = 'run_not_found' | 'not_enough_stock' | 'over_qty' | 'bad_date' | 'line_not_found';

export class PoError extends Error {
  constructor(public code: PoErrorCode, public detail?: number) {
    super(code);
  }
}

const CODES: PoErrorCode[] = ['run_not_found', 'not_enough_stock', 'over_qty', 'bad_date', 'line_not_found'];

function toPoError(message: string | undefined): PoError | null {
  const m = message ?? '';
  const code = CODES.find((c) => m.includes(c));
  if (!code) return null;
  const n = code === 'not_enough_stock' ? Number(/not_enough_stock:(\d+)/.exec(m)?.[1]) : undefined;
  return new PoError(code, Number.isFinite(n) ? n : undefined);
}

/** Put a run's approved lines on each store's PO and ship them. */
export async function makePurchaseOrders(companyId: string, runId: string, scope: string[] | null, by: string | null, today: string): Promise<{pos: number; lines: number}> {
  const {data, error} = await db().rpc('make_purchase_orders', {p_company: companyId, p_run: runId, p_by: by, p_stores: scope, p_today: today});
  if (error) throw toPoError(error.message) ?? new Error(`make_purchase_orders failed: ${error.message}`);
  const out = (data ?? {}) as {pos?: number; lines?: number};
  return {pos: Number(out.pos) || 0, lines: Number(out.lines) || 0};
}

/** Save the received section: qty and date per line (qty null clears a receipt). */
export async function receivePoLines(
  companyId: string,
  scope: string[] | null,
  input: {lines: Array<{id: string; qty: number | null; date: string | null}>; by: string | null; today: string},
): Promise<number> {
  const {data, error} = await db().rpc('receive_po_lines', {p_company: companyId, p_lines: input.lines, p_by: input.by, p_stores: scope, p_today: input.today});
  if (error) throw toPoError(error.message) ?? new Error(`receive_po_lines failed: ${error.message}`);
  return Number(data) || 0;
}

/** Save the paper form's Module field. */
export async function setPoModule(companyId: string, id: string, module: string | null, by: string | null): Promise<void> {
  const {error} = await db().from('purchase_orders').update({module, updated_by: by, updated_at: new Date().toISOString()}).eq('company_id', companyId).eq('id', id);
  if (error) throw new Error(`purchase_orders update failed: ${error.message}`);
}
