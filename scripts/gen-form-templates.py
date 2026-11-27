#!/usr/bin/env python3
"""Generate src/goldline-form-templates.generated.ts from the version-faithful form
templates in docs/form-templates/{Legacy,V1,V2}/INV_FORM_*.xlsx.

The xlsx files are the human-authored source of truth for each (form version, page):
the printed row order, the family section each row sits under, and the printed price.
This emits that as a typed TS module the reader anchors to via getFormTemplate, so V1
and V2 use their own row lists (they paginate differently) instead of one shared,
page-only manifest.

Run from the repo root:  python3 scripts/gen-form-templates.py
Requires: openpyxl  (pip install openpyxl)
"""
import json
import os
import openpyxl

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "docs", "form-templates")
OUT = os.path.join(ROOT, "src", "goldline-form-templates.generated.ts")
VERSIONS = [("legacy", "Legacy"), ("v1", "V1"), ("v2", "V2")]


def parse(path):
    """Return the ordered items for one page: [{code, product, group, price[, optional]}].

    A row whose "PRINTED ON" cell (column J, outside the paper's columns) reads "some copies"
    is printed on some copies of the page only (QA Nov 27: some V1 page 5 prints carry an
    INDIVIDUAL FLARE band, most do not). It is emitted with "optional": true so the reader
    reports it only when it is printed.
    """
    ws = openpyxl.load_workbook(path, data_only=True).active
    items = []
    group = None
    group_price = None
    for row in ws.iter_rows(min_row=5):
        a = row[0].value  # ITEM #
        b = row[1].value  # PRODUCT
        c = row[2].value  # PRICE
        j = row[9].value if len(row) > 9 else None  # PRINTED ON
        if a:  # item row
            price = c if isinstance(c, (int, float)) else group_price
            item = {
                "code": str(a).strip(),
                "product": (str(b).strip() if b else (group or "")),
                "group": group,
                "price": price if isinstance(price, (int, float)) else None,
            }
            if isinstance(j, str) and j.strip().lower() == "some copies":
                item["optional"] = True
            items.append(item)
        elif b:  # band / footer
            if str(b).strip().upper().startswith("PAGE #"):
                continue  # footer TOTAL row
            group = str(b).strip()
            group_price = c if isinstance(c, (int, float)) else None
    return items


def main():
    data = {}
    for key, folder in VERSIONS:
        data[key] = {}
        for page in range(1, 6):
            path = os.path.join(SRC, folder, f"INV_FORM_{folder.upper()}_PAGE{page}.xlsx")
            data[key][page] = parse(path)

    lines = [
        "// GENERATED FILE — do not edit by hand.",
        "// Source: docs/form-templates/{Legacy,V1,V2}/INV_FORM_*.xlsx",
        "// Regenerate: python3 scripts/gen-form-templates.py",
        "//",
        "// Per-(form version, page) printed row list for the template-anchored read. The versions",
        "// share one catalog but paginate differently (e.g. Trulashes De Luxe is on V1 page 4 but",
        "// V2 page 5), so each version gets its own ordered rows — fixing the page-only manifest that",
        "// flagged real printed rows as handwritten. `group` is the printed family band, `price` the",
        "// printed family (or per-item, for accessories) price.",
        "",
        "import type {FormVersion} from './goldline-extract';",
        "",
        "export type GeneratedTemplateItem = {",
        "  code: string;",
        "  product: string;",
        "  group: string | null;",
        "  price: number | null;",
        "  /** Printed on some copies of this page only: the reader reports it only when printed. */",
        "  optional?: boolean;",
        "};",
        "",
        "type GeneratedVersion = Exclude<FormVersion, 'unknown'>;",
        "",
        "export const GENERATED_FORM_TEMPLATES: Record<GeneratedVersion, Record<number, GeneratedTemplateItem[]>> = {",
    ]
    for key, _ in VERSIONS:
        lines.append(f"  {key}: {{")
        for page in range(1, 6):
            arr = data[key][page]
            lines.append(f"    {page}: [")
            for it in arr:
                lines.append("      " + json.dumps(it, ensure_ascii=False) + ",")
            lines.append("    ],")
        lines.append("  },")
    lines += [
        "};",
        "",
        "/** The generated printed row list for a (version, page), or null when none exists",
        " *  (e.g. an unknown version, or a non-template page). */",
        "export function generatedTemplateItems(version: FormVersion, page: number): GeneratedTemplateItem[] | null {",
        "  if (version === 'unknown') return null;",
        "  const rows = GENERATED_FORM_TEMPLATES[version]?.[page];",
        "  return rows && rows.length ? rows : null;",
        "}",
        "",
    ]
    with open(OUT, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))

    total = sum(len(data[k][p]) for k, _ in VERSIONS for p in range(1, 6))
    print(f"wrote {OUT}")
    for key, _ in VERSIONS:
        counts = [len(data[key][p]) for p in range(1, 6)]
        print(f"  {key}: pages {counts} = {sum(counts)} items")
    print(f"  total {total} items")


if __name__ == "__main__":
    main()
