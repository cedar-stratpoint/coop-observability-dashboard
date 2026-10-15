// LOCAL ONLY: the SCAN attacks of the Train 3 suite (test/support/direct-read-attacks.mjs) through the real driver path (client.ts) as
// coop_explore_ro, validator bypassed. Skipped without the local env:
//   scripts/local-supabase/up.sh --reapply --explore
//   set -a; . scripts/local-supabase/.local-env; set +a; npx vitest run test/chat-explore-scan.integration.test.ts
// Two halves per row: (1) the raw rows the login really gets (no scanner) equal the row's `scan.raw` model, so the planted secret
// really reaches the scanner and the no-database test (chat-explore-attacks.test.ts) runs on true data; (2) what leaves client.ts
// has the secret hidden. The accepted limits and the controls are pinned the same way.
import postgres from 'postgres';
import {afterAll, describe, expect, it, vi} from 'vitest';
vi.mock('server-only', () => ({}));
import {createRunQuery} from '../src/chat/explore/client';
import {ExploreDbError} from '../src/chat/explore/errors';
import {DEFAULT_EXPLORE_LIMITS} from '../src/chat/explore/limits';
import {CURSOR_NAME, wrapCursor} from '../src/chat/explore/parse';
import {HIDDEN} from '../src/chat/explore/scrub';
import {DIRECT_READ_ATTACKS, DIRECT_READ_CONTROLS, DIRECT_READ_RESIDUALS, type DirectReadAttack} from './support/direct-read-attacks.mjs';
import {assertLocalPostgres} from './support/local-only';

const url = process.env.EXPLORE_DATABASE_URL;
if (url) assertLocalPostgres(url); // a set but non-local URL fails the file loudly instead of skipping
const OPTS = {timeoutMs: 5000, maxRows: 50};

/** Every key and leaf of a cell as text, without recursion (A66 holds a 10,000-deep array). */
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
const rowsText = (rows: unknown[][]): string[] => rows.map((r) => r.map(cellText).join(' | '));

describe.skipIf(!url)('2.9 SCAN attacks: secret-shaped values never leave client.ts (local database)', () => {
  const run = url ? createRunQuery({enabled: true, databaseUrl: url, limits: DEFAULT_EXPLORE_LIMITS}) : (undefined as never);
  const raw = url ? postgres(url, {max: 1, prepare: false, idle_timeout: 2, connect_timeout: 5, onnotice: () => {}}) : (undefined as never);
  afterAll(async () => {
    await raw?.end({timeout: 1});
  });

  /** The same envelope as client.ts, minus the scanner: what the login really reads. */
  async function rawRows(sql: string): Promise<unknown[][]> {
    let out: unknown[][] = [];
    await raw
      .begin('read only', async (tx) => {
        await tx.unsafe("SET LOCAL statement_timeout = 5000; SET LOCAL timezone = 'Asia/Manila'; SET LOCAL search_path = public, pg_temp");
        await tx.unsafe(wrapCursor(sql), [], {simple: false} as never);
        out = (await tx.unsafe(`FETCH FORWARD 51 FROM ${CURSOR_NAME}`, [], {simple: false} as never).values()) as unknown[][];
        throw new Error('rollback');
      })
      .catch((e: Error) => {
        if (e.message !== 'rollback') throw e;
      });
    return out;
  }

  it.each(DIRECT_READ_ATTACKS.filter((x) => x.db === 'SCAN'))('$id $category: the planted value reaches the scanner and is hidden', async (x: DirectReadAttack) => {
    assertLocalPostgres(url);
    const scan = x.scan!;
    // only a row that allows it may be refused, and then nothing at all comes back (A66: jsonb too deep for the driver or the engine)
    let rows: unknown[][] | null = null;
    try {
      rows = await rawRows(x.sql);
    } catch (e) {
      expect(scan.mayError, `${x.id}: ${String(e)}`).toBe(true);
    }
    if (rows !== null) expect(rowsText(rows), `${x.id}: the row model is what the database returns`).toEqual(rowsText(scan.raw));
    let got: Awaited<ReturnType<typeof run>>;
    try {
      got = await run(wrapCursor(x.sql), OPTS);
    } catch (e) {
      expect(scan.mayError, `${x.id}: ${String(e)}`).toBe(true);
      expect(e, x.id).toBeInstanceOf(ExploreDbError);
      return;
    }
    const text = rowsText(got.rows).join('\n');
    for (const s of scan.secrets ?? []) expect(text, `${x.id}: ${s} must be hidden`).not.toContain(s);
    if ((scan.secrets ?? []).length > 0) {
      expect(text, x.id).toContain(HIDDEN);
      expect(got.hidden, x.id).toBeGreaterThan(0);
    }
    for (const v of scan.visible ?? []) expect(text, `${x.id}: ${v} still reads`).toContain(v);
    if (scan.maxMs !== undefined) expect(got.ms, `${x.id}: ${got.ms} ms`).toBeLessThan(scan.maxMs);
  });

  it.each([...DIRECT_READ_RESIDUALS, ...DIRECT_READ_CONTROLS])('$id $category: pinned as documented', async (x: DirectReadAttack) => {
    assertLocalPostgres(url);
    expect(await rawRows(x.sql), x.id).toEqual(x.scan!.raw);
    expect((await run(wrapCursor(x.sql), OPTS)).rows, x.id).toEqual(x.scan!.scrubbed);
  });
});
