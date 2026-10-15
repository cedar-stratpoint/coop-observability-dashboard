// The Train 3 attack suite (spec 2.9), the part that needs no database: the SQL guard on every row, and the value scanner on the rows
// a SCAN attack makes the database return (`scan.raw`, pinned against the real database by chat-explore-scan.integration.test.ts).
// The database half (MUST rows) is step (k) of scripts/coop-explore-ro-proof.mjs.
import {describe, expect, it} from 'vitest';
import {validateExploreSql} from '../src/chat/explore/parse';
import {HIDDEN, scrubRows, scrubValue} from '../src/chat/explore/scrub';
import {DIRECT_READ_ATTACKS, DIRECT_READ_CONTROLS, DIRECT_READ_RESIDUALS, type DirectReadAttack} from './support/direct-read-attacks.mjs';

/** Every key and leaf of a cell as text, without recursion (A66 holds a 10,000-deep array: JSON.stringify would overflow the stack). */
function cellText(c: unknown): string {
  const out: string[] = [];
  const stack: unknown[] = [c];
  while (stack.length > 0) {
    const v = stack.pop();
    if (v !== null && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        if (!Array.isArray(v)) out.push(k);
        stack.push(x);
      }
    } else out.push(String(v));
  }
  return out.join(' ');
}
const rowsText = (rows: unknown[][]): string[] => rows.flat().map(cellText);
const SCAN = DIRECT_READ_ATTACKS.filter((x) => x.db === 'SCAN');

describe('2.9 Train 3 attack suite: 25+ cases, 100% blocked', () => {
  it('has 25+ attacks with unique ids, each blocked by at least one layer', () => {
    expect(DIRECT_READ_ATTACKS.length).toBeGreaterThanOrEqual(25);
    const ids = [...DIRECT_READ_ATTACKS, ...DIRECT_READ_RESIDUALS, ...DIRECT_READ_CONTROLS].map((x) => x.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const x of DIRECT_READ_ATTACKS) {
      expect(['MUST', 'PARSER', 'SCAN'], x.id).toContain(x.db);
      expect(x.parser !== 'ok' || x.db === 'MUST' || x.db === 'SCAN', x.id).toBe(true);
      if (x.db === 'SCAN') expect(x.scan?.raw, x.id).toBeDefined();
    }
  });

  it.each(DIRECT_READ_ATTACKS)('$id $category: the guard returns $parser', async (x) => {
    const r = await validateExploreSql(x.sql);
    if (x.parser === 'ok') expect(r.ok, x.id).toBe(true);
    else expect(r, x.id).toMatchObject({ok: false, code: x.parser});
  });

  it.each(SCAN)('$id $category: the scanner hides what the database returns', (x: DirectReadAttack) => {
    const scan = x.scan!;
    const before = rowsText(scan.raw).join('\n');
    for (const s of scan.secrets ?? []) expect(before, `${x.id}: the planted ${s} is really in the raw rows`).toContain(s);
    const t0 = performance.now();
    const out = scrubRows(scan.raw);
    const ms = performance.now() - t0;
    const after = rowsText(out.rows).join('\n');
    for (const s of scan.secrets ?? []) expect(after, `${x.id}: ${s} must be hidden`).not.toContain(s);
    if ((scan.secrets ?? []).length > 0) {
      expect(after, x.id).toContain(HIDDEN);
      expect(out.hidden, x.id).toBeGreaterThan(0);
    }
    for (const v of scan.visible ?? []) expect(after, `${x.id}: ${v} still reads`).toContain(v);
    if (scan.maxMs !== undefined) expect(ms, `${x.id}: scanned in ${ms.toFixed(0)} ms (no event-loop stall)`).toBeLessThan(500);
  });
});

describe('2.9 accepted limits (NOT blocked, documented in chat-direct-read-access.md section 7): pinned as they are', () => {
  it.each(DIRECT_READ_RESIDUALS)('$id $category: passes the guard, and the scanner keeps the pieces readable (accepted-limit)', async (x) => {
    expect((await validateExploreSql(x.sql)).ok, x.id).toBe(true);
    const scan = x.scan!;
    expect(scrubRows(scan.raw).rows, `${x.id}: accepted-limit, the pieces read`).toEqual(scan.scrubbed);
    // the same value whole IS hidden: only the deliberate cut or rewrite escapes the scanner
    expect(cellText(scrubValue(scan.whole).value), x.id).toContain(HIDDEN);
  });
});

describe('2.9 controls: the accepted over-hiding, and keys that must stay readable', () => {
  it.each(DIRECT_READ_CONTROLS)('$id $category', async (x) => {
    expect((await validateExploreSql(x.sql)).ok, x.id).toBe(true);
    expect(scrubRows(x.scan!.raw).rows, x.id).toEqual(x.scan!.scrubbed);
  });
});
