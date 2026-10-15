#!/usr/bin/env python3
"""Build the Goldline (NICHIDO) catalog from the blank inventory-form templates.

Usage:
  pdftotext -raw "page 1_ (1).pdf" out/p1.txt   # ... one per page, 1–5
  npx tsx -e "import {MANIFESTS} from './src/goldline-extract'; require('fs').writeFileSync('out/manifests.json', JSON.stringify(MANIFESTS))"
  python3 -I scripts/goldline/build-catalog.py out   # writes out/catalog.json

Each manifest item is matched to its template line (by item code, or by name for the
accessories that share a printed "ACCS ###" code), inherits the family heading above
it and that heading's printed price (an item's own printed price wins), and picks up
the "(Bestseller)" mark. Items printed with their own price under someone else's
heading are their own product line (except inside Accessories / Make-Up Collection).
Feed catalog.json into supabase/seed_goldline_catalog.sql (see that file's header).
"""
import json, re, sys
out = sys.argv[1]
man = json.load(open(f'{out}/manifests.json'))
STOP = re.compile(r'^(PAGE #|ITEM #|BILANG|Ending|Inventory|\(Stock|Hand\)|Total Amount|of Ending|SELLING|AREA|DELIVERY|Delivery|STOCKROOM|TEELCAB|EELCAB|DRAWER|NG$|MODULE|MM /|Beauty Consultant|Period Covered|NICHIDO COSMETICS|Semi - Monthly|_+|\d( \d)+$|NOTE|PRODUCT)', re.I)
PRICE = re.compile(r'\bP\s*([\d,]+\.\d{2})')
SMALL = {'and','of','with','to','in','w/','the'}
def title(s):
    s = re.sub(r'^NICHIDO\s+', '', s.strip(), flags=re.I)
    s = re.sub(r'\s*:\s*$', '', s)
    words = s.split()
    res = []
    for i,w in enumerate(words):
        lw = w.lower()
        if i and lw in SMALL: res.append(lw)
        elif w in ('BB', 'HD', 'TCC'): res.append(w)                                  # acronyms
        elif re.search(r'\d', w) and w.isupper() and len(w) < 5: res.append(w)    # 7X, 24/7
        else:
            t = w.lower()
            res.append(re.sub(r'(^|[(\-/+])([a-z])', lambda m: m.group(1)+m.group(2).upper(), t))
    return ' '.join(res)
def norm(s): return re.sub(r'[^a-z0-9]', '', s.lower())
rows, problems = [], []
for page in ['1','2','3','4','5']:
    lines = [l.strip() for l in open(f'{out}/p{page}.txt', encoding='utf-8') if l.strip()]
    used = set()
    for item in man[page]:
        code, prod = item['code'], item['product']
        hit = None
        for i,l in enumerate(lines):
            if i in used: continue
            first = l.split(' ')[0]
            if norm(first) == norm(code) or (l.upper().startswith('ACCS') and norm(prod)[:18] in norm(l)) or norm(l).startswith(norm(code)):
                hit = i; break
        if hit is None:
            problems.append((page, code, prod, 'no line')); continue
        used.add(hit)
        line = lines[hit]
        # family header = nearest earlier non-item, non-stop line
        fam, famprice = None, None
        for j in range(hit-1, -1, -1):
            l = lines[j]
            if STOP.match(l): continue
            fw = l.split(' ')[0]
            if any(norm(fw) == norm(m['code']) or norm(l).startswith(norm(m['code'])) for m in man[page]) or l.upper().startswith('ACCS'): continue
            fam = PRICE.sub('', l).strip(); m = PRICE.search(l); famprice = m.group(1) if m else None
            # a header that is only a continuation word (e.g. "NIACINAMIDE P 368.00") joins the line above
            if j>0 and len(fam.split())<=1 and not STOP.match(lines[j-1]):
                fam = PRICE.sub('', lines[j-1]).strip()+' '+fam
            break
        own = PRICE.search(line)
        price = (own.group(1) if own else famprice)
        # A standalone product prints its own full name in capitals with its own price
        # (e.g. "CELMS1 COLOR EYES LENGTHENING MASCARA P 188.00"): it is its own line.
        body = PRICE.sub('', line)
        body = re.sub(r'\s+O/S\s*$', '', body).strip()
        # strip the printed code (it may be split by spaces, e.g. "7X MSCR")
        toks, acc = body.split(' '), ''
        while toks and norm(code).startswith(acc + norm(toks[0])) and norm(toks[0]):
            acc += norm(toks.pop(0))
        body = ' '.join(toks).strip()
        letters = re.sub(r'[^A-Za-z]', '', body)
        mixed_bag = fam and re.sub(r'[^a-z]', '', fam.lower()) in ('accessories', 'makeupcollection')
        if own and len(body.split()) >= 2 and not line.upper().startswith('ACCS') and not mixed_bag and (
            letters.isupper() or (famprice and own.group(1) != famprice)
        ):
            # its own product: name up to any parenthetical / size note
            fam = re.split(r'\s*[(]|\s+\d+\s*ml\b', body, flags=re.I)[0].strip(' -')
        rows.append({
            'page': int(page), 'item_code': code, 'variant': prod,
            'product_line': title(fam) if fam else None,
            'unit_price': float(price.replace(',','')) if price else None,
            'is_bestseller': '(bestseller)' in line.lower(),
        })
json.dump(rows, open(f'{out}/catalog.json','w'), indent=1)
print('items', len(rows), 'problems', len(problems))
for p in problems: print('  PROBLEM', p)
print('no price:', [r['item_code'] for r in rows if r['unit_price'] is None])
print('no line :', [r['item_code'] for r in rows if not r['product_line']])
from collections import Counter
print('bestsellers', sum(r['is_bestseller'] for r in rows))
for (pg,pl),n in sorted(Counter((r['page'],r['product_line']) for r in rows).items()): print(pg, n, pl, {r['unit_price'] for r in rows if r['product_line']==pl and r['page']==pg})
