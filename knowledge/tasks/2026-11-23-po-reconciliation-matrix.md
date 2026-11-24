# PO × Inventory × Watsons reconciliation matrix (NICH-17, PO leg)

Status: **BUILT on staging** (2026-11-23, branch `feat/goldline-po-form-matrix`). Taska NICH-17. Source: Justin's notebook matrix (two photos, Nov 23) and Nichido's PO form sample (`reference/nichido/PO FILE PAGE 1-2 (1).xlsx`).

## Update after the sample arrived (Nov 23)

The sample is the **blank paper PURCHASE ORDER FORM**, the product list BAs order from. So the PO leg is **catalog-wide**: a product printed on the latest activated PO form is active. User decisions: no lookback window (latest form wins), counted zero = Inventory no, row 8 Watsons mark is an x, flags = whatever the task says (audit only). P0 and P1 below were replaced by: upload xlsx/pdf → draft → review (added/dropped/unmatched, toggle by hand) → activate. See CHANGELOG 2026-11-23 for what shipped. The original plan follows for history.

## Update (Nov 24): recommendations, all stores, third mark

See CHANGELOG 2026-11-24. Open: October POS Sales file (nothing can be recommended for October until it's in); link the remaining Watsons SKUs (17,064 units in September have no product link); confirm the last unmatched PO form line; Justin to confirm a blank is not zero.


## Goal

For every product, show three check/x legs (Watsons sold it · it's on the inventory form · it's on the PO) and the action that follows, so Justin sees at a glance which SKUs need someone to do something. The PO is the source of truth: on the PO = **active** (still delivered), not on the PO = **inactive** (being phased out).

## What exists today (staging)

- `/stock/audit` (commit 0121483, Nov 4): per store + month, two legs only (In form, In Watsons), 3 states (`matched`, `no_sales`, `not_counted`), "only mismatches" toggle, mock fallback. PO column was explicitly deferred.
- `src/goldline-audit.ts` (pure rules, 6 tests), `src/goldline-audit-data.ts` (reader), `components/analyst/audit-matrix.tsx` (UI).
- `purchase_orders` / `po_lines` exist, but they are **Coop's own outbound orders** made from the restock run (F12). They can't be the PO leg: restock already skips non-PO SKUs, so it would be circular. Staging has 2 test POs (10 lines, 1 store).
- Inventory counts on staging cover only 2 stores (test stores), so real coverage depends on the scan pipeline.

## The matrix (8 rows)

Decided Nov 23: show all combos, active group first.

| # | Group | Watsons | Inv | PO | State | What to do | Tone |
|---|---|---|---|---|---|---|---|
| 1 | Active | ✓ | ✓ | ✓ | `ok` | No action | good |
| 2 | Active | ✓ | ✗ | ✓ | `form_missing` | Sold and delivered, not on the form. Nichido updates the inventory form and confirms. | warn |
| 3 | Active | ✗ | ✓ | ✓ | `no_sales` | Counted and delivered, no Watsons sale. Watsons to audit and report. | warn |
| 4 | Active | ✗ | ✗ | ✓ | `delivery_check` | On the PO but not counted and not selling. Check the delivery reached the store. **(new, not in the agreed task matrix; user chose this Nov 23)** | crit |
| 5 | Inactive | ✓ | ✓ | ✗ | `phasing_out` | No action. Selling through; keep tracking until it runs out. | neutral |
| 6 | Inactive | ✓ | ✗ | ✗ | `accounting` | Not delivered, not counted, but selling. Flag for accounting (Watsons paid for stock thought lost). | crit |
| 7 | Inactive | ✗ | ✓ | ✗ | `watsons_audit` | Not delivered, counted, no sales. Report to Watsons for audit. | warn |
| 8 | Inactive | ✗ | ✗ | ✗ | `retire_candidate` | Nothing left anywhere. Flag for retirement (no auto-retire; Retire stays a manual action that greys the item and keeps history). | neutral |

Reading notes:
- Row 8 is cut off at the bottom of the second photo; read as Watsons ✗. Confirm with Justin.
- Row 8 is only emitted when the SKU **has history at that store** (a past count, sale or PO line). Otherwise every catalog SKU × every store would show up.
- "Inv ✓" today means "has a row on the form". For rows 5 and 8 the task rule is "stock hits zero and not in PO → retire". Proposal: Inv ✓ = on the form **with on hand > 0**; a counted zero is Inv ✗ and shows the zero in the On hand column. Needs a yes from the user, because it changes rows 1 to 3 too.

## Phases

### P0 · Get a real PO sample (blocker)
Need one xlsx and one pdf PO from Nichido. Without them the parser is a guess. Questions the sample answers:
- Whose PO: Watsons → Nichido (assumed) or Nichido's internal one?
- Per store or one consolidated PO to a DC with a store breakdown?
- Item codes: Nichido item code, Watsons SKU, or both? (Watsons SKU joins through the existing `products.sku_code` links.)
- Is the PDF digital (text layer) or a scan?

### P1 · PO ingest (handles repeat updates)
POs arrive from time to time, as xlsx or pdf.
- New tables (Nichido, additive, no clash with F12): `chain_po_uploads` (file, chain, uploaded_by, status) and `chain_po_lines` (upload_id, chain, po_no, po_date, store_code null-able, item_code, sku_code, qty). Unique on `(chain, po_no, store_code, item_code)`.
- **Updates:** a re-uploaded or revised PO with the same `po_no` replaces that PO's lines (upsert per PO number, previous version kept on the old upload for audit). A new PO adds lines. Uploads are idempotent, so dropping the same file twice is harmless.
- **"On the PO" rule:** a SKU is PO ✓ for a store when it appears on any PO dated within a lookback window (setting in `check_settings`, default 90 days, to confirm). If POs are consolidated (no store), PO ✓ applies to every store in the chain.
- xlsx: header-row detection + column map (reuse the Watsons POS xlsx import pattern). pdf: text layer first; scanned pdf falls back to the existing read pipeline (Sonnet, template-anchored) only if the samples show scans.
- Upload surface: a "PO" kind on the existing Uploads page, with a preview of matched / unmatched lines and a SKU-link step for unknown codes (reuse `sku_link_reviews`).

### P2 · Rules (pure, tested)
- Extend `goldline-audit.ts` to three legs and the 8 states above; keep it pure. One test per row, plus the row-8 history gate and the zero-on-hand rule.
- Sort: active mismatches first (4, 2, 3), then inactive flags (6, 7, 8), then 5 and 1.

### P3 · Views (both, decided Nov 23)
- **Per store** (`/stock/audit`): add the PO column, split the table into "Active (on PO)" and "Inactive (not on PO)" sections like the notebook, summary pills per state, "only needs action" toggle keeps 1 and 5 hidden.
- **Per product** (new, e.g. `/stock/audit/products`): one row per product with counts of stores in each of the 8 states, click a count to see those stores. This is the "per SKU across ~300 stores" view.
- Mock: browser-frame mockup in the plan artifact before building (house style).

```
Store 473 · Watsons SM San Pablo · Oct 2026          [only needs action ✓]

ACTIVE (on PO)          Watsons  Inv  PO   On hand  Sold  What to do
Diva X Lip 38006001        ✗      ✗   ✓      —       0   Check the delivery reached the store
Brow Pencil BP02           ✓      ✗   ✓      —      11   Nichido updates the form
Cheek Tint CT05            ✗      ✓   ✓     14       0   Watsons to audit

INACTIVE (not on PO)
Matte Lip ML08             ✓      ✗   ✗      —       4   Flag for accounting
Eyeliner EL03              ✗      ✓   ✗      7       0   Report to Watsons
Powder PW01                ✗      ✗   ✗      0       0   Retire candidate
```

### P4 · Downstream (task rules)
- Restock / PO generation: SKU not on the PO → no delivery recommendation (add a hold reason "not on PO" in F10 next to "retired").
- Retire candidates (row 8) link to the existing Retire product action; never auto-retire, never delete lines.
- Version discrepancies (v3/v4 form) are out of this plan; tracked separately.

### P5 · Ship
Staging first (Nichido-Supabase-Staging), verify with the real PO sample + the Oct scan, then promote the reviewed `.sql` to Nichido prod in one pass and tell Justin it's in Coop with the link (the task's "Next").

## Open questions
1. PO sample files (xlsx + pdf) and the answers in P0.
2. Lookback window for "on the PO" (90 days?).
3. Inv ✓ = counted with on hand > 0, or just "on the form"?
4. Row 8's Watsons mark (cut off in the photo).
5. Should rows 2, 3, 4, 6, 7 create entries in the existing `flags` table (so they show on Flags and hold restock), or stay audit-only for the MVP? Task says MVP is an audit, so default audit-only.
