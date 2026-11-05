// A tiny evaluator for the workbook's formulas (audit use only): + - * / unary minus, %, comparisons, strings, cell refs and ranges, SUM, MAX, AVERAGE, MROUND, IF.
// Enough to recompute the Cedar Tree business plan from its INPUT cells, so a test can prove the formulas are internally consistent.
export type Cell = {c: string; f: string | null; v: number | string | null};
export type AuditRow = {row: number; label: string; kind: 'input' | 'formula' | 'mixed' | 'label'; cells: Cell[]};
export type Audit = {source: string; sheet: string; months: string[]; rows: AuditRow[]};
type Val = number | string;

const colNum = (c: string) => [...c].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
const colName = (n: number) => { let s = ''; for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };

export function makeEvaluator(audit: Audit) {
  const cells = new Map<string, Cell>();
  for (const r of audit.rows) for (const c of r.cells) cells.set(`${c.c}${r.row}`, c);
  const memo = new Map<string, Val>();
  const stack = new Set<string>();

  function cellValue(ref: string): Val {
    if (memo.has(ref)) return memo.get(ref) as Val;
    const c = cells.get(ref);
    if (!c) return 0; // an empty cell reads as 0, as in Excel
    if (!c.f) return (c.v ?? 0) as Val;
    if (stack.has(ref)) throw new Error(`circular reference at ${ref}`);
    stack.add(ref);
    const v = evalFormula(c.f.slice(1));
    stack.delete(ref);
    memo.set(ref, v);
    return v;
  }

  function evalFormula(src: string): Val {
    let p = 0;
    const ws = () => { while (src[p] === ' ') p++; };
    const peek = (s: string) => { ws(); return src.startsWith(s, p); };
    const take = (s: string) => { if (peek(s)) { p += s.length; return true; } return false; };
    const num = (v: Val): number => (typeof v === 'number' ? v : Number.NaN);

    function expr(): Val { return cmp(); }
    function cmp(): Val {
      let a = add();
      for (;;) {
        const op = ['>=', '<=', '<>', '>', '<', '='].find((o) => peek(o));
        if (!op) return a;
        p += op.length;
        const b = add();
        const x = num(a), y = num(b);
        a = (op === '>=' ? x >= y : op === '<=' ? x <= y : op === '>' ? x > y : op === '<' ? x < y : op === '=' ? a === b : a !== b) ? 1 : 0;
      }
    }
    function add(): Val {
      let a = mul();
      for (;;) {
        if (take('+')) a = num(a) + num(mul());
        else if (peek('-')) { p++; a = num(a) - num(mul()); }
        else return a;
      }
    }
    function mul(): Val {
      let a = unary();
      for (;;) {
        if (take('*')) a = num(a) * num(unary());
        else if (take('/')) a = num(a) / num(unary());
        else return a;
      }
    }
    function unary(): Val {
      if (take('-')) return -num(unary());
      if (take('+')) return unary();
      let v = atom();
      while (take('%')) v = num(v) / 100;
      return v;
    }
    function args(): Val[][] { // each argument as a flat list (a range expands)
      const out: Val[][] = [];
      if (take(')')) return out;
      do { ws(); out.push(argument()); } while (take(','));
      if (!take(')')) throw new Error(`expected ) in ${src}`);
      return out;
    }
    function argument(): Val[] {
      const m = /^\$?([A-Z]{1,2})\$?(\d+):\$?([A-Z]{1,2})\$?(\d+)/.exec(src.slice(p));
      if (m) {
        p += m[0].length;
        const vals: Val[] = [];
        for (let r = +m[2]; r <= +m[4]; r++) for (let c = colNum(m[1]); c <= colNum(m[3]); c++) vals.push(cellValue(`${colName(c)}${r}`));
        return vals;
      }
      return [expr()];
    }
    function atom(): Val {
      ws();
      if (take('(')) { const v = expr(); if (!take(')')) throw new Error(`expected ) in ${src}`); return v; }
      if (src[p] === '"') { const e = src.indexOf('"', p + 1); const s = src.slice(p + 1, e); p = e + 1; return s; }
      let m = /^\d*\.?\d+(?:[eE][-+]?\d+)?/.exec(src.slice(p));
      if (m && !/^[A-Z]/.test(src.slice(p))) { p += m[0].length; return Number(m[0]); }
      m = /^([A-Z][A-Z0-9.]*)\(/.exec(src.slice(p));
      if (m) {
        p += m[0].length;
        const a = args();
        const flat = a.flat().filter((v) => typeof v === 'number') as number[];
        switch (m[1]) {
          case 'SUM': return flat.reduce((s, v) => s + v, 0);
          case 'MAX': return Math.max(...flat);
          case 'AVERAGE': return flat.reduce((s, v) => s + v, 0) / flat.length;
          case 'MROUND': return Math.round(flat[0] / flat[1]) * flat[1];
          case 'IF': return num(a[0][0]) ? a[1][0] : a[2][0];
          default: throw new Error(`unsupported function ${m[1]}`);
        }
      }
      m = /^\$?([A-Z]{1,2})\$?(\d+)/.exec(src.slice(p));
      if (m) { p += m[0].length; return cellValue(`${m[1]}${m[2]}`); }
      throw new Error(`cannot parse '${src.slice(p)}' in =${src}`);
    }
    const v = expr();
    ws();
    if (p < src.length) throw new Error(`trailing '${src.slice(p)}' in =${src}`);
    return v;
  }
  return {cellValue, cells};
}
