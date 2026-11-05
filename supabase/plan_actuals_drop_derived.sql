-- BHR derived rows: cash, CAC, active customers and inventory coverage were typed monthly lines. The workbook computes all four by formula
-- (rows 90, 96, 113, 84), so Coop now derives them and plan_set_actual rejects them (plan_report.sql). Re-apply plan_report.sql FIRST, then run this.
-- Deletes only the typed rows of those four metrics, nothing else. Idempotent: a second run deletes nothing.
-- Safe: BHR-03..05 never shipped (local and staging only), so no typed number of record is lost, and each is recomputed from the typed inputs.
-- plan_actuals_log keeps its history (the log has no foreign key to plan_actuals); a closed month keeps its close row and GMV snapshot untouched.
delete from plan_actuals where metric in ('cash', 'cac', 'customers', 'coverage');
