// The one definition of a completed order for Ask Coop, and it is the dashboard's: a sale counts unless its status is 'voided'
// (src/pos-sales.ts and src/pos-orders-read.ts map every other status, null included, to 'completed'; pos-sales-compute.ts excludes
// only voided). The pos_orders_completed view (supabase/coop_chat_default_views.sql) uses the same rule, null-safe:
// `status is distinct from 'voided'`. In practice status is only 'completed' or 'voided'.
export const isCompletedOrder = (o: {status: string | null}): boolean => o.status !== 'voided';
