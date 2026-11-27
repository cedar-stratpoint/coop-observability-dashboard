# Goldline inventory form templates (source of truth)

Version-faithful spreadsheets of the Goldline (Nichido) semi-monthly inventory form,
one file per **(form version, page)**: `INV_FORM_<VERSION>_PAGE<n>.xlsx`. Each one
mirrors the printed paper cell-for-cell so the OCR can pin every page to a fixed
layout and only read the handwritten numbers (no dropped or invented rows).

Transcribed from the reference scans in `public/form-versions/{legacy,v1,v2}-{1..5}.jpg`.

## Folders

- `Legacy/` — 5 pages, 10 columns (richest catalog; the original layout)
- `V1/` — 5 pages, 9 columns (Delivery is the 4th count column)
- `V2/` — 5 pages, 9 columns (Delivery is the 1st count column)
- `INDEX_all_form_templates.xlsx` — per-page section/item counts and count-column order

## Layout (matches the paper)

`ITEM # | PRODUCT | PRICE | <count columns, one empty cell each>`

- **Count columns** (version-specific, left to right):
  - Legacy: Beginning Inv (Stockroom) · Delivery (Drawer) · Beginning+Delivery (Selling) · Total PCS Deducted · Total Amount Deducted · Ending Inventory · Total Amount of Ending Inventory
  - V1: Stockroom · Drawer · Selling Area · Delivery · Ending Inventory · Total Amount of Ending Inventory
  - V2: Delivery · Stockroom · Drawer · Selling Area · Ending Inventory · Total Amount of Ending Inventory
- **Section band rows** carry the product family name + price; their count cells are the black bars (non-fillable on paper).
- **Item rows** leave the count cells empty for the handwriting.
- **Merged per-family total cells**: the "Total Amount of Ending Inventory" column (and, on Legacy, "Total Amount Deducted Inventory") merges into one cell across each family's rows. Accessories and Make-up Collection stay per-item (each has its own price).
- **Footer**: `PAGE # N` + `TOTAL` under the piece-count and peso-total columns.

## Rows printed on some copies only

Some prints of a page carry a row the reference copy does not. Mark such a row, and its
band, with `some copies` in a **PRINTED ON** column (column J, outside the paper's columns).
The generator emits it with `"optional": true`; the reader then reports it only when it is
printed, so a copy without it gets no row and a copy with it gets no "written in" flag.

- V1 page 5: `INDIVIDUAL FLARE` band (₱238) with `ELIF3125B · 3125 (black)`, O/S printed,
  between `ELF8058` and `ELISE FEATHER LITE LASHES`. Seen on stores 5300 and 296 (Oct 30
  scan p21, p32, p40; Nov 20 Part 1 p28); not on other V1 copies or any V2 copy.

## Why per-(version, page)

The versions share one catalog but **paginate differently** (e.g. Trulashes De Luxe is on
V1 page 4 but V2 page 5; Tinted Brow Gel / Clear Mascara / Length & Curl are on V1 page 3
but V2 page 4), and V2 trimmed some shade lists. A page-only template can't represent this,
which is why pages flagged real printed rows (like De Luxe) as "handwritten". These files
are the authoring source for the generated template data the reader uses at runtime.

## To verify against the paper

- `24/7 Stylo` code: Legacy prints `24/7SEPMM / 24/7SEPUM`, V2 prints `24/7SEPM / 24/7SEPU` (V1 built as `M/U`).
- `BB03B` is labelled "BB 03 Beige" on Legacy/V1 but "BB 04 Beige" on V2 (kept per version).
- Single-SKU products (e.g. `CMS091`, `HBP`, `FELA`) render as a 1-row family with a blank variant cell.
