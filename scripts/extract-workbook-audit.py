#!/usr/bin/env python3
"""Audit step only: dump every row of the Cedar Tree business plan (sheet 'Business Plan', C..S = Aug'26..Dec'27) as JSON:
{row, label, kind, cells:[{c, f (formula text or null), v (the workbook's cached value)}]}. kind = input (constants only), formula (formulas only),
mixed (both), label (no numbers). Cached values are what Excel last calculated; test/plan-workbook-equality.test.ts re-evaluates every formula from the inputs
and compares. Usage: python3 -I scripts/extract-workbook-audit.py "<workbook.xlsx>" <out.json>. The output holds plan figures: write it OUTSIDE the repo (the equality test uses a temp dir)."""
import json, sys, openpyxl
from openpyxl.utils import get_column_letter as L

src, out = sys.argv[1], sys.argv[2]
wf = openpyxl.load_workbook(src, data_only=False)['Business Plan']
wv = openpyxl.load_workbook(src, data_only=True)['Business Plan']
rows = []
for r in range(1, wf.max_row + 1):
    cells = []
    for c in range(3, 20):
        raw = wf.cell(r, c).value
        if raw is None:
            continue
        isf = isinstance(raw, str) and raw.startswith('=')
        cells.append({'c': L(c), 'f': raw if isf else None, 'v': wv.cell(r, c).value if isf else raw})
    if not cells:
        continue
    kinds = {'formula' if x['f'] else 'input' for x in cells}
    numeric = any(isinstance(x['v'], (int, float)) for x in cells)
    kind = 'label' if not numeric else (kinds.pop() if len(kinds) == 1 else 'mixed')
    rows.append({'row': r, 'label': (wf.cell(r, 2).value or '').strip(), 'kind': kind, 'cells': cells})
json.dump({'source': 'plan workbook', 'sheet': 'Business Plan', 'months': [wv.cell(4, c).value for c in range(3, 20)], 'rows': rows}, open(out, 'w'), ensure_ascii=False, indent=0)
print(len(rows), 'rows')
